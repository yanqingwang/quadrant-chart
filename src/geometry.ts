/**
 * Geometry: mapping between data space (the axis ranges a user thinks in) and screen space.
 *
 * All of it is pure and free of DOM types, so the maths that decides where a label lands can be
 * tested directly instead of inferred from pixels. The view owns screen space; nothing here does.
 *
 * The Y axis is the one place this is easy to get wrong. Data space puts y=0 at the *bottom* (the
 * way a chart is read), while SVG puts y=0 at the top, so the y mapping inverts. Every conversion
 * between the two goes through `dataToScreenY` / `screenToDataY` and never through raw arithmetic,
 * so the inversion exists in exactly one place.
 */

import { Axis, Chart, Grid, LIMITS, clampNum } from './model';

/**
 * Roughly how wide a string will render, in px, for a given font size.
 *
 * Shared by the canvas (to size a label's click target) and the exporters (to wrap cell notes), so
 * both agree on where a piece of text ends. It is an estimate rather than a measurement because
 * `getComputedTextLength` requires the element to have been laid out, and the canvas redraws
 * synchronously before that happens; the SVG exporter has no laid-out element at all.
 *
 * Deliberately generous: over-estimating costs a few px of tolerance around text, while
 * under-estimating puts the edge of a label outside its own hit area — the bug this replaced.
 *
 * CJK and other full-width characters count as one em, Latin as about half, which is close enough
 * for a sans-serif UI face.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||   // Hangul Jamo
      (c >= 0x2e80 && c <= 0x303e) ||   // CJK radicals, Kangxi, punctuation
      (c >= 0x3041 && c <= 0x33ff) ||   // Kana, Hangul compat, CJK compat
      (c >= 0x3400 && c <= 0x4dbf) ||   // CJK ext A
      (c >= 0x4e00 && c <= 0x9fff) ||   // CJK unified
      (c >= 0xa000 && c <= 0xa4cf) ||   // Yi
      (c >= 0xac00 && c <= 0xd7a3) ||   // Hangul syllables
      (c >= 0xf900 && c <= 0xfaff) ||   // CJK compat ideographs
      (c >= 0xff00 && c <= 0xff60) ||   // fullwidth forms
      (c >= 0xffe0 && c <= 0xffe6);
    em += wide ? 1 : 0.55;
  }
  // A minimum, so a single-character label is still comfortably clickable.
  return Math.max(14, em * fontSize);
}

/** Screen rectangle of the plot area, excluding axis labels and the surrounding chrome. */
export interface PlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Padding reserved for axis labels and tick text, in px. */
export interface Margins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const DEFAULT_MARGINS: Margins = { left: 64, right: 24, top: 32, bottom: 56 };

/** Uniform scale factor for the given plot rect, clamped so a collapsed pane cannot divide by ~0. */
export function dataToScreenX(value: number, axis: Axis, rect: PlotRect): number {
  const t = (value - axis.min) / (axis.max - axis.min || 1);
  return rect.x + t * rect.width;
}

export function dataToScreenY(value: number, axis: Axis, rect: PlotRect): number {
  // Inverted: higher data-y is higher on screen, which means a smaller SVG y.
  const t = (value - axis.min) / (axis.max - axis.min || 1);
  return rect.y + rect.height - t * rect.height;
}

export function screenToDataX(px: number, axis: Axis, rect: PlotRect): number {
  const t = (px - rect.x) / (rect.width || 1);
  return clampNum(axis.min + t * (axis.max - axis.min), axis.min, axis.max, axis.min);
}

export function screenToDataY(py: number, axis: Axis, rect: PlotRect): number {
  const t = 1 - (py - rect.y) / (rect.height || 1);
  return clampNum(axis.min + t * (axis.max - axis.min), axis.min, axis.max, axis.min);
}

/** The screen positions of the grid split lines, excluding the outer frame. */
export function splitPositions(chart: Chart, rect: PlotRect): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let c = 1; c < chart.grid.columns; c += 1) {
    const t = c / chart.grid.columns;
    xs.push(rect.x + t * rect.width);
  }
  for (let r = 1; r < chart.grid.rows; r += 1) {
    const t = r / chart.grid.rows;
    ys.push(rect.y + t * rect.height);
  }
  return { xs, ys };
}

