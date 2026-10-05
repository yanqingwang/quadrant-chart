/**
 * The quadrant-chart data model, and the YAML-frontmatter shape it serialises to.
 *
 * A `.mdx` file is an ordinary text file: YAML frontmatter holds the chart, and the body is free
 * prose the user can annotate with. Nothing here is Obsidian-version-specific or binary, so a file
 * stays readable and editable with any text editor, survives plugin changes, and diffs cleanly in
 * git. That is the whole reason the format is frontmatter rather than JSON or a packed blob.
 *
 * Coordinates are stored in DATA space (the axis min/max range), never in pixels. The view maps
 * data space to screen space, so resizing the pane or changing the axis range never rewrites the
 * stored numbers. This is the single most important invariant in the file format: a chart saved on a
 * phone and opened on a desktop must land on the same logical spot.
 */

/** One horizontal axis. `min`/`max` bound the data space; `ticks` are optional extra gridlines. */
export interface Axis {
  label: string;
  min: number;
  max: number;
  /** Optional explicit tick positions. When empty the view derives ticks from min/max. */
  ticks?: number[];
  /**
   * Optional line drawn beside the axis, in smaller muted text — the scale's provenance, what the
   * score actually measures, where the numbers came from. Reserved room is added only when set.
   */
  note?: string;
}

/**
 * The N x M split. `columns` splits along x, `rows` splits along y.
 *
 * The split points are always derived by dividing the axis range evenly, so a 2x2 chart is the
 * default and a 3x4 chart needs no extra stored numbers. A cell is addressed by (col, row) with
 * col in [0, columns) and row in [0, rows), both counted from the minimum end of their axis.
 */
export interface Grid {
  columns: number;
  rows: number;
}

/**
 * Optional decoration for one grid cell. A cell with no entry simply renders as an empty region —
 * labels and colours are per-cell rather than per-quadrant, because "quadrant" implies exactly four
 * and this format supports any N x M.
 */
export interface Cell {
  col: number;
  row: number;
  label?: string;
  /** CSS colour for the cell background. */
  color?: string;
  /** Longer text drawn under the label, wrapped inside the cell. */
  note?: string;
}

/** A free-floating text label placed anywhere in the plot area. */
export interface Item {
  /** Stable id, so dragging or editing an item never reorders the list. */
  id: string;
  text: string;
  /** Position in DATA space, not pixels. */
  x: number;
  y: number;
  /** Optional overrides; unset means "use the document defaults". */
  color?: string;
  /** Font size in px, relative to the view's base size. */
  size?: number;
  /**
   * Optional plate drawn behind the text.
   *
   * The default is a stroked outline only (see `box`). A filled plate exists because a label is
   * otherwise readable only where it happens to land: on a coloured cell, on a grid line, or on top
   * of another label, all three of which are common and all of which make the text hard to read.
   */
  background?: string;
  /** Draw a border around the label. Cheap emphasis that does not hide the chart behind it. */
  box?: boolean;
}

/** The complete chart. Every field has a default, so a minimal .mdx stays valid. */
export interface Chart {
  title?: string;
  x: Axis;
  y: Axis;
  grid: Grid;
  cells: Cell[];
  items: Item[];
  /** Base font size in px for item labels; individual items may override it. */
  baseFontSize?: number;
}

/** Document defaults applied when a chart omits a field. */
export const DEFAULTS = {
  xAxis: { label: 'X axis', min: 0, max: 10 },
  yAxis: { label: 'Y axis', min: 0, max: 10 },
  grid: { columns: 2, rows: 2 },
  baseFontSize: 14,
} as const;

/** Guard rails so a hand-edited or corrupted file cannot produce a degenerate chart. */
export const LIMITS = {
  minSplits: 1,
  maxSplits: 12,
  minSpan: 1e-6,
  maxFontSize: 96,
  minFontSize: 8,
  /** Floor for the label-width setting: below this a label wraps to roughly one glyph per line. */
  minLabelWidthPercent: 20,
} as const;

/**
 * A fresh chart. Parameters are the plugin-level defaults so a new chart matches the user's
 * preferred starting shape rather than hard-coding 2x2.
 */
export function createChart(
  columns: number = DEFAULTS.grid.columns,
  rows: number = DEFAULTS.grid.rows,
): Chart {
  const cols = clampInt(columns, LIMITS.minSplits, LIMITS.maxSplits);
  const rws = clampInt(rows, LIMITS.minSplits, LIMITS.maxSplits);
  return {
    x: { ...DEFAULTS.xAxis },
    y: { ...DEFAULTS.yAxis },
    grid: { columns: cols, rows: rws },
    cells: [],
    items: [],
    baseFontSize: DEFAULTS.baseFontSize,
  };
}

export function clampInt(v: unknown, lo: number, hi: number, fallback = lo): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Normalise an arbitrary parsed value into a valid Chart.
 *
 * This is the trust boundary: the file is user-editable text that may be hand-written, truncated,
 * copied between vaults, or hand-corrupted. Every field is validated and defaulted here, so no
 * downstream code has to defend against a missing axis or a reversed range. Returning a usable
 * chart for damaged input is deliberate — a chart that fails to open is worse than one that opens
 * with a few defaults filled in.
 */
