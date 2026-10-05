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

import { CELL_FILL_ALPHA, labelHalo } from './colorUi';
import { Axis, Chart, Item, LIMITS, DEFAULTS, clampNum, normalizeChart } from './model';
import {
  Margins, PlotRect, DEFAULT_MARGINS,
  axisTicks, cellCentre, cellRect, dataToScreenX, dataToScreenY, estimateTextWidth, findCell, formatTick,
  screenToDataX, screenToDataY, splitPositions,
  LABEL_LINE_RATIO, labelBlockHeight, labelLines,
  AXIS_CAPTION_DX, AXIS_CAPTION_DY, AXIS_NOTE_DX, AXIS_NOTE_DY, AXIS_NOTE_SIZE, marginsFor,
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
  /** Called when the user clicks a cell, so the toolbar can act on the chosen one. */
  onSelectCell?(col: number, row: number): void;
  /**
   * Called when the selected LABEL changes, so the toolbar can show which one is selected.
   *
   * Without this the Label button is a dead end that looks identical whether or not anything is
   * selected. A user who adds a label, then opens the menu without first clicking the label, gets
   * only a disabled "click a label to select it" row and no delete — which reads as "deleting is
   * broken" rather than as "you skipped a step".
   */
  onSelectLabel?(id: string | null): void;
}

export class ChartCanvas {
  private svg: SVGSVGElement;
  private plot: PlotRect = { x: 0, y: 0, width: 1, height: 1 };
  /** Recomputed by `measure()` from the chart; this is only the value before the first measure. */
  private margins: Margins = { ...DEFAULT_MARGINS };
  private drag: DragMode = { kind: 'none' };
  /** Live position while dragging, so the model is not rewritten on every pointermove. */
  private draft: Chart | null = null;
  /** The cell the user last clicked. Null means "none chosen"; the view falls back to the middle. */
  private selected: { col: number; row: number } | null = null;
  /**
   * The label the user last clicked.
   *
   * Separate from `selected` because the two are not interchangeable: a label sits on top of a cell,
   * and "which label" and "which cell" are different questions. Clicking a label selects the label
   * and clears the cell, because a click that lands on text means the text.
   */
  private selectedItem: string | null = null;
  /** Resolved plot background, refreshed on each render; the label halo is blended against it. */
  private haloBase = '#ffffff';
  /**
   * How wide a label may get, as a share of the plot area, before it wraps.
   *
   * A percentage rather than a pixel count so the same setting holds in a narrow pane and in a
   * 1400px export. Set from the plugin's settings; changing it redraws.
   */
  private labelWidthPercent = 80;
  /**
   * Snapshots of the chart as it was BEFORE each committed change.
   *
   * Canvas edits bypass Obsidian's undo stack entirely — they never go through the editor — so an
   * accidental drag had no recovery route at all except hand-editing the YAML. A snapshot per change
   * is cheap (a chart is a few hundred bytes as JSON) and cannot be wrong about which fields a
   * partial gesture touched, which is where a diff-based undo would be fragile.
   *
   * Bounded, because a long editing session would otherwise grow it without limit. The cap is
   * deliberately generous: past a few dozen steps nobody reaches back, and holding more costs memory
   * nobody benefits from.
   */
  private undoStack: string[] = [];
  /**
   * States that were undone, newest last.
   *
   * Separate from `undoStack` rather than derived from it: a snapshot stack holds states, not
   * operations, so replaying forward means holding the states that were stepped off. Both stacks are
   * cleared together whenever a genuinely new change is committed, which is what makes a redo that
   * would replay an abandoned edit impossible rather than merely unlikely.
   */
  private redoStack: string[] = [];
  private static readonly UNDO_LIMIT = 100;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
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

  // ── undo ────────────────────────────────────────────────────────────────────

