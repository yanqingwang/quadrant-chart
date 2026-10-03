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
  axisTicks, cellRect, dataToScreenX, dataToScreenY, findCell, formatTick, splitPositions,
} from './geometry';

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
  /** Device-pixel multiplier. 2 keeps text crisp without an unreasonable file size. */
  scale: number;
  /** JPEG quality 0..1. Ignored for PNG. */
  quality: number;
}

export const DEFAULT_EXPORT: ExportOptions = { width: 1400, height: 900, scale: 2, quality: 0.92 };

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

  // Opaque background first: JPEG cannot represent transparency, and without this the chart would
  // be composited onto whatever the canvas happened to contain.
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  drawCells(ctx, chart, plot, theme);
  drawGrid(ctx, chart, plot, theme);
  drawFrame(ctx, plot, theme);
  drawAxes(ctx, chart, plot, theme);
  drawItems(ctx, chart, plot, theme);
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
        ctx.globalAlpha = 0.18;
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
        const lines = wrapText(ctx, cell.label, Math.max(10, r.width - 12));
        // One line only for the caption: a wrapped cell title stops reading as a title.
        ctx.fillText(lines[0], r.x + 6, cursorY);
        cursorY += CELL_LABEL_SIZE + 2;
      }
      if (cell.note) {
        ctx.fillStyle = theme.muted;
        ctx.font = `${CELL_NOTE_SIZE}px ${theme.fontUi}`;
        const lines = wrapText(ctx, cell.note, Math.max(10, r.width - 12));
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

function drawItems(ctx: CanvasRenderingContext2D, chart: Chart, plot: ReturnType<typeof cellRect>, theme: ExportTheme): void {
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

    const width = ctx.measureText(item.text).width;

    if (item.background) {
      ctx.fillStyle = item.background;
      roundRect(ctx, -width / 2 - 5, -fontSize - 3, width + 10, fontSize + 9, 3);
      ctx.fill();
    }

    // The halo, matching the on-screen `paint-order: stroke`. Canvas has no paint-order, so this is
    // the outline drawn first and the glyphs on top — the same visual result.
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = item.background || theme.background;
    ctx.strokeText(item.text, 0, 0);
    ctx.fillStyle = item.color ?? theme.text;
    ctx.fillText(item.text, 0, 0);

    if (item.box) {
      ctx.strokeStyle = item.color ?? theme.text;
      ctx.lineWidth = 1.5;
      roundRect(ctx, -width / 2 - 7, -fontSize - 6, width + 14, fontSize + 12, 3);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * Greedy word wrap.
 *
 * CJK has no spaces, so it must break between characters; Latin breaks at spaces. Both are handled
 * by the same loop: a break is taken at the last space if there was one, otherwise wherever the width
 * runs out. Splitting on words alone would put an entire Chinese sentence on one line, and splitting
 * on characters alone would break English mid-word.
 */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const ch of paragraph) {
      const candidate = line + ch;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        // Prefer a word boundary if one is available in the text already committed.
        const space = line.lastIndexOf(' ');
        if (space > 0) {
          out.push(line.slice(0, space));
          line = line.slice(space + 1) + ch;
        } else {
          out.push(line);
          line = ch;
        }
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
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

// ── the DOM-facing half ───────────────────────────────────────────────────────

export type ImageKind = 'jpeg' | 'png';

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
  if (typeof document === 'undefined') {
    throw new Error('image export needs a document');
  }
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
  const ext = kind === 'jpeg' ? 'jpg' : 'png';
  const dir = source.parent?.path ?? '';
  const base = `${dir ? `${dir}/` : ''}${source.basename}`;
  if (!app.vault.getAbstractFileByPath(`${base}.${ext}`)) return `${base}.${ext}`;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}.${ext}`;
    if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
  }
  throw new Error('could not find a free filename for the export');
}