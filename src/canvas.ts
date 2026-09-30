/**
 * The chart canvas: SVG rendering plus pointer interaction.
 *
 * Built as a hand-rolled widget rather than a framework component, for one reason — every
 * interaction here is a continuous gesture (drag a label, drag a split line) that needs to own the
 * pointer from `pointerdown` to `pointerup` and to survive the pointer leaving the element. That
 * bookkeeping is the whole difficulty, and a framework would only add a layer over it.
 *
 * Rendering is a full redraw on change. That sounds wasteful and is not: a chart is tens of shapes,
 * and a diffing renderer would add state that can desynchronise from the model — the exact class of
 * bug where a label renders in a position the file no longer records.
 */

import { App, TFile } from 'obsidian';
import { Chart, Item, LIMITS, DEFAULTS, clampNum } from './model';
import {
  Margins, PlotRect, DEFAULT_MARGINS,
  axisTicks, cellRect, dataToScreenX, dataToScreenY, findCell, formatTick,
  screenToDataX, screenToDataY, splitPositions,
} from './geometry';

const SVG_NS = 'http://www.w3.org/2000/svg';

type DragMode =
  | { kind: 'none' }
  | { kind: 'item'; id: string; grabX: number; grabY: number }
  | { kind: 'split-x'; col: number }
  | { kind: 'split-y'; row: number };

export interface CanvasCallbacks {
  /** Persist a mutated chart. Called on every committed change, not on every pointer move. */
  onChange(chart: Chart): void;
  /** Ask the host to prompt for text (new label, rename, cell name). */
  promptText(defaultValue: string, title: string): Promise<string | null>;
  /** The file this canvas edits, for error surfaces. */
  file: TFile;
}

