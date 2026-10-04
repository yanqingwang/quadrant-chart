/**
 * Raster export: draw a chart onto a Canvas 2D context and save it as an image.
 *
 * ## Why this does not reuse the on-screen SVG
 *
 * The obvious implementation — serialise the live `<svg>`, load it into an `<img>`, draw that to a
 * canvas — loses every piece of cell text. Cell labels and notes are drawn in a `foreignObject`,
 * and Chromium does not render `foreignObject` content in an SVG loaded as an image. The chart would
 * come out with its grid, its free labels and its axes, and every cell caption silently replaced by
 * empty space. Nothing errors; the file is just wrong.
 *
 * So this redraws the chart with the Canvas 2D API instead. That costs a second renderer and buys
 * three things: no `foreignObject` restriction, exact text measurement via `measureText` (so cell
 * notes wrap properly, which SVG cannot do without a foreignObject), and no async image load that
 * can fail.
 *
 * The layout still comes from `geometry.ts`, so the export and the on-screen canvas agree on where
 * everything goes — the maths is shared, only the drawing differs.
 *
 * ## What is deliberately not exported
 *
 * Selection outlines. They are interface state, not content: a saved image should show the chart,
 * not the fact that the user had something clicked.
 */

import { App, TFile } from 'obsidian';
import { Chart, DEFAULTS, LIMITS, clampNum } from './model';
import {
  Margins, DEFAULT_MARGINS,
  TextMeasurer, axisTicks, cellRect, dataToScreenX, dataToScreenY, estimateTextWidth, findCell,
  formatTick, labelBlockHeight, labelLines, splitPositions, wrapText,
  LABEL_LINE_RATIO, screenToDataY,
} from './geometry';

export { wrapText } from './geometry';
export type { TextMeasurer } from './geometry';
import { CELL_FILL_ALPHA, labelHalo } from './colorUi';

/** Colours and fonts resolved from the current theme, so an export follows light/dark mode. */
export interface ExportTheme {
  background: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  fontText: string;
  fontUi: string;
}

export interface ExportOptions {
  /** Logical size in CSS px, before `scale`. Independent of the pane size, so exports are stable. */
  width: number;
  height: number;
  /** Device-pixel multiplier. 2 keeps text crisp without an unreasonable file size. SVG ignores it. */
  scale: number;
  /** JPEG quality 0..1. Ignored for PNG and SVG. */
  quality: number;
  /**
   * Background to paint, or `null` for none.
   *
   * `null` is what the transparent option means: PNG and SVG carry alpha, JPEG cannot, so this is
   * only ever null for a format that supports it. Kept required rather than defaulted on purpose —
   * a caller who forgets is a caller whose JPEG comes out with whatever the canvas held.
   */
  background: string | null;
  /**
   * Widest a free label may be, as a share of the plot area, before it wraps. Mirrors the plugin
   * setting of the same name so the exported file matches what the user was looking at.
   */
  labelWidthPercent?: number;
}

export const DEFAULT_EXPORT: ExportOptions = {
  width: 1400, height: 900, scale: 2, quality: 0.92, background: '#ffffff',
  labelWidthPercent: 80,
};

/** Widest a free label may be, in pixels. Same rule as the on-screen canvas, same setting. */
function labelMaxWidth(plotWidth: number, opts: ExportOptions): number {
  const pct = clampNum(opts.labelWidthPercent ?? 80, LIMITS.minLabelWidthPercent, 100, 80);
  return Math.max(1, (plotWidth * pct) / 100);
}

/** Read the theme from a live element, so the export matches what the user is looking at. */
export function resolveExportTheme(el: Element | null): ExportTheme {
  const read = (name: string, fallback: string): string => {
    if (!el || typeof getComputedStyle !== 'function') return fallback;
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
  };
  return {
    // White rather than a hard-coded dark: JPEG has no alpha channel, so this fill is what the
    // user gets instead of transparency. Falling back to white also means a failed CSS read still
    // produces a readable file rather than black-on-black.
    background: read('--background-primary', '#ffffff'),
    text: read('--text-normal', '#1f1f1f'),
    muted: read('--text-muted', '#5c5c5c'),
    faint: read('--text-faint', '#b0b0b0'),
    accent: read('--interactive-accent', '#7b5cd6'),
    fontText: read('--font-text', 'sans-serif'),
    fontUi: read('--font-interface', 'sans-serif'),
  };
}