/**
 * Tick values for an axis: the explicit ones when present, otherwise a readable default set.
 *
 * A "nice" step (1/2/5 x 10^n) is chosen rather than raw division, because dividing a range into
 * equal parts routinely yields values like 3.33333 that make an axis unreadable.
 */
export function axisTicks(axis: Axis): number[] {
  if (axis.ticks && axis.ticks.length) return axis.ticks;
  const span = axis.max - axis.min;
  if (!(span > 0)) return [axis.min];
  const target = 5;
  const rawStep = span / target;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = niceNorm * mag;
  if (!(step > 0)) return [axis.min];
  const out: number[] = [];
  // Start at the first multiple of step at or above min, so ticks land on round numbers.
  const first = Math.ceil(axis.min / step) * step;
  for (let v = first; v <= axis.max + step * 1e-9; v += step) {
    // Re-round to kill float drift (0.30000000000000004) that would print as noise on the axis.
    out.push(Math.round(v / step) * step);
  }
  return out;
}

/** Screen rectangle for one grid cell, in data-ascending order (row 0 is the bottom). */
export function cellRect(chart: Chart, col: number, row: number, rect: PlotRect): PlotRect {
  const w = rect.width / chart.grid.columns;
  const h = rect.height / chart.grid.rows;
  return {
    x: rect.x + col * w,
    // row 0 is the lowest data-y, so it occupies the bottom band of the screen rect.
    y: rect.y + rect.height - (row + 1) * h,
    width: w,
    height: h,
  };
}

/**
 * The centre of a grid cell, in DATA space.
 *
 * This is where a new label belongs. The previous behaviour used the centre of the whole data range,
 * which on an even grid is the point where every split line meets — a label there is on the boundary
 * of two or four cells, so which cell it "is" becomes an artefact of the rounding in `cellAt`. Here
 * the result is strictly interior, which is what makes a label's cell unambiguous afterwards.
 */
export function cellCentre(chart: Chart, col: number, row: number): { x: number; y: number } {
  const w = (chart.x.max - chart.x.min) / chart.grid.columns;
  const h = (chart.y.max - chart.y.min) / chart.grid.rows;
  return {
    x: chart.x.min + (col + 0.5) * w,
    y: chart.y.min + (row + 0.5) * h,
  };
}

/** The grid cell containing a data point, or null when the point is outside the plot. */
export function cellAt(chart: Chart, x: number, y: number): { col: number; row: number } | null {
  if (x < chart.x.min || x > chart.x.max || y < chart.y.min || y > chart.y.max) return null;
  const col = Math.min(chart.grid.columns - 1, Math.floor(((x - chart.x.min) / (chart.x.max - chart.x.min)) * chart.grid.columns));
  const row = Math.min(chart.grid.rows - 1, Math.floor(((y - chart.y.min) / (chart.y.max - chart.y.min)) * chart.grid.rows));
  return { col, row };
}

/** Look up the decoration for a cell, if the author set one. */
export function findCell(chart: Chart, col: number, row: number) {
  return chart.cells.find((c) => c.col === col && c.row === row);
}

/** Default label for a cell when the author has not named it (used by the "name this cell" prompt). */
export function defaultCellLabel(col: number, row: number, grid: Grid): string {
  return `R${row + 1}C${col + 1}`;
}

/**
 * Format a tick value compactly, so 1000000 does not stretch the axis gutter.
 *
 * Magnitude is checked BEFORE the integer shortcut: 1500000 is an integer, and testing that first
 * would return the full digit string and never reach the compaction below.
 */
export function formatTick(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${trimNum(v / 1e6)}M`;
  if (abs >= 1e4) return `${trimNum(v / 1e3)}k`;
  if (Number.isInteger(v)) return String(v);
  return trimNum(v);
}

function trimNum(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(r);
}
