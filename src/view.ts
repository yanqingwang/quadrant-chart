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
import { Chart, Cell, createChart, LIMITS, DEFAULTS } from './model';
import { readChart, writeChart } from './mdx';
import { ChartCanvas } from './canvas';
import { diag } from './diag';
import { PALETTE, promptColor, sameColor } from './colorUi';
import { findCell } from './geometry';

export const VIEW_TYPE_QUADRANT = 'quadrant-chart-view';

export class QuadrantChartView extends FileView {
  private canvas: ChartCanvas | null = null;
  private chart: Chart = createChart();
  private stopResize: (() => void) | null = null;
  /**
   * Serialises writes to the underlying file.
   *
   * Without it, two commits issued in quick succession (add a label, then immediately add
   * another) can overlap, and the second can be written from a chart snapshot that never saw the
   * first edit. That is a lost update, and it is invisible until the user closes the file and finds
   * a label missing.
   */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: QuadrantChartPlugin) {
    // `super(leaf)` is the idiomatic form and what the plugin factory uses. Obsidian's real
    // ItemView takes (leaf, app) and exposes it as `this.app`; the shipped type declarations list
    // only `leaf`, so the app is not forwarded here. Tests assign it directly rather than
    // distorting this call to suit a stub.
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

  /**
   * View state, so Obsidian can restore the binding after a workspace reload or app restart.
   *
   * Without this the inherited stub stores nothing, and reopening the view loses which file it was
   * showing — the view then has no file to read or write.
   */
  getState(): Record<string, unknown> {
    return { file: this.file?.path ?? null };
  }

  // setState is deliberately NOT overridden. FileView's own implementation is what assigns
  // `this.file` from the state above; reimplementing it would mean duplicating the framework's
  // file-binding machinery (and there is no public loadFile to delegate to). The pairing that
  // matters — getState here, onLoadFile below — is what makes the binding survive a reload.

  async onOpen(): Promise<void> {
    await diag(this.app, 'onOpen (file not yet assigned by Obsidian)');
    // Chrome only. `this.file` is still null at this point — Obsidian assigns it afterwards and
    // then calls onLoadFile. Loading the chart here silently did nothing, which left the canvas
    // showing a default chart and made every write a no-op.
    this.buildChrome();
    this.stopResize = this.canvas?.observeResize() ?? null;
  }

  /**
   * The file has been assigned. This is the first moment `this.file` is valid, so it is where the
   * chart must be read from disk.
   */
  async onLoadFile(file: TFile): Promise<void> {
    await diag(this.app, `onLoadFile ${file.path}`);
    await this.reload();
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    // Let any in-flight write finish before the file reference goes away, otherwise a save started
    // just before a tab switch could resolve against a detached file.
    await this.writeChain;
  }

  async onClose(): Promise<void> {
    this.stopResize?.();
    this.stopResize = null;
    this.canvas?.destroy();
    this.canvas = null;
    this.contentEl.empty();
  }

  /** Re-read the file. Called when the file is assigned and whenever it changes underneath us. */
  async reload(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const loaded = await readChart(this.app, file);
    await diag(this.app, `reload ${file.path} parsed=${loaded ? 'yes' : 'NO (not a chart)'} items=${loaded?.items.length ?? '-'}`);
    if (!loaded) {
      // Surface it in the canvas area rather than emptying the view, so the toolbar and the reason
      // are both visible.
      this.showMessage('This .mdx file has no quadrant-chart frontmatter. Run "Create quadrant chart" '
        + 'or add a `quadrant-chart: 1` key to its frontmatter.');
      return;
    }
    this.chart = loaded;
    this.canvas?.setChart(loaded);
    this.renderToolbar();
  }

  /** Show a message inside the view without destroying the toolbar. */
  private showMessage(text: string): void {
    const existing = this.contentEl.querySelector('.qc-message');
    if (existing) existing.remove();
    this.contentEl.createDiv({ cls: 'qc-message', text });
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
      // Repaint the toolbar so the Cell button names the cell the user just clicked. Without this
      // the button would keep saying "the middle one" while the highlight was somewhere else.
      onSelectCell: () => this.renderToolbar(),
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

    this.button(bar, 'Add label', 'plus', 'Add a free-floating text label', () => void this.canvas?.addItem());
    // The current size is part of the button text, not a separate badge: "Grid" alone gave no hint
    // that the size was adjustable or what it currently was.
    this.button(bar, `Grid ${this.chart.grid.columns}×${this.chart.grid.rows}`, 'layout-grid',
      'Change how many columns and rows the plot is divided into', (e) => this.pickGrid(e));
    this.button(bar, 'Cell', 'square', 'Name and colour the cell in the middle of the plot', (e) => this.pickCell(e));
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

  /**
   * Grid size picker.
   *
   * Split into labelled sections rather than a flat list of "3 × 2" strings. The flat version was
   * technically able to set any size but was unreadable: nothing said which number was columns and
   * which was rows, so it read as though only the square options were real. Sections name the axis
   * each number belongs to, and a checked box shows the current value.
   *
   * Beyond 8 the cells become too small to hold a label, so the menu stops there; the model's own
   * limit (LIMITS.maxSplits) is higher and still applies to hand-edited files.
   */
  private pickGrid(e: MouseEvent): void {
    const menu = new Menu();

    // Checked state is read once, when the menu is built — it is only a snapshot for display.
    // The click handlers deliberately re-read `this.chart.grid` instead of closing over the value
    // captured here: a menu can stay open across two clicks (and Obsidian's own behaviour here has
    // varied), and a closure would then apply the second choice against a stale size, silently undoing
    // the first. Reading at click time makes each pick independent of the others.
    const checkedColumns = this.chart.grid.columns;
    const checkedRows = this.chart.grid.rows;

    for (let n = 1; n <= 8; n += 1) {
      menu.addItem((it) => it
        .setSection('Columns (split the horizontal axis)')
        .setTitle(`${n} column${n === 1 ? '' : 's'}`)
        .setChecked(checkedColumns === n)
        .onClick(() => this.canvas?.setGrid(n, this.chart.grid.rows)));
    }
    for (let n = 1; n <= 8; n += 1) {
      menu.addItem((it) => it
        .setSection('Rows (split the vertical axis)')
        .setTitle(`${n} row${n === 1 ? '' : 's'}`)
        .setChecked(checkedRows === n)
        .onClick(() => this.canvas?.setGrid(this.chart.grid.columns, n)));
    }
    menu.addItem((it) => it
      .setSection('Presets')
      .setTitle('2 × 2 (classic quadrants)')
      .setChecked(checkedColumns === 2 && checkedRows === 2)
      .onClick(() => this.canvas?.setGrid(2, 2)));
    menu.addItem((it) => it
      .setSection('Presets')
      .setTitle('3 × 3')
      .setChecked(checkedColumns === 3 && checkedRows === 3)
      .onClick(() => this.canvas?.setGrid(3, 3)));
    menu.addItem((it) => it
      .setSection('Presets')
      .setTitle('4 × 4')
      .setChecked(checkedColumns === 4 && checkedRows === 4)
      .onClick(() => this.canvas?.setGrid(4, 4)));
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

  /**
   * Cell actions: name it, colour it, or both.
   *
   * Acts on the cell the user CLICKED on the canvas, falling back to the middle of the grid when
   * nothing is selected. Previously the target was hard-coded to the middle, so naming any other
   * cell meant editing the frontmatter by hand — the click-to-select step is what makes "select a
   * cell, then name it" work.
   */
  private pickCell(e: MouseEvent): void {
    const { col, row } = this.canvas?.effectiveCell() ?? {
      col: Math.floor(this.chart.grid.columns / 2),
      row: Math.floor(this.chart.grid.rows / 2),
    };
    const existing = findCell(this.chart, col, row);
    const menu = new Menu();
    const where = `cell ${col + 1},${row + 1}`;

    menu.addItem((it) => it
      .setSection(`Cell ${col + 1},${row + 1}`)
      .setTitle(existing?.label ? `Rename "${existing.label}"…` : 'Set name…')
      .onClick(() => void this.canvas?.editCell(col, row)));

    menu.addItem((it) => it
      .setSection(`Cell ${col + 1},${row + 1}`)
      .setTitle('Set note…')
      .onClick(() => void this.editCellNote(col, row)));

    for (const sw of PALETTE) {
      menu.addItem((it) => it
        .setSection('Background colour')
        .setTitle(sw.name)
        .setChecked(sameColor(existing?.color, sw.hex))
        .onClick(() => this.setCellColor(col, row, sw.hex)));
    }
    menu.addItem((it) => it
      .setSection('Background colour')
      .setTitle('Custom colour…')
      .onClick(() => void this.pickCustomCellColor(col, row)));
    if (existing?.color) {
      menu.addItem((it) => it
        .setSection('Background colour')
        .setTitle('Remove colour')
        .onClick(() => this.setCellColor(col, row, null)));
    }
    menu.showAtMouseEvent(e);
    void where;
  }

  /** Apply (or clear) a cell's background. `hex === null` removes the tint only. */
  private setCellColor(col: number, row: number, hex: string | null): void {
    const others = this.chart.cells.filter((c) => !(c.col === col && c.row === row));
    const existing = findCell(this.chart, col, row);
    // Dropping the whole record on "remove colour" would take the cell's name and note with it —
    // clearing a tint should not delete what the user wrote. The record itself goes only if clearing
    // the tint leaves nothing behind.
    const kept: Cell = { col, row, label: existing?.label, note: existing?.note, color: hex ?? undefined };
    const cells = hex === null && !existing?.label && !existing?.note
      ? others
      : [...others, kept];
    this.chart = { ...this.chart, cells };
    this.canvas?.setChart(this.chart);
    this.renderToolbar();
    void this.commit(this.chart);
  }

  private async pickCustomCellColor(col: number, row: number): Promise<void> {
    const existing = findCell(this.chart, col, row);
    const picked = await promptColor(this.app, `Background colour — cell ${col + 1},${row + 1}`, existing?.color ?? null);
    if (picked === null) return;                       // cancelled
    this.setCellColor(col, row, picked === '' ? null : picked);
  }

  private async editCellNote(col: number, row: number): Promise<void> {
    const existing = findCell(this.chart, col, row);
    const note = await this.plugin.promptText(existing?.note ?? '', `Note for cell ${col + 1},${row + 1}`);
    if (note === null) return;
    const others = this.chart.cells.filter((c) => !(c.col === col && c.row === row));
    const t = note.trim();
    const cells = t
      ? [...others, { col, row, note: t, label: existing?.label, color: existing?.color }]
      : others;
    this.chart = { ...this.chart, cells };
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

  /**
   * Persist the chart. Every mutation funnels through here so writes are never lost.
   *
   * Writes are serialised through a promise chain. Two commits that overlap would otherwise race in
   * the write itself, and the slower one can land last with a chart that never saw the faster
   * one's edit — the classic lost-update. Serialising makes each write observe the previous one.
   */
  private async commit(chart: Chart): Promise<void> {
    const file = this.file;
    // Logged FIRST, before any branch. "The save path was never entered" and "it was entered but had
    // no file" must be distinguishable, and an earlier version logged only after the null check — so
    // the most likely failure produced no log at all, which is indistinguishable from a silent no-op.
    await diag(this.app, `commit ENTERED items=${chart.items.length} file=${file ? file.path : 'NULL'}`);
    if (!file) {
      console.error('[quadrant-chart] refusing to save: the view has no file bound');
      this.showMessage('Not saving: this view is not bound to a file. Reopen the .mdx file from the vault.');
      return;
    }
    this.chart = chart;
    this.writeChain = this.writeChain.then(async () => {
      try {
        await writeChart(this.app, file, chart);
        await diag(this.app, `commit DONE items=${chart.items.length}`);
      } catch (err) {
        await diag(this.app, `commit FAILED ${(err as Error).message}`);
        new Notice(`Could not save the chart: ${(err as Error).message}`);
      }
    });
    await this.writeChain;
  }

  /**
   * Called when the underlying file changes.
   *
   * Whether the change came from us or from the user is decided by COMPARING the file to what we
   * already hold, never by a flag cleared on a timer. The `modify` event for our own write lands at
   * an unpredictable moment relative to the write's own promise resolution, so any timing-based
   * suppression is a race that eventually drops an edit. A comparison cannot race: if the file
   * already matches, there is nothing to do.
   */
  async onExternalChange(): Promise<void> {
    if (!this.file) return;
    // Wait for our own in-flight writes first, or the comparison below could observe an
    // intermediate state and undo it on the next reload.
    await this.writeChain;
    const loaded = await readChart(this.app, this.file);
    if (!loaded) return;
    if (chartsEqual(loaded, this.chart)) return; // our own write coming back around
    this.chart = loaded;
    this.canvas?.setChart(loaded);
    this.renderToolbar();
  }
}

/** Structural equality for two charts, used to decide whether a reload has anything to apply. */
function chartsEqual(a: Chart, b: Chart): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Stable key order, so two structurally identical charts serialise identically. */
function canonical(c: Chart): unknown {
  return {
    title: c.title ?? null,
    baseFontSize: c.baseFontSize ?? null,
    x: { label: c.x.label, min: c.x.min, max: c.x.max, ticks: c.x.ticks ?? null },
    y: { label: c.y.label, min: c.y.min, max: c.y.max, ticks: c.y.ticks ?? null },
    grid: { columns: c.grid.columns, rows: c.grid.rows },
    cells: [...c.cells].sort((p, q) => p.col - q.col || p.row - q.row)
      .map((x) => ({ col: x.col, row: x.row, label: x.label ?? null, color: x.color ?? null, note: x.note ?? null })),
    items: [...c.items].map((i) => ({ id: i.id, text: i.text, x: i.x, y: i.y, color: i.color ?? null, size: i.size ?? null })),
  };
}

export { DEFAULTS };