// ── drawing ───────────────────────────────────────────────────────────────────

const CELL_LABEL_SIZE = 13;
const CELL_NOTE_SIZE = 11;
const CELL_LABEL_WEIGHT = '600';
const NOTE_LINE_HEIGHT = 1.35;
const TICK_SIZE = 11;

/** How wide a piece of text is, in px. All wrapping is expressed through this one function. */

/**
 * Draw the whole chart.
 *
 * Exported (rather than kept private) so it can be tested against a recording context: a real
 * CanvasRenderingContext2D is not available under jsdom, but every drawing call can be captured, and
 * asserting on those calls is what proves the cell text is present rather than assumed.
 */
export function renderChartToCanvas(
  ctx: CanvasRenderingContext2D,
  chart: Chart,
  theme: ExportTheme,
  opts: ExportOptions = DEFAULT_EXPORT,
): void {
  const { width, height, scale } = opts;
  const margins: Margins = { ...DEFAULT_MARGINS, top: 48 };
  const plot = {
    x: margins.left,
    y: margins.top,
    width: Math.max(1, width - margins.left - margins.right),
    height: Math.max(1, height - margins.top - margins.bottom),
  };

  ctx.save();
  ctx.scale(scale, scale);

  // Opaque background first: JPEG cannot represent transparency, and without this fill the chart
  // would be composited onto whatever the canvas happened to contain.
  //
  // Tested for truthiness rather than `!== null`. TypeScript forces the field to be stated, but a
  // caller reaching this from plain JavaScript can still omit it, and `undefined !== null` is true —
  // which would set `fillStyle` to undefined and paint the canvas its default black. Skipping the
  // fill instead yields a transparent image, which is the recoverable mistake.
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, width, height);
  }

  drawCells(ctx, chart, plot, theme);
  drawGrid(ctx, chart, plot, theme);
  drawFrame(ctx, plot, theme);
  drawAxes(ctx, chart, plot, theme);
  drawItems(ctx, chart, plot, theme, opts.background, opts);
  ctx.restore();
}

