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