export class ChartCanvas {
  private svg: SVGSVGElement;
  private plot: PlotRect = { x: 0, y: 0, width: 1, height: 1 };
  private margins: Margins = { ...DEFAULT_MARGINS };
  private drag: DragMode = { kind: 'none' };
  /** Live position while dragging, so the model is not rewritten on every pointermove. */
  private draft: Chart | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    private readonly app: App,
    private container: HTMLElement,
    private chart: Chart,
    private readonly cb: CanvasCallbacks,
  ) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'qc-canvas');
    this.svg.addEventListener('pointerdown', this.onPointerDown);
    this.svg.addEventListener('pointermove', this.onPointerMove);
    this.svg.addEventListener('pointerup', this.onPointerUp);
    this.svg.addEventListener('pointercancel', this.onPointerUp);
    this.svg.addEventListener('dblclick', this.onDoubleClick);
    this.svg.addEventListener('click', this.onClick);
    this.svg.addEventListener('contextmenu', this.onContextMenu);
    this.container.appendChild(this.svg);
    this.measure();
  }

  /** Swap in a new model (after an external edit or undo) and redraw. */
  setChart(chart: Chart): void {
    this.chart = chart;
    this.draft = null;
    this.render();
  }

  getChart(): Chart {
    return this.draft ?? this.chart;
  }

  /** Re-read the container size. Called on mount and whenever the pane resizes. */
  measure(): void {
    const w = Math.max(240, this.container.clientWidth);
    const h = Math.max(200, this.container.clientHeight);
    this.svg.setAttribute('width', String(w));
    this.svg.setAttribute('height', String(h));
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.plot = {
      x: this.margins.left,
      y: this.margins.top,
      width: Math.max(1, w - this.margins.left - this.margins.right),
      height: Math.max(1, h - this.margins.top - this.margins.bottom),
    };
  }

  /** Start watching for pane resizes; the returned function stops watching. */
  observeResize(): () => void {
    if (typeof ResizeObserver === 'undefined') return () => undefined;
    this.resizeObserver = new ResizeObserver(() => {
      this.measure();
      this.render();
    });
    this.resizeObserver.observe(this.container);
    return () => this.resizeObserver?.disconnect();
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.svg.remove();
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  render(): void {
    const chart = this.getChart();
    const svg = this.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const rect = this.plot;

    this.drawCells(chart, rect);
    this.drawGrid(chart, rect);
    this.drawFrame(rect);
    this.drawAxes(chart, rect);
    for (const item of chart.items) this.drawItem(item, chart, rect);
  }

  private drawCells(chart: Chart, rect: PlotRect): void {
    for (let row = 0; row < chart.grid.rows; row += 1) {
      for (let col = 0; col < chart.grid.columns; col += 1) {
        const cell = findCell(chart, col, row);
        if (!cell || (!cell.color && !cell.label && !cell.note)) continue;
        const r = cellRect(chart, col, row, rect);
        if (cell.color) {
          svg(this.svg, 'rect', {
            x: r.x, y: r.y, width: r.width, height: r.height,
            fill: cell.color, 'fill-opacity': '0.18',
          });
        }
        if (!cell.label && !cell.note) continue;
        // Cell text is inset and wrapped: cell notes are prose, and prose that runs to the cell edge
        // is unreadable at any grid size.
        const text = svg(this.svg, 'foreignObject', {
          x: r.x + 6, y: r.y + 6,
          width: Math.max(1, r.width - 12), height: Math.max(1, r.height - 12),
          class: 'qc-cell-text',
        });
        const div = document.createElement('div');
        if (cell.label) {
          const strong = document.createElement('div');
          strong.className = 'qc-cell-label';
          strong.textContent = cell.label;
          div.appendChild(strong);
        }
        if (cell.note) {
          const p = document.createElement('div');
          p.className = 'qc-cell-note';
          p.textContent = cell.note;
          div.appendChild(p);
        }
        text.appendChild(div);
      }
    }
  }

  private drawGrid(chart: Chart, rect: PlotRect): void {
    const { xs, ys } = splitPositions(chart, rect);
    for (const x of xs) {
      svg(this.svg, 'line', { x1: x, y1: rect.y, x2: x, y2: rect.y + rect.height, class: 'qc-split' });
      // Invisible wide grab strip: a 1px split line is impossible to grab with a finger.
      const hit = svg(this.svg, 'rect', {
        x: x - 6, y: rect.y, width: 12, height: rect.height, class: 'qc-split-hit', cursor: 'ew-resize',
      });
      hit.dataset['splitX'] = String(xs.indexOf(x));
    }
    for (const y of ys) {
      svg(this.svg, 'line', { x1: rect.x, y1: y, x2: rect.x + rect.width, y2: y, class: 'qc-split' });
      const hit = svg(this.svg, 'rect', {
        x: rect.x, y: y - 6, width: rect.width, height: 12, class: 'qc-split-hit', cursor: 'ns-resize',
      });
      hit.dataset['splitY'] = String(ys.indexOf(y));
    }
  }

  private drawFrame(rect: PlotRect): void {
    svg(this.svg, 'rect', {
      x: rect.x, y: rect.y, width: rect.width, height: rect.height, class: 'qc-frame',
    });
  }

  private drawAxes(chart: Chart, rect: PlotRect): void {
    const { x, y } = chart;
    // Tick marks and values.
    for (const t of axisTicks(x)) {
      const px = dataToScreenX(t, x, rect);
      if (px < rect.x - 0.5 || px > rect.x + rect.width + 0.5) continue;
      svg(this.svg, 'line', { x1: px, y1: rect.y + rect.height, x2: px, y2: rect.y + rect.height + 5, class: 'qc-tick' });
      const label = svg(this.svg, 'text', {
        x: px, y: rect.y + rect.height + 20, class: 'qc-tick-label', 'text-anchor': 'middle',
      });
      label.textContent = formatTick(t);
    }
    for (const t of axisTicks(y)) {
      const py = dataToScreenY(t, y, rect);
      if (py < rect.y - 0.5 || py > rect.y + rect.height + 0.5) continue;
      svg(this.svg, 'line', { x1: rect.x - 5, y1: py, x2: rect.x, y2: py, class: 'qc-tick' });
      const label = svg(this.svg, 'text', {
        x: rect.x - 9, y: py + 4, class: 'qc-tick-label', 'text-anchor': 'end',
      });
      label.textContent = formatTick(t);
    }
    // Axis titles. X sits under the ticks, Y is rotated up the left gutter. Both are editable in
    // place: a single click opens the rename prompt, so an axis can be relabelled without going back
    // to the toolbar. `data-axis` is what the click handler reads to know which one was hit.
    if (x.label) {
      const t = svg(this.svg, 'text', {
        x: rect.x + rect.width / 2, y: rect.y + rect.height + 42,
        class: 'qc-axis-label qc-editable', 'text-anchor': 'middle', 'data-axis': 'x',
      });
      t.textContent = x.label;
    }
    if (y.label) {
      const t = svg(this.svg, 'text', {
        x: 16, y: rect.y + rect.height / 2, class: 'qc-axis-label qc-editable', 'text-anchor': 'middle',
        transform: `rotate(-90 16 ${rect.y + rect.height / 2})`, 'data-axis': 'y',
      });
      t.textContent = y.label;
    }
    if (chart.title) {
      const t = svg(this.svg, 'text', {
        x: rect.x, y: Math.max(14, rect.y - 10), class: 'qc-title qc-editable', 'data-axis': 'title',
      });
      t.textContent = chart.title;
    }
  }

  private drawItem(item: Item, chart: Chart, rect: PlotRect): void {
    const px = dataToScreenX(item.x, chart.x, rect);
    const py = dataToScreenY(item.y, chart.y, rect);
    const fontSize = clampNum(item.size ?? chart.baseFontSize ?? DEFAULTS.baseFontSize, LIMITS.minFontSize, LIMITS.maxFontSize, DEFAULTS.baseFontSize);
    const g = svg(this.svg, 'g', { class: 'qc-item', transform: `translate(${px} ${py})` });
    g.dataset['itemId'] = item.id;
    // A translucent plate behind the text keeps a label readable when it lands on a grid line or on
    // another label; the text is what is editable, so it is drawn on top.
    svg(g, 'rect', { x: -4, y: -fontSize, width: 8, height: fontSize + 8, class: 'qc-item-hit' });
    const text = svg(g, 'text', {
      x: 0, y: 0, class: 'qc-item-text', 'text-anchor': 'middle',
      'font-size': fontSize, fill: item.color ?? 'currentColor',
    });
    text.textContent = item.text;
  }

  // ── interaction ───────────────────────────────────────────────────────────

  private svgPoint(evt: PointerEvent): { x: number; y: number } {
    const box = this.svg.getBoundingClientRect();
    // The viewBox is 1:1 with width/height, so client deltas map straight to user units. Dividing by
    // the box keeps this correct if the pane is ever CSS-scaled.
    const scaleX = this.svg.viewBox.baseVal.width ? box.width / this.svg.viewBox.baseVal.width : 1;
    const scaleY = this.svg.viewBox.baseVal.height ? box.height / this.svg.viewBox.baseVal.height : 1;
    return { x: (evt.clientX - box.left) / (scaleX || 1), y: (evt.clientY - box.top) / (scaleY || 1) };
  }

  private onPointerDown = (evt: PointerEvent): void => {
    const target = evt.target as Element;
    const itemId = target.closest?.('.qc-item')?.getAttribute('data-item-id');
    if (itemId) {
      const p = this.svgPoint(evt);
      const item = this.getChart().items.find((i) => i.id === itemId);
      if (item) {
        this.drag = { kind: 'item', id: itemId, grabX: p.x - dataToScreenX(item.x, this.getChart().x, this.plot), grabY: p.y - dataToScreenY(item.y, this.getChart().y, this.plot) };
        this.svg.setPointerCapture(evt.pointerId);
        target.closest('.qc-item')?.classList.add('qc-dragging');
        evt.preventDefault();
        return;
      }
    }
    const splitX = target.getAttribute?.('data-split-x');
    const splitY = target.getAttribute?.('data-split-y');
    if (splitX !== null && splitX !== undefined) {
      this.drag = { kind: 'split-x', col: Number(splitX) };
      this.svg.setPointerCapture(evt.pointerId);
      evt.preventDefault();
      return;
    }
    if (splitY !== null && splitY !== undefined) {
      this.drag = { kind: 'split-y', row: Number(splitY) };
      this.svg.setPointerCapture(evt.pointerId);
      evt.preventDefault();
    }
  };

  private onPointerMove = (evt: PointerEvent): void => {
    if (this.drag.kind === 'none') return;
    const p = this.svgPoint(evt);
    if (this.drag.kind === 'item') {
      const chart = this.getChart();
      const id = this.drag.id;
      const nx = screenToDataX(p.x - this.drag.grabX, chart.x, this.plot);
      const ny = screenToDataY(p.y - this.drag.grabY, chart.y, this.plot);
      // Only the dragged label moves; the draft is discarded on pointerup if the gesture is a
      // click rather than a drag, so a stray pointermove never rewrites the file.
      this.draft = {
        ...chart,
        items: chart.items.map((i) => (i.id === id ? { ...i, x: round2(nx), y: round2(ny) } : i)),
      };
      this.render();
      return;
    }
    if (this.drag.kind === 'split-x') {
      const chart = this.getChart();
      const t = (p.x - this.plot.x) / (this.plot.width || 1);
      const frac = clampNum(t * chart.grid.columns, 1, chart.grid.columns - 1, 1);
      this.draft = { ...chart, grid: { ...chart.grid, columns: Math.round(frac) } };
      this.render();
      return;
    }
    if (this.drag.kind === 'split-y') {
      const chart = this.getChart();
      const t = (p.y - this.plot.y) / (this.plot.height || 1);
      const frac = clampNum((1 - t) * chart.grid.rows, 1, chart.grid.rows - 1, 1);
      this.draft = { ...chart, grid: { ...chart.grid, rows: Math.round(frac) } };
      this.render();
    }
  };

  private onPointerUp = (evt: PointerEvent): void => {
    if (this.drag.kind === 'none') return;
    this.svg.releasePointerCapture?.(evt.pointerId);
    this.svg.querySelectorAll('.qc-dragging').forEach((n) => n.classList.remove('qc-dragging'));
    const dragged = this.draft;
    this.draft = null;
    this.drag = { kind: 'none' };
    if (!dragged) return;
    // A press without movement is a click, not a drag. Committing it would rewrite the file with
    // identical numbers, dirtying the vault and marking the note modified for nothing.
    if (!this.hasMoved(dragged)) {
      this.render();
      return;
    }
    this.chart = dragged;
    this.render();
    this.cb.onChange(this.chart);
  };

  /** True when the pending draft actually differs from the saved chart. */
  private hasMoved(draft: Chart): boolean {
    if (draft.grid.columns !== this.chart.grid.columns) return true;
    if (draft.grid.rows !== this.chart.grid.rows) return true;
    return draft.items.some((i) => {
      const prev = this.chart.items.find((p) => p.id === i.id);
      return !prev || prev.x !== i.x || prev.y !== i.y;
    });
  }

  private onDoubleClick = (evt: MouseEvent): void => {
    const target = evt.target as Element;
    const id = target.closest?.('.qc-item')?.getAttribute('data-item-id');
    if (id) {
      const item = this.chart.items.find((i) => i.id === id);
      if (item) void this.renameItem(item);
      return;
    }
    // Double-clicking empty plot area creates a label at that spot: the fastest way to place text.
    const p = this.svgPoint(evt as unknown as PointerEvent);
    if (!inRect(p, this.plot)) return;
    const x = screenToDataX(p.x, this.chart.x, this.plot);
    const y = screenToDataY(p.y, this.chart.y, this.plot);
    void this.addItem(x, y);
  };

  /**
   * Single click on an axis label (or the title) renames it in place.
   *
   * A single click rather than a double click, unlike labels: the axis captions sit in empty gutter
   * space where nothing else can be hit, so there is no gesture to disambiguate from and no reason
   * to make the user wait. `stopPropagation` keeps the rename from also registering as a canvas
   * gesture, and a click that lands on a label or a split line is ignored here — those keep their
   * own drag semantics and must not be interrupted by a stray click.
   */
  private onClick = (evt: MouseEvent): void => {
    const target = evt.target as Element;
    if (target.closest?.('.qc-item') || target.closest?.('.qc-split-hit')) return;
    const axis = target.getAttribute?.('data-axis');
    if (axis !== 'x' && axis !== 'y' && axis !== 'title') return;
    evt.stopPropagation();
    if (axis === 'title') void this.renameTitle();
    else void this.renameAxis(axis);
  };

  private onContextMenu = (evt: MouseEvent): void => {
    const target = evt.target as Element;
    const id = target.closest?.('.qc-item')?.getAttribute('data-item-id');
    if (!id) return;
    evt.preventDefault();
    this.chart = { ...this.chart, items: this.chart.items.filter((i) => i.id !== id) };
    this.render();
    this.cb.onChange(this.chart);
  };

  // ── mutations exposed to the host (toolbar, commands) ─────────────────────

  async addItem(x?: number, y?: number): Promise<void> {
    const text = await this.cb.promptText('New label', 'Add label');
    if (text === null) return;
    const label = text.trim();
    if (!label) return;
    const chart = this.getChart();
    const item: Item = {
      id: nextId(),
      text: label,
      x: round2(x ?? (chart.x.min + chart.x.max) / 2),
      y: round2(y ?? (chart.y.min + chart.y.max) / 2),
    };
    this.chart = { ...chart, items: [...chart.items, item] };
    this.render();
    this.cb.onChange(this.chart);
  }

  /** Rename the X or Y axis, in place. An emptied label falls back to the default axis name. */
  async renameAxis(which: 'x' | 'y'): Promise<void> {
    const current = this.getChart()[which].label;
    const text = await this.cb.promptText(current, `Rename ${which.toUpperCase()} axis`);
    if (text === null) return; // cancelled — leave everything as it was
    const t = text.trim();
    if (t === current) return; // unchanged — do not dirty the file for nothing
    this.chart = { ...this.chart, [which]: { ...this.chart[which], label: t || `X axis` } };
    this.render();
    this.cb.onChange(this.chart);
  }

  /** Rename the chart title. An emptied title removes it, which the view already handles. */
  async renameTitle(): Promise<void> {
    const text = await this.cb.promptText(this.getChart().title ?? '', 'Chart title');
    if (text === null) return;
    const t = text.trim();
    if (t === (this.chart.title ?? '')) return;
    this.chart = { ...this.chart, title: t || undefined };
    this.render();
    this.cb.onChange(this.chart);
  }

  async renameItem(item: Item): Promise<void> {
    const text = await this.cb.promptText(item.text, 'Edit label');
    if (text === null) return;
    const label = text.trim();
    const chart = this.chart;
    // An emptied label is a delete: leaving a blank node on the canvas would be a trap, since the
    // only way to remove it is the context menu.
    if (!label) {
      this.chart = { ...chart, items: chart.items.filter((i) => i.id !== item.id) };
    } else {
      this.chart = { ...chart, items: chart.items.map((i) => (i.id === item.id ? { ...i, text: label } : i)) };
    }
    this.render();
    this.cb.onChange(this.chart);
  }

  async editCell(col: number, row: number): Promise<void> {
    const existing = findCell(this.chart, col, row);
    const text = await this.cb.promptText(existing?.label ?? '', `Name cell (${col + 1}, ${row + 1})`);
    if (text === null) return;
    const label = text.trim();
    const others = this.chart.cells.filter((c) => !(c.col === col && c.row === row));
    const cells = label
      ? [...others, { col, row, label, color: existing?.color, note: existing?.note }]
      : others;
    this.chart = { ...this.chart, cells };
    this.render();
    this.cb.onChange(this.chart);
  }

  setGrid(columns: number, rows: number): void {
    const chart = this.chart;
    // Cells outside the new grid would render nowhere; drop them rather than silently misplacing.
    const cells = chart.cells.filter((c) => c.col < columns && c.row < rows);
    this.chart = { ...chart, grid: { columns, rows }, cells };
    this.render();
    this.cb.onChange(this.chart);
  }

  setAxis(which: 'x' | 'y', patch: Partial<Chart['x']>): void {
    const chart = this.chart;
    this.chart = { ...chart, [which]: { ...chart[which], ...patch } };
    this.render();
    this.cb.onChange(this.chart);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function svg<K extends keyof SVGElementTagNameMap>(
  parent: SVGElement,
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent.appendChild(el);
  return el;
}

function inRect(p: { x: number; y: number }, r: PlotRect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `l${idSeq.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}