function drawCells(ctx: CanvasRenderingContext2D, chart: Chart, plot: ReturnType<typeof cellRect>, theme: ExportTheme): void {
  for (let row = 0; row < chart.grid.rows; row += 1) {
    for (let col = 0; col < chart.grid.columns; col += 1) {
      const cell = findCell(chart, col, row);
      if (!cell) continue;
      const r = cellRect(chart, col, row, plot);

      if (cell.color) {
        ctx.save();
        // 18% to match the on-screen fill, so an exported chart looks like the one on screen.
        ctx.globalAlpha = CELL_FILL_ALPHA;
        ctx.fillStyle = cell.color;
        ctx.fillRect(r.x, r.y, r.width, r.height);
        ctx.restore();
      }

      if (!cell.label && !cell.note) continue;
      // Clipped to the cell: text that overflows would otherwise run across the grid lines and
      // into the neighbouring cell, which is exactly what the foreignObject's `overflow:hidden`
      // prevents on screen.
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x + 6, r.y + 6, Math.max(0, r.width - 12), Math.max(0, r.height - 12));
      ctx.clip();

      let cursorY = r.y + 6;
      if (cell.label) {
        ctx.fillStyle = theme.text;
        ctx.font = `${CELL_LABEL_WEIGHT} ${CELL_LABEL_SIZE}px ${theme.fontUi}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const lines = wrapText((t) => ctx.measureText(t).width, cell.label, Math.max(10, r.width - 12));
        // One line only for the caption: a wrapped cell title stops reading as a title.
        ctx.fillText(lines[0], r.x + 6, cursorY);
        cursorY += CELL_LABEL_SIZE + 2;
      }
      if (cell.note) {
        ctx.fillStyle = theme.muted;
        ctx.font = `${CELL_NOTE_SIZE}px ${theme.fontUi}`;
        const lines = wrapText((t) => ctx.measureText(t).width, cell.note, Math.max(10, r.width - 12));
        const lineH = CELL_NOTE_SIZE * NOTE_LINE_HEIGHT;
        for (const line of lines) {
          if (cursorY + lineH > r.y + r.height - 6) break;  // clip rather than overflow
          ctx.fillText(line, r.x + 6, cursorY);
          cursorY += lineH;
        }
      }
      ctx.restore();
    }
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, chart: Chart, plot: ReturnType<typeof cellRect>, theme: ExportTheme): void {
  const { xs, ys } = splitPositions(chart, plot);
  ctx.save();
  ctx.strokeStyle = theme.faint;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const x of xs) {
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.height);
  }
  for (const y of ys) {
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.width, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawFrame(ctx: CanvasRenderingContext2D, plot: ReturnType<typeof cellRect>, theme: ExportTheme): void {
  ctx.save();
  ctx.strokeStyle = theme.faint;
  ctx.lineWidth = 1;
  ctx.strokeRect(plot.x, plot.y, plot.width, plot.height);
  ctx.restore();
}

function drawAxes(ctx: CanvasRenderingContext2D, chart: Chart, plot: ReturnType<typeof cellRect>, theme: ExportTheme): void {
  ctx.save();
  ctx.fillStyle = theme.muted;
  ctx.font = `${TICK_SIZE}px ${theme.fontUi}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (const t of axisTicks(chart.x)) {
    const px = dataToScreenX(t, chart.x, plot);
    if (px < plot.x - 0.5 || px > plot.x + plot.width + 0.5) continue;
    ctx.fillText(formatTick(t), px, plot.y + plot.height + 8);
  }

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of axisTicks(chart.y)) {
    const py = dataToScreenY(t, chart.y, plot);
    if (py < plot.y - 0.5 || py > plot.y + plot.height + 0.5) continue;
    ctx.fillText(formatTick(t), plot.x - 9, py);
  }

  ctx.fillStyle = theme.text;
  ctx.font = `500 13px ${theme.fontUi}`;

  if (chart.x.label) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(chart.x.label, plot.x + plot.width / 2, plot.y + plot.height + 30);
  }

  if (chart.y.label) {
    // Rotated up the left gutter, matching the on-screen axis. ctx.translate + rotate rather than
    // a transform string, because the string form is fiddly to get right about the origin.
    ctx.save();
    ctx.translate(20, plot.y + plot.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(chart.y.label, 0, 0);
    ctx.restore();
  }

  if (chart.title) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `600 16px ${theme.fontUi}`;
    ctx.fillText(chart.title, plot.x, 14);
  }
  ctx.restore();
}