  /**
   * Record the current chart so `undo()` can return to it.
   *
   * Called BEFORE a change is applied, and only when one is actually about to happen. A snapshot
   * taken after the change would restore the change rather than undo it, and one taken for a no-op
   * would make undo appear to work while doing nothing.
   *
   * The redo stack is cleared here, not in the callers. Every committed change goes through this one
   * method, so clearing it anywhere else would be a place to forget — and a redo that replays a
   * change the user has since abandoned is worse than no redo at all.
   */
  pushUndo(): void {
    this.undoStack.push(JSON.stringify(this.chart));
    if (this.undoStack.length > ChartCanvas.UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /**
   * Step back one change. Returns false when there is nothing to undo.
   *
   * The state being left behind goes onto the redo stack, so undo and redo are symmetric: either can
   * be applied repeatedly and each hands the other what it gave up.
   */
  undo(): boolean {
    const prev = this.undoStack.pop();
    if (prev === undefined) return false;
    const restored = this.restoreFrom(prev);
    if (!restored) {
      // Put it back, or a single corrupt snapshot would silently swallow a step of history.
      this.undoStack.push(prev);
      return false;
    }
    this.redoStack.push(JSON.stringify(this.chart));
    this.chart = restored;
    this.afterHistoryJump();
    return true;
  }

  /** Replay the last undone change. Returns false when there is nothing to redo. */
  redo(): boolean {
    const next = this.redoStack.pop();
    if (next === undefined) return false;
    const restored = this.restoreFrom(next);
    if (!restored) {
      this.redoStack.push(next);
      return false;
    }
    this.undoStack.push(JSON.stringify(this.chart));
    this.chart = restored;
    this.afterHistoryJump();
    return true;
  }

  /** True when there is at least one step to undo. */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** True when there is at least one step to redo. */
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Parse a snapshot. Returns null rather than throwing, so a bad one fails the single step that used
   * it instead of destroying the rest of the history.
   */
  private restoreFrom(snapshot: string): Chart | null {
    try {
      // `normalizeChart` accepts `unknown`, so the double cast only papered over `JSON.parse`
      // returning `any` — which it does, and which is exactly why the value must not be trusted.
      return normalizeChart(JSON.parse(snapshot) as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  /**
   * Settle the view after moving through history: drop any live drag, then reconcile the selection
   * with whatever the restored chart contains, redraw, and persist.
   */
  private afterHistoryJump(): void {
    this.draft = null;
    // A selection can name something the restored chart no longer contains.
    if (this.selectedItem && !this.chart.items.some((i) => i.id === this.selectedItem)) {
      this.selectedItem = null;
    }
    if (this.selected
      && (this.selected.col >= this.chart.grid.columns || this.selected.row >= this.chart.grid.rows)) {
      this.selected = null;
    }
    this.render();
    this.cb.onChange(this.chart);
  }

  /**
   * Drop the history. Used when a different file is loaded, where the old file's snapshots would
   * restore its contents into the new one.
   */
  clearUndo(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  getChart(): Chart {
    return this.draft ?? this.chart;
  }

  /** Re-read the container size. Called on mount and whenever the pane resizes. */
  measure(): void {
    const w = Math.max(240, this.container.clientWidth);
    const h = Math.max(200, this.container.clientHeight);
    // Recomputed from the chart, not held fixed: an axis note reserves room, and that room has to be
    // the same room the exporters reserve.
    this.margins = marginsFor(this.getChart());
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

  /** Select a cell and redraw the highlight. Passing null clears the selection. */
  setSelectedCell(col: number | null, row: number | null): void {
    this.selected = col === null || row === null ? null : { col, row };
    // Selecting a cell means the click missed any label under it, so the label selection goes too.
    if (this.selected) this.selectedItem = null;
    this.render();
  }

  /** The currently selected cell, or null. */
  getSelectedCell(): { col: number; row: number } | null {
    return this.selected;
  }

  /** The currently selected label's id, or null. */
  getSelectedItem(): string | null {
    return this.selectedItem;
  }

  /** Select a label by id, clearing the cell selection. Passing null clears the label selection. */
  setSelectedItem(id: string | null): void {
    if (this.selectedItem === id) return;
    this.selectedItem = id;
    if (id) this.selected = null;
    this.render();
    this.cb.onSelectLabel?.(id);
  }

  /** Select a label. The single place the item-selection branch ends up. */
  private selectItem(id: string): void {
    this.selectedItem = id;
    this.selected = null;
    this.render();
    this.cb.onSelectLabel?.(id);
  }

  /** The cell actions apply to: the one the user clicked, else the middle of the grid. */
  effectiveCell(): { col: number; row: number } {
    if (this.selected) return this.selected;
    return {
      col: Math.floor(this.getChart().grid.columns / 2),
      row: Math.floor(this.getChart().grid.rows / 2),
    };
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  render(): void {
    const chart = this.getChart();
    // An axis note changes the margins, and the plot rect is derived from them — so setting or clearing
    // one has to re-measure or the note is drawn outside the plot it was given room for. Compared
    // rather than measured unconditionally: this runs on every drag frame, and a layout read per frame
    // is a cost the canvas should not pay to support a change that happens once per menu click.
    const wanted = marginsFor(chart);
    if (wanted.bottom !== this.margins.bottom || wanted.left !== this.margins.left) this.measure();
    const svg = this.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const rect = this.plot;
    // Read once per redraw, not once per label: the label halo is blended against the plot
    // background, and a getComputedStyle per label would run on every drag frame.
    this.haloBase = readCssColor(this.container, '--background-primary', '#ffffff');

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
        const r = cellRect(chart, col, row, rect);
        // A hit target for every cell, decorated or not. The label is drawn in a foreignObject with
        // pointer-events disabled, so without this a cell with no label or colour could not be
        // clicked at all — and therefore could not be selected or named.
        svg(this.svg, 'rect', {
          x: r.x, y: r.y, width: r.width, height: r.height,
          class: 'qc-cell-hit', 'data-cell-col': col, 'data-cell-row': row,
        });
        if (this.selected && this.selected.col === col && this.selected.row === row) {
          svg(this.svg, 'rect', {
            x: r.x + 1.5, y: r.y + 1.5, width: Math.max(1, r.width - 3), height: Math.max(1, r.height - 3),
            class: 'qc-cell-selected', rx: 3,
          });
        }
        if (!cell || (!cell.color && !cell.label && !cell.note)) continue;
        if (cell.color) {
          // pointer-events:none is essential, not cosmetic. This fill is painted AFTER the hit rect
          // and covers it completely, so without it every click on a coloured cell lands on the fill,
          // which carries no cell coordinates — and the cell silently cannot be selected. Only cells
          // that happened to have no colour were selectable, which is why it looked arbitrary.
          svg(this.svg, 'rect', {
            x: r.x, y: r.y, width: r.width, height: r.height,
            class: 'qc-cell-fill', fill: cell.color, 'fill-opacity': String(CELL_FILL_ALPHA),
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
        x: rect.x + rect.width / 2, y: rect.y + rect.height + AXIS_CAPTION_DY,
        class: 'qc-axis-label qc-editable', 'text-anchor': 'middle', 'data-axis': 'x',
      });
      t.textContent = x.label;
    }
    if (y.label) {
      const t = svg(this.svg, 'text', {
        x: AXIS_CAPTION_DX, y: rect.y + rect.height / 2, class: 'qc-axis-label qc-editable',
        'text-anchor': 'middle',
        transform: `rotate(-90 ${AXIS_CAPTION_DX} ${rect.y + rect.height / 2})`, 'data-axis': 'y',
      });
      t.textContent = y.label;
    }
    // Axis notes. The margin for these is reserved by `marginsFor`, so they never land on top of the
    // tick labels or off the bottom of the canvas. Not `qc-editable`: a note is set from the Axes
    // menu, and making it look clickable when a click does nothing would be a lie.
    if (x.note) {
      const t = svg(this.svg, 'text', {
        x: rect.x + rect.width / 2, y: rect.y + rect.height + AXIS_NOTE_DY,
        class: 'qc-axis-note', 'text-anchor': 'middle', 'font-size': AXIS_NOTE_SIZE,
        'data-axis-note': 'x',
      });
      t.textContent = x.note;
    }
    if (y.note) {
      const t = svg(this.svg, 'text', {
        x: AXIS_NOTE_DX, y: rect.y + rect.height / 2, class: 'qc-axis-note',
        'text-anchor': 'middle', 'font-size': AXIS_NOTE_SIZE,
        transform: `rotate(-90 ${AXIS_NOTE_DX} ${rect.y + rect.height / 2})`, 'data-axis-note': 'y',
      });
      t.textContent = y.note;
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
    const selected = this.selectedItem === item.id;
    const g = svg(this.svg, 'g', {
      class: selected ? 'qc-item qc-selected' : 'qc-item',
      transform: `translate(${px} ${py})`,
    });
    g.dataset['itemId'] = item.id;
    // The halo colour cannot live in the stylesheet: it depends on which cell this label happens to
    // sit in, and a ring in the wrong colour is worse than no ring. See `labelHalo`.
    g.style.setProperty('--qc-halo', labelHalo(chart, item, this.haloBase));

    // A hit plate as wide as the text, so a click anywhere on the label selects the label.
    //
    // This was an 8px-wide strip centred on the anchor point. The cell hit rects underneath cover
    // the whole plot, so any click beside the glyphs — which is most of the label's own area —
    // fell through to the cell and selected THAT instead. It looked like the cell was being
    // selected when the user meant the label. Width is estimated rather than measured because
    // getComputedTextLength needs layout this widget does not wait for; the estimate only has to be
    // generous enough to cover the glyphs.
    const lines = labelLines(item.text, fontSize, this.labelMaxWidth());
    const width = Math.max(...lines.map((l) => estimateTextWidth(l, fontSize)));

    // The label's own background plate, when it has one. Drawn first so it sits behind the text,
    // the hit plate and the selection box.
    const blockH = labelBlockHeight(lines.length, fontSize);
    if (item.background) {
      svg(g, 'rect', {
        x: -width / 2 - 5, y: -fontSize - 3, width: width + 10, height: blockH,
        class: 'qc-item-bg', rx: 3, fill: item.background,
      });
    }

    svg(g, 'rect', {
      x: -width / 2, y: -fontSize - 3, width, height: blockH, class: 'qc-item-hit',
    });

    // A box the author asked for, drawn under the selection box so the transient selection
    // indicator always reads on top of the permanent one.
    if (item.box) {
      svg(g, 'rect', {
        x: -width / 2 - 7, y: -fontSize - 6, width: width + 14, height: blockH + 3,
        class: 'qc-item-box', rx: 3,
      });
    }

    // The selection box is drawn BEFORE the text so it frames it rather than covering it.
    if (selected) {
      svg(g, 'rect', {
        x: -width / 2 - 5, y: -fontSize - 8, width: width + 10, height: blockH + 5,
        class: 'qc-item-selected', rx: 3,
      });
    }

    // One <text> per line rather than one with embedded newlines: the halo is set per line, because a
    // wrapped label that spans two rows needs the colour of the row each line actually sits in.
    lines.forEach((line, i) => {
      const y = i * fontSize * LABEL_LINE_RATIO;
      const el = svg(g, 'text', {
        x: 0, y, class: 'qc-item-text', 'text-anchor': 'middle',
        'font-size': fontSize, fill: item.color ?? 'currentColor',
      });
      if (i > 0) el.style.setProperty('--qc-halo', this.lineHalo(chart, item, y));
      el.textContent = line;
    });
  }

  /** Widest a label may be, in pixels, given the current plot and the configured share of it. */
  private labelMaxWidth(): number {
    return Math.max(1, (this.plot.width * this.labelWidthPercent) / 100);
  }

  /**
   * Halo colour for one line of a wrapped label.
   *
   * The line sits `dy` pixels below the label's anchor, which in a steeply scaled chart can be a
   * whole row away — so the cell is resolved from that line's own position, not the label's.
   */
  private lineHalo(chart: Chart, item: Item, dy: number): string {
    const dataY = dy === 0
      ? item.y
      : screenToDataY(dataToScreenY(item.y, chart.y, this.plot) + dy, chart.y, this.plot);
    return labelHalo(chart, item, this.haloBase, dataY);
  }

  /** Apply a new label-width limit and redraw, since wrapping changes every label's geometry. */
  setLabelWidthPercent(percent: number): void {
    const next = clampNum(percent, LIMITS.minLabelWidthPercent, 100, 80);
    if (next === this.labelWidthPercent) return;
    this.labelWidthPercent = next;
    this.render();
  }

  // ── interaction ───────────────────────────────────────────────────────────

  /**
 * Client coordinates mapped into SVG user units.
 *
 * Typed to the only two fields actually read, so it serves both the pointer and the mouse events
 * that reach this widget — `click` and `contextmenu` are MouseEvents, `pointerdown`/`move` are
 * PointerEvents, and they all need the same conversion.
 */
private svgPoint(evt: { clientX: number; clientY: number }): { x: number; y: number } {
    const box = this.svg.getBoundingClientRect();
    // The viewBox is 1:1 with width/height, so client deltas map straight to user units. Dividing by
    // the box keeps this correct if the pane is ever CSS-scaled.
    const scaleX = this.svg.viewBox.baseVal.width ? box.width / this.svg.viewBox.baseVal.width : 1;
    const scaleY = this.svg.viewBox.baseVal.height ? box.height / this.svg.viewBox.baseVal.height : 1;
    return { x: (evt.clientX - box.left) / (scaleX || 1), y: (evt.clientY - box.top) / (scaleY || 1) };
  }

  private onPointerDown = (evt: PointerEvent): void => {
    const target = evt.target as Element;

    // Right-click deletes, handled on POINTERDOWN rather than on `contextmenu`.
    //
    // Obsidian registers a capture-phase listener on `window` that calls
    // `preventDefault()` AND `stopImmediatePropagation()` on every *trusted* contextmenu event. A
    // capture listener on the window runs before the event reaches this SVG, so a `contextmenu`
    // handler here can never fire in the real app — the hit test still resolves (which is why the
    // cursor changes and the feature looks alive) but no deletion happens.
    //
    // Worse, that guard is `e.isTrusted`, and every synthetic event a test dispatches is untrusted.
    // So a jsdom test of a `contextmenu` handler passes while the feature is dead on screen. That is
    // exactly what happened: 390 green tests and a right-click that did nothing.
    //
    // `pointerdown` is not intercepted, and the right button sets `button === 2`. Dragging already
    // depends on pointerdown reaching here, so this is the same path that is known to work.
    if (evt.button === 2) {
      const rightId = target.closest?.('.qc-item')?.getAttribute('data-item-id');
      if (rightId) {
        evt.preventDefault();
        this.removeItem(rightId);
      }
      return;   // never start a drag from a non-primary button
    }
    if (evt.button !== 0) return;

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
    this.pushUndo();
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

  /**
   * Double-click edits the label under the pointer; on empty plot area it creates one.
   *
   * The label is resolved by POSITION, never by `event.target`. The first click of a double-click
   * selects the label, and selecting re-renders — and `render()` is a full teardown, so the `<text>`
   * node the pointer was over is destroyed and rebuilt. A browser then resolves the dblclick's target
   * to the nearest common ancestor of its two mousedown targets, and with the first one detached that
   * is the `<svg>` itself. Asking the event which label was hit therefore answered "none", the
   * handler fell through to the empty-area branch, and double-clicking a label silently created a
   * second one beside it.
   *
   * Hit-testing the coordinates is immune to that, and it is the same test a single click uses, so
   * the two can never disagree about what is under the pointer.
   */
  private onDoubleClick = (evt: MouseEvent): void => {
    const p = this.svgPoint(evt);
    const stack = this.labelsAt(p.x, p.y);
    if (stack.length) {
      // When labels overlap, prefer one the user has already cycled to with single clicks — they
      // chose it deliberately, and silently jumping back to the top one would undo that choice.
      const chosen = stack.find((i) => i.id === this.selectedItem) ?? stack[0];
      void this.renameItem(chosen);
      return;
    }
    // Double-clicking empty plot area creates a label at that spot: the fastest way to place text.
    if (!inRect(p, this.plot)) return;
    const x = screenToDataX(p.x, this.chart.x, this.plot);
    const y = screenToDataY(p.y, this.chart.y, this.plot);
    void this.addItem(x, y);
  };

  /**
   * Single click selects; a click on an axis label or the title renames it in place.
   *
   * The axis captions sit in empty gutter space where nothing else can be hit, so a single click is
   * unambiguous there and there is no reason to make the user wait for a double click.
   *
   * Order below is load-bearing, and the label branch MUST come first. The cell hit rects cover the
   * whole plot, so with cells checked first a click on a label could only select the cell — which is
   * exactly the reported bug: clicking text selected the cell underneath it. Labels are painted on
   * top of cells, so a click that lands on one means the user aimed at the label.
   */
  private onClick = (evt: MouseEvent): void => {
    const target = evt.target as Element;

    const itemId = target.closest?.('.qc-item')?.getAttribute('data-item-id');
    if (itemId) {
      // Overlapping labels: a pointer event only ever reports the TOPMOST one, so a label under
      // another is unreachable by clicking alone. Clicking the same spot again steps down through
      // the stack — which is why the position is taken from what is ALREADY selected rather than
      // from what was clicked. The clicked target is always the top one, so using it would never
      // advance past it.
      const p = this.svgPoint(evt);
      const stack = this.labelsAt(p.x, p.y);
      if (stack.length > 1) {
        const current = stack.findIndex((i) => i.id === this.selectedItem);
        if (current >= 0) {
          this.selectItem(stack[(current + 1) % stack.length].id);
          return;
        }
      }
      this.selectItem(itemId);
      return;
    }

    // Split lines swallow the click rather than selecting the cell beneath them: dragging a split to
    // resize the grid is a deliberate gesture and should not also change the selection.
    if (target.closest?.('.qc-split-hit')) return;

    const cellCol = target.getAttribute?.('data-cell-col');
    const cellRow = target.getAttribute?.('data-cell-row');
    if (cellCol !== null && cellCol !== undefined && cellRow !== null && cellRow !== undefined) {
      this.selected = { col: Number(cellCol), row: Number(cellRow) };
      this.selectedItem = null;
      this.cb.onSelectCell?.(this.selected.col, this.selected.row);
      this.render();
      return;
    }

    const axis = target.getAttribute?.('data-axis');
    if (axis !== 'x' && axis !== 'y' && axis !== 'title') return;
    evt.stopPropagation();
    if (axis === 'title') void this.renameTitle();
    else void this.renameAxis(axis);
  };

  /**
   * Fallback for hosts that do NOT swallow `contextmenu`.
   *
   * Obsidian does swallow it (capture-phase, `stopImmediatePropagation`, trusted events only), so in
   * practice the deletion has already happened in `onPointerDown`. `removeItem` refuses an id that is
   * no longer present, so the two paths cannot delete twice.
   */
  private onContextMenu = (evt: MouseEvent): void => {
    // Hit-tested by position for the same reason as the double-click: `pointerup` has already run
    // by the time this fires and re-rendered, so the node the event names is gone. Reading
    // `event.target` here answered "no label" and the fallback silently did nothing.
    const p = this.svgPoint(evt);
    const stack = this.labelsAt(p.x, p.y);
    if (!stack.length) return;
    evt.preventDefault();
    const chosen = stack.find((i) => i.id === this.selectedItem) ?? stack[0];
    // removeItem already snapshots, redraws, saves and notifies the toolbar. Repeating any of that
    // here meant one right-click cost two writes and TWO undo steps to walk back.
    this.removeItem(chosen.id);
  };

  // ── mutations exposed to the host (toolbar, commands) ─────────────────────

  async addItem(x?: number, y?: number): Promise<void> {
    const text = await this.cb.promptText('New label', 'Add label');
    if (text === null) return;
    const label = text.trim();
    if (!label) return;
    const chart = this.getChart();
    // With no coordinates the user has not pointed anywhere, so the cell they have selected is the
    // only thing that says where the label belongs. Defaulting to the centre of the data range
    // instead put every new label on the exact point where all the split lines meet, from which
    // `cellAt` picked the top-right cell regardless of the selection — so clicking a cell and then
    // pressing "Add label" appeared to do nothing.
    const spot = x === undefined || y === undefined
      ? cellCentre(chart, this.effectiveCell().col, this.effectiveCell().row)
      : { x, y };
    const item: Item = {
      id: nextId(),
      text: label,
      x: round2(spot.x),
      y: round2(spot.y),
    };
    this.pushUndo();
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
    this.pushUndo();
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
    this.pushUndo();
    this.chart = { ...this.chart, title: t || undefined };
    this.render();
    this.cb.onChange(this.chart);
  }

  /** Set (or clear, with null) a label's font size. Null means "inherit the chart's base size". */
  setItemSize(id: string, size: number | null): void {
    const item = this.chart.items.find((i) => i.id === id);
    if (!item) return;
    const next = size === null
      ? undefined
      : clampNum(Math.round(size), LIMITS.minFontSize, LIMITS.maxFontSize, DEFAULTS.baseFontSize);
    // Setting the size it already has is not a change, so it must not push an undo snapshot.
    if ((item.size ?? undefined) === next) return;
    this.pushUndo();
    this.chart = {
      ...this.chart,
      items: this.chart.items.map((i) => (i.id === id ? { ...i, size: next } : i)),
    };
    this.render();
    this.cb.onChange(this.chart);
  }

  /**
   * Move a label to the front of the paint order, or the back.
   *
   * Paint order is the array order in the file, which is why this is a content change and not a
   * view setting: two labels at the same coordinates are indistinguishable in the file except by
   * which comes first, so reordering is the only way to bring the lower one out from under.
   */
  reorderItem(id: string, to: 'front' | 'back'): void {
    const from = this.chart.items.findIndex((i) => i.id === id);
    if (from === -1) return;
    const items = [...this.chart.items];
    const [moved] = items.splice(from, 1);
    if (to === 'front') items.push(moved);
    else items.unshift(moved);
    // Already at that end, or it is the only label: nothing to change, so nothing to undo.
    if (items[to === 'front' ? items.length - 1 : 0] === moved && from === (to === 'front' ? items.length - 1 : 0)) {
      return;
    }
    this.pushUndo();
    this.chart = { ...this.chart, items };
    this.render();
    this.cb.onChange(this.chart);
  }

  /**
   * Every label whose hit plate covers a screen point, topmost first.
   *
   * Computed geometrically rather than read from DOM targets, because a click only ever reports the
   * topmost element — which is exactly the label the user cannot otherwise reach. Anything beneath it
   * is unreachable by any pointer event, so it has to be worked out from the geometry.
   */
  labelsAt(px: number, py: number): Item[] {
    const chart = this.getChart();
    const hits: Item[] = [];
    for (const item of chart.items) {
      const r = this.itemHitRect(item, chart);
      if (px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height) hits.push(item);
    }
    // Later in the array is painted later, so it is on top. Reverse to get topmost first.
    return hits.reverse();
  }

  /** The screen box of a label's click target — shared by hit testing and overlap detection. */
  private itemHitRect(item: Item, chart: Chart): { x: number; y: number; width: number; height: number } {
    const fontSize = clampNum(
      item.size ?? chart.baseFontSize ?? DEFAULTS.baseFontSize,
      LIMITS.minFontSize, LIMITS.maxFontSize, DEFAULTS.baseFontSize,
    );
    // Must wrap exactly as `drawItem` does, or a label could be drawn over three lines and still
    // only be clickable on the first — the click would fall through to the cell underneath.
    const lines = labelLines(item.text, fontSize, this.labelMaxWidth());
    const width = Math.max(...lines.map((l) => estimateTextWidth(l, fontSize)));
    return {
      x: dataToScreenX(item.x, chart.x, this.plot) - width / 2,
      y: dataToScreenY(item.y, chart.y, this.plot) - fontSize - 3,
      width,
      height: labelBlockHeight(lines.length, fontSize),
    };
  }

  /** Delete a label by id, clearing the selection if it was the one removed. */
  removeItem(id: string): void {
    if (!this.chart.items.some((i) => i.id === id)) return;
    this.pushUndo();
    this.chart = { ...this.chart, items: this.chart.items.filter((i) => i.id !== id) };
    if (this.selectedItem === id) {
      this.selectedItem = null;
      // The toolbar names the selected label, so it has to hear that the name is gone.
      this.cb.onSelectLabel?.(null);
    }
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
    this.pushUndo();
    if (!label) {
      this.chart = { ...chart, items: chart.items.filter((i) => i.id !== item.id) };
      if (this.selectedItem === item.id) this.selectedItem = null;
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
    this.pushUndo();
    this.chart = { ...this.chart, cells };
    this.render();
    this.cb.onChange(this.chart);
  }

  setGrid(columns: number, rows: number): void {
    const chart = this.chart;
    // Cells outside the new grid would render nowhere; drop them rather than silently misplacing.
    const cells = chart.cells.filter((c) => c.col < columns && c.row < rows);
    // Setting the grid to the size it already has is not a change, so it must not push a snapshot —
    // otherwise undo appears to work while stepping through states that never occurred.
    if (columns === chart.grid.columns && rows === chart.grid.rows && cells.length === chart.cells.length) {
      return;
    }
    this.pushUndo();
    this.chart = { ...chart, grid: { columns, rows }, cells };
    // A selection that no longer exists would leave the toolbar acting on a cell that is not drawn.
    if (this.selected && (this.selected.col >= columns || this.selected.row >= rows)) this.selected = null;
    this.render();
    this.cb.onChange(this.chart);
  }

  setAxis(which: 'x' | 'y', patch: Partial<Chart['x']>): void {
    const chart = this.chart;
    const next: Axis = { ...chart[which], ...patch };
    if (JSON.stringify(next) === JSON.stringify(chart[which])) return;
    this.pushUndo();
    this.chart = { ...chart, [which]: next };
    this.render();
    this.cb.onChange(this.chart);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Create an SVG child element and append it to `parent`.
 *
 * `document.createElementNS` is required and is NOT interchangeable with Obsidian's `createEl` here.
 * `createEl` is typed to `keyof HTMLElementTagNameMap` and creates an element in the HTML namespace,
 * so an SVG built with it would not render — the tag would be in the wrong namespace entirely.
 * Obsidian's `createSvg` is no help either: it makes a standalone `<svg>` with no parent argument,
 * and this needs children of an existing `<svg>` or `<g>`. `SVGElement` is augmented with only
 * `setCssStyles` and `setCssProps`, never `createEl`.
 *
 * `prefer-create-el` therefore flags this line, and that is a false positive. Obsidian's own linter
 * rejects disabling the rule, so the warning is left standing rather than suppressed: rewriting this
 * to satisfy the rule would put every node in the HTML namespace and stop the chart rendering.
 */
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

function readCssColor(el: Element, prop: string, fallback: string): string {
  if (typeof getComputedStyle !== 'function') return fallback;
  return getComputedStyle(el).getPropertyValue(prop).trim() || fallback;
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
