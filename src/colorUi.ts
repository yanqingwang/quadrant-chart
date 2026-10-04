/**
 * Colour selection.
 *
 * Colours existed from the start but were reachable only by hand-editing the frontmatter, which is
 * a poor answer to "how do I set a colour" — the format supported it and the UI did not. This module
 * provides both halves: a small curated palette for the common case, and Obsidian's own
 * {@link ColorComponent} for anything else.
 *
 * The palette is deliberate rather than a full picker on its own. A quadrant chart needs a handful of
 * distinguishable tints, and a wall of swatches makes that harder, not easier. The values are also
 * chosen to stay legible as an 18%-opacity fill behind dark text in both light and dark themes.
 */

import { App, ColorComponent, Modal, Setting } from 'obsidian';
import { Chart, Item } from './model';
import { cellAt, findCell } from './geometry';

/**
 * Curated tints. Each must remain distinguishable from its neighbours at the 18% opacity used for
 * cell backgrounds — two adjacent swatches that read the same once blended are worse than no swatches.
 */
export const PALETTE: { name: string; hex: string }[] = [
  { name: 'Red', hex: '#d93025' },
  { name: 'Orange', hex: '#f9ab00' },
  { name: 'Yellow', hex: '#fdd663' },
  { name: 'Green', hex: '#188038' },
  { name: 'Teal', hex: '#12b5cb' },
  { name: 'Blue', hex: '#1a73e8' },
  { name: 'Purple', hex: '#9334e6' },
  { name: 'Pink', hex: '#e374b9' },
  { name: 'Grey', hex: '#9aa0a6' },
];

