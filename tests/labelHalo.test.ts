/**
 * @jest-environment jsdom
 *
 * The label halo.
 *
 * A halo exists to keep a label legible where it crosses a grid line or another label. That only works
 * if the halo is the colour of the surface immediately behind the glyphs. When it was the page
 * background instead, every label sitting in a tinted cell wore a white ring, which reads as a drop
 * shadow — the SVG export's most visible flaw.
 *
 * The regression these guard against is subtle: the halo was a *plausible* colour (the page background
 * is genuinely behind the plot) so nothing looked broken in a test that only checked "a stroke
 * exists". What matters is that it equals the composite of the cell tint over that background.
 */
import { buildChartSvg } from '../src/exportImage';
import { compositeOver, CELL_FILL_ALPHA } from '../src/colorUi';
import { Chart, createChart } from '../src/model';

const THEME = {
  background: '#ffffff', text: '#1f1f1f', muted: '#5c5c5c',
  faint: '#b0b0b0', accent: '#7b5cd6', fontText: 'sans-serif', fontUi: 'sans-serif',
};

const OPTS = { width: 1400, height: 900, scale: 2, quality: 0.92, background: '#ffffff' } as const;

/** 2×2 grid: cell (0,0) red, cell (1,1) blue, the other two left uncoloured. */
function chartWithTintedCells(): Chart {
  const c = createChart(2, 2);
  return {
    ...c,
    x: { label: 'X', min: 0, max: 10 },
    y: { label: 'Y', min: 0, max: 10 },
    cells: [
      { col: 0, row: 0, label: 'Red cell', color: '#d93025' },
      { col: 1, row: 1, label: 'Blue cell', color: '#1a73e8' },
    ],
    items: [
      { id: 'inRed', text: 'Sits in the red cell', x: 2.5, y: 2.5 },
      { id: 'inBlue', text: 'Sits in the blue cell', x: 7.5, y: 7.5 },
      { id: 'uncoloured', text: 'Sits in an uncoloured cell', x: 7.5, y: 2.5 },
      { id: 'plated', text: 'Has its own plate', x: 2.5, y: 7.5, background: '#fdd663' },
    ],
  };
}

/** The `stroke` on the `<text>` element carrying `id`'s text. */
function haloOf(svg: string, id: string): string {
  const chart = chartWithTintedCells();
  const text = chart.items.find((i) => i.id === id)!.text;
  const el = svg.match(new RegExp(`<text[^>]*>${text}</text>`));
  if (!el) throw new Error(`no <text> for ${id}`);
  const stroke = /stroke="([^"]*)"/.exec(el[0]);
  if (!stroke) throw new Error(`${id} has no stroke at all`);
  return stroke[1];
}

describe('the halo matches the surface behind the label', () => {
  const svg = buildChartSvg(chartWithTintedCells(), THEME, OPTS);

  it('is the cell tint blended over the background, for a label in a tinted cell', () => {
    expect(haloOf(svg, 'inRed')).toBe(compositeOver('#d93025', CELL_FILL_ALPHA, '#ffffff'));
  });

  it('is not the page background — that was the visible white ring', () => {
    expect(haloOf(svg, 'inRed')).not.toBe('#ffffff');
    expect(haloOf(svg, 'inBlue')).not.toBe('#ffffff');
  });

  it('differs between two differently tinted cells', () => {
    expect(haloOf(svg, 'inRed')).not.toBe(haloOf(svg, 'inBlue'));
  });

  it('is the plain background for a label in an uncoloured cell', () => {
    expect(haloOf(svg, 'uncoloured')).toBe('#ffffff');
  });

  it("is the label's own plate when it has one, since that covers the cell", () => {
    expect(haloOf(svg, 'plated')).toBe('#fdd663');
  });

  it('differs from the same label exported on a dark background', () => {
    const dark = buildChartSvg(chartWithTintedCells(), { ...THEME, background: '#1e1e1e' },
      { ...OPTS, background: '#1e1e1e' });
    expect(haloOf(dark, 'inRed')).toBe(compositeOver('#d93025', CELL_FILL_ALPHA, '#1e1e1e'));
    expect(haloOf(dark, 'inRed')).not.toBe(haloOf(svg, 'inRed'));
  });

  it('follows the theme background on a transparent export, not a fixed white', () => {
    // No background is painted, so the blend is taken against the theme colour the chart would have
    // had. A hard-coded light halo here would leave a white smear over the transparency.
    const clear = buildChartSvg(chartWithTintedCells(), { ...THEME, background: '#1e1e1e' },
      { ...OPTS, background: null });
    expect(haloOf(clear, 'inRed')).toBe(compositeOver('#d93025', CELL_FILL_ALPHA, '#1e1e1e'));
  });
});

describe('the halo survives the fill alpha being changed', () => {
  it('is computed from CELL_FILL_ALPHA, not a second copy of 0.18', () => {
    const svg = buildChartSvg(chartWithTintedCells(), THEME, OPTS);
    const fillAlpha = /fill-opacity="([\d.]+)"/.exec(svg);
    expect(fillAlpha).not.toBeNull();
    // If these ever diverge, every label in a tinted cell grows a ring — so pin them together.
    expect(Number(fillAlpha![1])).toBe(CELL_FILL_ALPHA);
  });
});

describe('compositeOver', () => {
  it('returns the tint at full strength over itself', () => {
    expect(compositeOver('#d93025', 1, '#ffffff')).toBe('#d93025');
  });

  it('returns the background at zero strength', () => {
    expect(compositeOver('#d93025', 0, '#ffffff')).toBe('#ffffff');
  });

  it('is a real blend, not one of the two inputs', () => {
    const mid = compositeOver('#d93025', CELL_FILL_ALPHA, '#ffffff');
    expect(mid).not.toBe('#d93025');
    expect(mid).not.toBe('#ffffff');
  });

  it('falls back to the background when the tint is missing or unparseable', () => {
    expect(compositeOver(null, 0.18, '#ffffff')).toBe('#ffffff');
    expect(compositeOver('not-a-colour', 0.18, '#ffffff')).toBe('#ffffff');
    expect(compositeOver(undefined, 0.18, '#ffffff')).toBe('#ffffff');
  });

  it('handles a dark background without wrapping a channel', () => {
    const out = compositeOver('#ffffff', 0.5, '#000000');
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
    expect(out).toBe('#808080');
  });
});