function drawItems(
  ctx: CanvasRenderingContext2D, chart: Chart, plot: ReturnType<typeof cellRect>,
  theme: ExportTheme, background: string | null, opts: ExportOptions = DEFAULT_EXPORT,
): void {
  const maxW = labelMaxWidth(plot.width, opts);
  for (const item of chart.items) {
    const px = dataToScreenX(item.x, chart.x, plot);
    const py = dataToScreenY(item.y, chart.y, plot);
    const fontSize = clampNum(
      item.size ?? chart.baseFontSize ?? DEFAULTS.baseFontSize,
      LIMITS.minFontSize, LIMITS.maxFontSize, DEFAULTS.baseFontSize,
    );
    ctx.save();
    ctx.translate(px, py);
    ctx.font = `${fontSize}px ${theme.fontText}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Real measurement here, not the shared estimate: this path has a canvas to ask, and the label
    // box must match the glyphs it wraps.
    const lines = wrapText((t) => ctx.measureText(t).width, item.text, maxW);
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const lineH = fontSize * LABEL_LINE_RATIO;

    if (item.background) {
      ctx.fillStyle = item.background;
      roundRect(ctx, -width / 2 - 5, -fontSize - 3, width + 10, labelBlockHeight(lines.length, fontSize), 3);
      ctx.fill();
    }

    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.fillStyle = item.color ?? theme.text;
    lines.forEach((line, i) => {
      const dy = i * lineH;
      // Per line, because a wrapped label can put its lower lines in a different cell.
      const dataY = i === 0
        ? item.y
        : screenToDataY(dataToScreenY(item.y, chart.y, plot) + dy, chart.y, plot);
      // The halo, matching the on-screen `paint-order: stroke`. Canvas has no paint-order, so this
      // is the outline drawn first and the glyphs on top — the same visual result.
      ctx.strokeStyle = labelHalo(chart, item, background ?? theme.background, dataY);
      ctx.strokeText(line, 0, dy);
      ctx.fillText(line, 0, dy);
    });

    if (item.box) {
      ctx.strokeStyle = item.color ?? theme.text;
      ctx.lineWidth = 1.5;
      roundRect(ctx, -width / 2 - 7, -fontSize - 6, width + 14, labelBlockHeight(lines.length, fontSize) + 3, 3);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  // Manual path, for contexts without roundRect.
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// ── SVG ───────────────────────────────────────────────────────────────────────

/**
 * Build a standalone SVG of the chart.
 *
 * Like the canvas exporter, this emits only native SVG primitives — no `foreignObject`, no CSS, no
 * external references. Both constraints are load-bearing rather than stylistic:
 *
 *  - `foreignObject` is dropped by Chromium when an SVG is loaded as an image, and by most SVG
 *    consumers besides. Cell text drawn that way disappears.
 *  - Styles must be inline because an SVG opened on its own, or embedded in a document, has no
 *    stylesheet. An SVG that inherits the view's CSS renders unstyled everywhere else.
 *
 * The trade-off against the canvas exporter is exactness of text measurement: there is no laid-out
 * element to measure, so wrapping uses the same estimate the canvas uses for hit targets. Both agree,
 * which matters more than either being precisely right.
 */
export function buildChartSvg(
  chart: Chart,
  theme: ExportTheme,
  opts: ExportOptions = DEFAULT_EXPORT,
): string {
  const { width, height } = opts;
  const margins: Margins = { ...DEFAULT_MARGINS, top: 48 };
  const plot = {
    x: margins.left,
    y: margins.top,
    width: Math.max(1, width - margins.left - margins.right),
    height: Math.max(1, height - margins.top - margins.bottom),
  };
  const out: string[] = [];
  const put = (s: string) => { out.push(s); };

  // Explicit width/height as well as a viewBox: an SVG loaded as an image has no intrinsic size
  // without them, and renders at the default 300x150 instead of the size asked for.
  put(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  put(`<title>${esc(chart.title ?? 'Quadrant chart')}</title>`);

  if (opts.background) {
    put(`<rect x="0" y="0" width="${width}" height="${height}" fill="${esc(opts.background)}"/>`);
  }

  // Cells.
  for (let row = 0; row < chart.grid.rows; row += 1) {
    for (let col = 0; col < chart.grid.columns; col += 1) {
      const cell = findCell(chart, col, row);
      if (!cell) continue;
      const r = cellRect(chart, col, row, plot);
      if (cell.color) {
        put(`<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}" fill="${esc(cell.color)}" fill-opacity="${CELL_FILL_ALPHA}"/>`);
      }
      if (!cell.label && !cell.note) continue;

      let cursorY = r.y + 6;
      if (cell.label) {
        // One line for the caption: a wrapped cell title stops reading as a title.
        const line = wrapText((t) => estimateTextWidth(t, CELL_LABEL_SIZE), cell.label, Math.max(10, r.width - 12))[0];
        put(`<text x="${n(r.x + 6)}" y="${n(cursorY + CELL_LABEL_SIZE)}" fill="${esc(theme.text)}" font-family="${esc(theme.fontUi)}" font-size="${CELL_LABEL_SIZE}" font-weight="${CELL_LABEL_WEIGHT}">${esc(line)}</text>`);
        cursorY += CELL_LABEL_SIZE + 2;
      }
      if (cell.note) {
        const lineH = CELL_NOTE_SIZE * NOTE_LINE_HEIGHT;
        for (const line of wrapText((t) => estimateTextWidth(t, CELL_NOTE_SIZE), cell.note, Math.max(10, r.width - 12))) {
          if (cursorY + lineH > r.y + r.height - 6) break;   // clip rather than overflow
          put(`<text x="${n(r.x + 6)}" y="${n(cursorY + CELL_NOTE_SIZE)}" fill="${esc(theme.muted)}" font-family="${esc(theme.fontUi)}" font-size="${CELL_NOTE_SIZE}">${esc(line)}</text>`);
          cursorY += lineH;
        }
      }
    }
  }

  // Split lines and frame.
  const { xs, ys } = splitPositions(chart, plot);
  put(`<g stroke="${esc(theme.faint)}" stroke-width="1">`);
  for (const x of xs) put(`<line x1="${n(x)}" y1="${n(plot.y)}" x2="${n(x)}" y2="${n(plot.y + plot.height)}" stroke-opacity="0.5"/>`);
  for (const y of ys) put(`<line x1="${n(plot.x)}" y1="${n(y)}" x2="${n(plot.x + plot.width)}" y2="${n(y)}" stroke-opacity="0.5"/>`);
  put('</g>');
  put(`<rect x="${n(plot.x)}" y="${n(plot.y)}" width="${n(plot.width)}" height="${n(plot.height)}" fill="none" stroke="${esc(theme.faint)}" stroke-width="1"/>`);

  // Ticks.
  for (const t of axisTicks(chart.x)) {
    const px = dataToScreenX(t, chart.x, plot);
    if (px < plot.x - 0.5 || px > plot.x + plot.width + 0.5) continue;
    put(`<text x="${n(px)}" y="${n(plot.y + plot.height + 20)}" fill="${esc(theme.muted)}" font-family="${esc(theme.fontUi)}" font-size="${TICK_SIZE}" text-anchor="middle">${esc(formatTick(t))}</text>`);
  }
  for (const t of axisTicks(chart.y)) {
    const py = dataToScreenY(t, chart.y, plot);
    if (py < plot.y - 0.5 || py > plot.y + plot.height + 0.5) continue;
    put(`<text x="${n(plot.x - 9)}" y="${n(py + 4)}" fill="${esc(theme.muted)}" font-family="${esc(theme.fontUi)}" font-size="${TICK_SIZE}" text-anchor="end">${esc(formatTick(t))}</text>`);
  }

  if (chart.x.label) {
    put(`<text x="${n(plot.x + plot.width / 2)}" y="${n(plot.y + plot.height + 42)}" fill="${esc(theme.text)}" font-family="${esc(theme.fontUi)}" font-size="13" text-anchor="middle">${esc(chart.x.label)}</text>`);
  }
  if (chart.y.label) {
    // Rotated about its own centre, matching the on-screen axis. The translate places the anchor and
    // the rotate turns the text up the left gutter from there.
    const cy = plot.y + plot.height / 2;
    put(`<text x="0" y="0" transform="translate(20 ${n(cy)}) rotate(-90)" fill="${esc(theme.text)}" font-family="${esc(theme.fontUi)}" font-size="13" text-anchor="middle">${esc(chart.y.label)}</text>`);
  }
  if (chart.title) {
    put(`<text x="${n(plot.x)}" y="24" fill="${esc(theme.text)}" font-family="${esc(theme.fontUi)}" font-size="16" font-weight="600">${esc(chart.title)}</text>`);
  }

  // Free labels.
  const haloBase = opts.background ?? theme.background;
  const maxW = labelMaxWidth(plot.width, opts);
  for (const item of chart.items) {
    const px = dataToScreenX(item.x, chart.x, plot);
    const py = dataToScreenY(item.y, chart.y, plot);
    const fontSize = clampNum(
      item.size ?? chart.baseFontSize ?? DEFAULTS.baseFontSize,
      LIMITS.minFontSize, LIMITS.maxFontSize, DEFAULTS.baseFontSize,
    );
    const lines = labelLines(item.text, fontSize, maxW);
    const w = Math.max(...lines.map((l) => estimateTextWidth(l, fontSize)));
    const blockH = labelBlockHeight(lines.length, fontSize);
    if (item.background) {
      put(`<rect x="${n(px - w / 2 - 5)}" y="${n(py - fontSize - 3)}" width="${n(w + 10)}" height="${n(blockH)}" rx="3" fill="${esc(item.background)}"/>`);
    }
    if (item.box) {
      put(`<rect x="${n(px - w / 2 - 7)}" y="${n(py - fontSize - 6)}" width="${n(w + 14)}" height="${n(blockH + 3)}" rx="3" fill="none" stroke="${esc(item.color ?? theme.text)}" stroke-width="1.5"/>`);
    }
    lines.forEach((line, i) => {
      const dy = i * fontSize * LABEL_LINE_RATIO;
      // Per line: a wrapped label can put its lower lines in a differently tinted cell.
      const dataY = i === 0
        ? item.y
        : screenToDataY(py + dy, chart.y, plot);
      const halo = labelHalo(chart, item, haloBase, dataY);
      // `paint-order: stroke` gives the halo under the glyphs in one element — the SVG equivalent of
      // the canvas exporter's two-pass stroke-then-fill.
      put(`<text x="${n(px)}" y="${n(py + dy)}" fill="${esc(item.color ?? theme.text)}" stroke="${esc(halo)}" stroke-width="3" stroke-linejoin="round" paint-order="stroke" font-family="${esc(theme.fontText)}" font-size="${fontSize}" text-anchor="middle" dominant-baseline="central">${esc(line)}</text>`);
    });
  }

  put('</svg>');
  return out.join('\n');
}