/** Normalise to `#rrggbb`, lowercased. Returns null for anything unusable. */
export function normalizeHex(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  let v = value.trim().toLowerCase();
  if (!v) return null;
  if (!v.startsWith('#')) v = `#${v}`;
  // Expand #abc to #aabbcc, which the colour component emits and hand-editing often produces.
  if (/^#[0-9a-f]{3}$/.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

/**
 * Opacity a cell tint is painted at, over the page background.
 *
 * Defined once because the label halo is computed by blending against this exact value: if the two
 * ever drift, every label in a tinted cell grows a visible ring, which reads as a drop shadow.
 */
export const CELL_FILL_ALPHA = 0.18;

/**
 * Blend `fg` over `bg` at `alpha` and return `#rrggbb`.
 *
 * A cell tint is translucent, so the colour actually visible behind a label sitting in that cell is
 * the blend — neither the tint nor the page background. Falls back to `bg` when `fg` is absent or
 * unparseable, so a hand-edited colour degrades to the previous behaviour instead of to black.
 */
export function compositeOver(fg: string | null | undefined, alpha: number, bg: string): string {
  const b = normalizeHex(bg);
  const f = normalizeHex(fg);
  if (!b || !f) return b ?? bg;
  const byte = (i: number): string => {
    const bf = parseInt(b.slice(1 + i * 2, 3 + i * 2), 16);
    const ff = parseInt(f.slice(1 + i * 2, 3 + i * 2), 16);
    const v = Math.round(bf + (ff - bf) * alpha);
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  };
  return `#${byte(0)}${byte(1)}${byte(2)}`;
}

/**
 * The colour actually visible immediately behind a free label, which is what its halo must be.
 *
 * The halo exists to keep a label legible where it crosses a grid line or another label. That only
 * works if the halo IS the surface behind the glyphs — a halo in any other colour is a visible ring
 * around every label, and a white ring on a tinted cell reads as a drop shadow rather than as
 * separation. It cannot simply be dropped either, because crossing a grid line still needs it.
 *
 * Precedence, in the order the surfaces stack:
 *   1. the label's own background plate, which is opaque and covers the cell entirely;
 *   2. the cell tint blended over the plot background, since the tint is painted translucently;
 *   3. the plot background itself, for a label on an uncoloured cell or outside the grid.
 *
 * `atY` exists for wrapped labels: each line is resolved from its own row, because in a steeply
 * scaled chart the line below the anchor can sit in a different cell from the anchor.
 *
 * `base` is the plot background as an opaque colour. On a transparent export there is no painted
 * background, so the caller passes the theme background: the halo then matches what the same chart
 * would look like with one, rather than leaving a light smear over pixels meant to stay see-through.
 */
export function labelHalo(chart: Chart, item: Item, base: string, atY = item.y): string {
  if (item.background) return item.background;
  const at = cellAt(chart, item.x, atY);
  const cell = at ? findCell(chart, at.col, at.row) : undefined;
  if (cell?.color) return compositeOver(cell.color, CELL_FILL_ALPHA, base);
  return base;
}

/** Same colour, ignoring case — the file may hold either form after a hand edit. */
export function sameColor(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeHex(a);
  const nb = normalizeHex(b);
  return na !== null && nb !== null && na === nb;
}

/** Readable text colour for a given background, by relative luminance. */
export function contrastingText(hex: string): string {
  const n = normalizeHex(hex);
  if (!n) return '#000000';
  const r = parseInt(n.slice(1, 3), 16) / 255;
  const g = parseInt(n.slice(3, 5), 16) / 255;
  const b = parseInt(n.slice(5, 7), 16) / 255;
  // Rec. 709 luma; the sRGB gamma correction is deliberately skipped — it only matters for a
  // gradient of many colours, and this picks between two extremes.
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma > 0.55 ? '#1f1f1f' : '#ffffff';
}

/**
 * Modal wrapping Obsidian's colour picker, with the palette shown above it as shortcuts.
 *
 * `null` means cancelled. An empty string means "no colour" — the two are different answers and the
 * caller needs to tell them apart, exactly as with the text prompt.
 */
export class ColorPickerModal extends Modal {
  private value: string;
  private custom: ColorComponent | null = null;
  private resolved = false;

  constructor(
    app: App,
    private readonly title: string,
    initial: string | null,
    private readonly done: (v: string | null) => void,
  ) {
    super(app);
    this.value = normalizeHex(initial) ?? PALETTE[0].hex;
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    const { contentEl } = this;

    const grid = contentEl.createDiv({ cls: 'qc-swatches' });
    for (const sw of PALETTE) {
      const b = grid.createEl('button', { cls: 'qc-swatch' });
      b.style.backgroundColor = sw.hex;
      b.style.color = contrastingText(sw.hex);
      b.setAttribute('aria-label', sw.name);
      b.setAttribute('title', `${sw.name} ${sw.hex}`);
      b.createSpan({ text: sw.name });
      b.addEventListener('click', () => this.finish(sw.hex));
    }

    new Setting(contentEl).setName('Custom colour');
    new Setting(contentEl).addColorPicker((c) => {
      c.setValue(this.value).onChange((v) => { this.value = v; });
      this.custom = c;
    });

    const row = contentEl.createDiv({ cls: 'qc-prompt-row' });
    const ok = row.createEl('button', { text: 'OK' });
    ok.addEventListener('click', () => this.finish(this.value));
    const none = row.createEl('button', { text: 'No colour' });
    none.addEventListener('click', () => this.finish(''));
    const cancel = row.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.finish(null));

    // The picker's own input is left unfocused on purpose: opening a native colour dialog steals
    // focus, and forcing it back afterwards fights the user on some platforms.
    void this.custom;
  }

  onClose(): void {
    if (!this.resolved) this.finish(null);
    this.contentEl.empty();
  }

  private finish(v: string | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.done(v === null ? null : normalizeHex(v) ?? '');
    this.close();
  }
}

/** Promise wrapper, mirroring the plugin's text prompt. */
export function promptColor(app: App, title: string, initial: string | null): Promise<string | null> {
  return new Promise((resolve) => { new ColorPickerModal(app, title, initial, resolve).open(); });
}
