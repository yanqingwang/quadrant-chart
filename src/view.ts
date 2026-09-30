/**
 * The `.mdx` view: a toolbar over the canvas.
 *
 * Obsidian needs a `FileView` for a custom extension, and it recreates the view whenever the file is
 * reopened, so the view is responsible for loading the chart itself rather than expecting one to be
 * handed in. It also re-reads on external change: a `.mdx` file is ordinary text, so the user (or
 * git, or another device) can edit it behind the plugin's back, and a stale canvas would then be
 * showing numbers the file no longer contains.
 */

import { FileView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import QuadrantChartPlugin from './main';
import { Chart, createChart, LIMITS, DEFAULTS } from './model';
import { readChart, writeChart } from './mdx';
import { ChartCanvas } from './canvas';

export const VIEW_TYPE_QUADRANT = 'quadrant-chart-view';

export class QuadrantChartView extends FileView {
  private canvas: ChartCanvas | null = null;
  private chart: Chart = createChart();
  private stopResize: (() => void) | null = null;
  /** Suppresses the reload triggered by our own writes. */
  private selfWrite = false;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: QuadrantChartPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_QUADRANT;
  }

  getDisplayText(): string {
    return this.file?.basename ?? 'Quadrant chart';
  }

  getIcon(): string {
    return 'layout-grid';
  }

  async onOpen(): Promise<void> {
    this.buildChrome();
    this.stopResize = this.canvas?.observeResize() ?? null;
    await this.reload();
  }

  async onClose(): Promise<void> {
    this.stopResize?.();
    this.stopResize = null;
    this.canvas?.destroy();
    this.canvas = null;
    this.contentEl.empty();
  }

  /** Re-read the file. Called on open and whenever the file changes underneath us. */
  async reload(): Promise<void> {
    if (!this.file) return;
    const loaded = await readChart(this.app, this.file);
    if (!loaded) {
      this.contentEl.empty();
      this.contentEl.createEl('p', { text: 'This .mdx file has no quadrant-chart frontmatter.' });
      return;
    }
    this.chart = loaded;
    this.canvas?.setChart(loaded);
    this.renderToolbar();
  }

  // ── chrome ────────────────────────────────────────────────────────────────

  private buildChrome(): void {
    this.contentEl.empty();
    this.contentEl.addClass('qc-root');

    const toolbar = this.contentEl.createDiv({ cls: 'qc-toolbar' });
    this.toolbarEl = toolbar;

    const stage = this.contentEl.createDiv({ cls: 'qc-stage' });
    this.canvas = new ChartCanvas(this.app, stage, this.chart, {
      file: this.file as TFile,
      onChange: (chart) => void this.commit(chart),
      promptText: (def, title) => this.plugin.promptText(def, title),
    });
  }

  private toolbarEl: HTMLElement | null = null;

  /**
   * Rebuild the toolbar's state-dependent parts.
   *
   * Only the labels that can go stale are rewritten (grid size, axis names). The button set itself
   * is fixed, so it is created once — recreating buttons on every change would drop focus and make
   * the toolbar feel like it flickers.
   */
  private renderToolbar(): void {
    const bar = this.toolbarEl;
    if (!bar) return;
    bar.empty();

    bar.createEl('span', { text: `${this.chart.grid.columns}×${this.chart.grid.rows}`, cls: 'qc-badge' });

    this.button(bar, 'Add label', 'plus', 'Add a free-floating text label', () => void this.canvas?.addItem());
    this.button(bar, 'Grid', 'layout-grid', 'Change the number of columns and rows', (e) => this.pickGrid(e));
    this.button(bar, 'Cell', 'square', 'Name the cell under the cursor', () => void this.nameCellAtCentre());
    this.button(bar, 'Axes', 'axis', 'Rename the axes and set their ranges', (e) => this.pickAxes(e));
    this.button(bar, 'Title', 'type', 'Set the chart title', () => void this.promptTitle());
  }

  private button(parent: HTMLElement, label: string, icon: string, title: string, onClick: (e: MouseEvent) => void): void {
    const b = parent.createEl('button', { cls: 'qc-btn' });
    const i = b.createSpan({ cls: 'qc-btn-icon' });
    setIcon(i, icon);
    i.setAttribute('aria-hidden', 'true');
    b.createSpan({ text: label, cls: 'qc-btn-label' });
    b.setAttribute('title', title);
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
  }

  // ── toolbar actions ───────────────────────────────────────────────────────

  private pickGrid(e: MouseEvent): void {
    const menu = new Menu();
    const build = (rows: number, cols: number) => {
      menu.addItem((it) => it
        .setTitle(`${cols} × ${rows}`)
        .setChecked(this.chart.grid.columns === cols && this.chart.grid.rows === rows)
        .onClick(() => this.canvas?.setGrid(cols, rows)));
    };
    for (const n of [1, 2, 3, 4]) {
      build(n, n);
    }
    for (const n of [2, 3, 4]) {
      menu.addSeparator();
      for (const m of [2, 3, 4]) build(n, m);
    }
    menu.showAtMouseEvent(e);
  }

  private async pickAxes(e: MouseEvent): Promise<void> {
    const menu = new Menu();
    menu.addItem((it) => it.setTitle('Rename X axis…').onClick(() => void this.renameAxis('x')));
    menu.addItem((it) => it.setTitle('Rename Y axis…').onClick(() => void this.renameAxis('y')));
    menu.addSeparator();
    menu.addItem((it) => it.setTitle('Set X range…').onClick(() => void this.setRange('x')));
    menu.addItem((it) => it.setTitle('Set Y range…').onClick(() => void this.setRange('y')));
    menu.addSeparator();
    menu.addItem((it) => it.setTitle('Reset to defaults').onClick(() => this.resetChart()));
    menu.showAtMouseEvent(e);
  }

  private async renameAxis(which: 'x' | 'y'): Promise<void> {
    const label = await this.plugin.promptText(this.chart[which].label, `Rename ${which.toUpperCase()} axis`);
    if (label === null) return;
    const t = label.trim();
    if (!t) return;
    this.canvas?.setAxis(which, { label: t });
    this.renderToolbar();
  }

  private async setRange(which: 'x' | 'y'): Promise<void> {
    const axis = this.chart[which];
    const raw = await this.plugin.promptText(
      `${axis.min}, ${axis.max}`,
      `${which.toUpperCase()} range (min, max)`,
    );
    if (raw === null) return;
    const parts = raw.split(/[,\s]+/).filter(Boolean).map(Number);
    if (parts.length !== 2 || !parts.every((n) => Number.isFinite(n))) {
      new Notice('Enter two numbers, e.g. "0, 10".');
      return;
    }
    let [min, max] = parts;
    if (min > max) [min, max] = [max, min];
    if (max - min < LIMITS.minSpan) {
      new Notice('The range must be larger than zero.');
      return;
    }
    this.canvas?.setAxis(which, { min, max });
    this.renderToolbar();
  }

  private async promptTitle(): Promise<void> {
    const title = await this.plugin.promptText(this.chart.title ?? '', 'Chart title');
    if (title === null) return;
    this.chart = { ...this.chart, title: title.trim() || undefined };
    this.canvas?.setChart(this.chart);
    this.renderToolbar();
    await this.commit(this.chart);
  }

  private async nameCellAtCentre(): Promise<void> {
    // Naming a cell needs a cell, not a point; the centre is the least surprising default when the
    // user has not clicked anywhere specific, and they can re-run it for any other cell.
    const col = Math.floor(this.chart.grid.columns / 2);
    const row = Math.floor(this.chart.grid.rows / 2);
    await this.canvas?.editCell(col, row);
  }

  private resetChart(): void {
    const fresh = createChart(this.plugin.settings.defaultColumns, this.plugin.settings.defaultRows);
    this.chart = { ...fresh, title: this.chart.title };
    this.canvas?.setChart(this.chart);
    this.renderToolbar();
    void this.commit(this.chart);
  }

  // ── persistence ───────────────────────────────────────────────────────────

  /** Persist the chart. Every mutation funnels through here so writes are never lost. */
  private async commit(chart: Chart): Promise<void> {
    if (!this.file) return;
    this.chart = chart;
    this.selfWrite = true;
    try {
      await writeChart(this.app, this.file, chart);
    } catch (err) {
      new Notice(`Could not save the chart: ${(err as Error).message}`);
    } finally {
      // Cleared on the next tick: the vault's modify event for our own write fires synchronously
      // enough to be observed here, and clearing it any later would swallow a genuine external edit.
      window.setTimeout(() => { this.selfWrite = false; }, 0);
    }
  }

  /** Called by the plugin when the underlying file changes. */
  async onExternalChange(): Promise<void> {
    if (this.selfWrite) return;
    await this.reload();
  }
}

export { DEFAULTS };