/** Round to 2dp, so the file has no float noise and stays diffable. */
function n(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** Escape text for an XML text node or attribute value. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── the DOM-facing half ───────────────────────────────────────────────────────

export type ImageKind = 'jpeg' | 'png' | 'svg';

/** Whether a format can carry transparency. JPEG cannot, which is why it is never offered clear. */
export function supportsTransparency(kind: ImageKind): boolean {
  return kind !== 'jpeg';
}

/**
 * Render `chart` and save it beside `source`.
 *
 * Saving into the vault rather than triggering a browser download, because the chart lives in the
 * vault and an exported image of it belongs there too — it stays in sync, gets synced and backed up
 * by whatever already handles the rest of the vault, and can be embedded in another note.
 */
export async function exportChartImage(
  app: App,
  chart: Chart,
  source: TFile,
  kind: ImageKind,
  theme: ExportTheme,
  opts: ExportOptions = DEFAULT_EXPORT,
): Promise<TFile> {
  if (kind === 'svg') {
    // Text, not binary, so it goes through create() and stays diffable in git — which is the whole
    // point of choosing SVG over a raster in the first place.
    const path = availablePath(app, source, kind);
    const written = await app.vault.create(path, buildChartSvg(chart, theme, opts));
    if (!(written instanceof TFile)) throw new Error('unexpected file type');
    return written;
  }

  if (typeof document === 'undefined') {
    throw new Error('image export needs a document');
  }
  // A canvas is a real HTML element, so `createEl` would be the idiomatic call — but there is no
  // element to hang one off: this module runs outside a view, from a command or a toolbar click, and
  // takes only the chart. `prefer-create-el` flags this line; that warning is deliberate, because
  // suppressing the rule is rejected by Obsidian's linter and working around it would mean threading
  // a throwaway container element through the exporter for no gain.
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(opts.width * opts.scale);
  canvas.height = Math.round(opts.height * opts.scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('could not get a 2d canvas context');

  renderChartToCanvas(ctx, chart, theme, opts);

  const blob = await canvasToBlob(canvas, kind, opts.quality);
  const buffer = await blob.arrayBuffer();

  // `-1` means "not an image already", so a second export gets `name-2.jpg` rather than a prompt
  // that would overwrite the first.
  const path = availablePath(app, source, kind);
  const written = await app.vault.createBinary(path, buffer);
  if (!(written instanceof TFile)) throw new Error('unexpected file type');
  return written;
}

function canvasToBlob(canvas: HTMLCanvasElement, kind: ImageKind, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // toBlob is the only encoder that does not force the caller to base64-decode a data URL.
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`could not encode a ${kind}`))),
      kind === 'jpeg' ? 'image/jpeg' : 'image/png',
      quality,
    );
  });
}

/** First free `<stem>.jpg`, `<stem>-2.jpg`, ... beside the source file. Never overwrites. */
function availablePath(app: App, source: TFile, kind: ImageKind): string {
  const ext = kind === 'jpeg' ? 'jpg' : kind;
  const dir = source.parent?.path ?? '';
  const base = `${dir ? `${dir}/` : ''}${source.basename}`;
  if (!app.vault.getAbstractFileByPath(`${base}.${ext}`)) return `${base}.${ext}`;
  for (let n2 = 2; n2 < 1000; n2 += 1) {
    const candidate = `${base}-${n2}.${ext}`;
    if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
  }
  throw new Error('could not find a free filename for the export');
}