export function normalizeChart(raw: unknown): Chart {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const base = createChart();

  const x = normalizeAxis(src['x'], DEFAULTS.xAxis, 'X');
  const y = normalizeAxis(src['y'], DEFAULTS.yAxis, 'Y');

  const gridRaw = (src['grid'] && typeof src['grid'] === 'object' ? src['grid'] : {}) as Record<string, unknown>;
  const grid: Grid = {
    columns: clampInt(gridRaw['columns'] ?? base.grid.columns, LIMITS.minSplits, LIMITS.maxSplits, base.grid.columns),
    rows: clampInt(gridRaw['rows'] ?? base.grid.rows, LIMITS.minSplits, LIMITS.maxSplits, base.grid.rows),
  };

  const cells = Array.isArray(src['cells']) ? normalizeCells(src['cells'], grid) : [];
  const items = Array.isArray(src['items']) ? normalizeItems(src['items'], x, y) : [];

  const chart: Chart = { x, y, grid, cells, items };
  if (typeof src['title'] === 'string' && src['title'].trim()) chart.title = src['title'].trim();
  // Always resolved, never left undefined. The writer OMITS this key when it equals the default (to
  // keep diffs quiet), so a chart that only ever went through write->read would come back with the
  // field missing while an identical in-memory chart has it set. Filling it here makes a parsed
  // chart deep-equal to the chart that produced it, which is what makes the format round-trippable.
  const fs = Number(src['baseFontSize']);
  chart.baseFontSize = Number.isFinite(fs) && fs > 0
    ? clampNum(fs, LIMITS.minFontSize, LIMITS.maxFontSize, DEFAULTS.baseFontSize)
    : DEFAULTS.baseFontSize;
  return chart;
}

function normalizeAxis(raw: unknown, fallback: Axis, which: string): Axis {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const label = typeof src['label'] === 'string' && src['label'].trim()
    ? src['label'].trim()
    : fallback.label;
  let min = Number(src['min']);
  let max = Number(src['max']);
  if (!Number.isFinite(min)) min = fallback.min;
  if (!Number.isFinite(max)) max = fallback.max;
  // A reversed or zero-width range would make every coordinate unplottable, so swap and pad.
  if (min > max) [min, max] = [max, min];
  if (max - min < LIMITS.minSpan) max = min + 10;

  const axis: Axis = { label, min, max };
  if (Array.isArray(src['ticks'])) {
    const ticks = src['ticks']
      .map((t) => Number(t))
      .filter((t) => Number.isFinite(t) && t >= min && t <= max);
    // Sorted and de-duplicated so the view can render them without re-checking.
    if (ticks.length) axis.ticks = [...new Set(ticks)].sort((a, b) => a - b);
  }
  // Only a real non-empty string. An empty or whitespace-only note would otherwise reserve margin for
  // a line with nothing on it.
  if (typeof src['note'] === 'string' && src['note'].trim()) axis.note = src['note'].trim();
  // Referenced so a malformed axis is obvious in a stack trace rather than silently defaulted.
  void which;
  return axis;
}

function normalizeCells(raw: unknown[], grid: Grid): Cell[] {
  const out: Cell[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const col = toIndex(e['col']);
    const row = toIndex(e['row']);
    // Out of range for the current grid: DROP, do not clamp. Clamping would render the label in a
    // different cell than the file names — a cell at col 5 in a 2-column grid would silently
    // appear in the last column, which is worse than not showing it, because the file still says 5.
    if (col === null || row === null) continue;
    if (col >= grid.columns || row >= grid.rows) continue;
    const cell: Cell = { col, row };
    if (typeof e['label'] === 'string' && e['label'].trim()) cell.label = e['label'].trim();
    if (typeof e['color'] === 'string' && e['color'].trim()) cell.color = e['color'].trim();
    if (typeof e['note'] === 'string' && e['note'].trim()) cell.note = e['note'].trim();
    out.push(cell);
  }
  return out;
}

/** A non-negative integer index, or null when the value is not one. */
function toIndex(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 0 ? i : null;
}

function normalizeItems(raw: unknown[], x: Axis, y: Axis): Item[] {
  const out: Item[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const text = typeof e['text'] === 'string' ? e['text'] : '';
    if (!text.trim()) continue; // an empty label is invisible and not worth storing
    // Ids must be unique: they key drag/edit targeting, so a duplicate would make two labels
    // indistinguishable to the pointer.
    let id = typeof e['id'] === 'string' && e['id'].trim() ? e['id'].trim() : '';
    if (!id || seen.has(id)) id = uniqueId(seen);
    seen.add(id);
    const item: Item = {
      id,
      text,
      x: clampNum(e['x'], x.min, x.max, x.min),
      y: clampNum(e['y'], y.min, y.max, y.min),
    };
    if (typeof e['color'] === 'string' && e['color'].trim()) item.color = e['color'].trim();
    if (typeof e['background'] === 'string' && e['background'].trim()) item.background = e['background'].trim();
    // Only a real boolean counts. A hand-edited `"false"` string is truthy in JavaScript, so
    // accepting it would silently show a box the author explicitly turned off.
    if (typeof e['box'] === 'boolean') item.box = e['box'];
    const size = Number(e['size']);
    if (Number.isFinite(size) && size > 0) item.size = clampNum(size, LIMITS.minFontSize, LIMITS.maxFontSize, 0);
    out.push(item);
  }
  return out;
}

let idCounter = 0;
/** Short id that is stable within a session and collision-checked against `taken`. */
function uniqueId(taken: Set<string>): string {
  idCounter += 1;
  let candidate = `i${idCounter.toString(36)}`;
  while (taken.has(candidate)) {
    idCounter += 1;
    candidate = `i${idCounter.toString(36)}`;
  }
  return candidate;
}
