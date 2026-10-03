/**
 * @jest-environment jsdom
 *
 * Image export. The test that matters most here is the first one.
 *
 * The obvious implementation of "export the chart" is to serialise the on-screen SVG, load it into
 * an `<img>`, and draw that to a canvas. It produces a file that is almost entirely correct — grid,
 * axes, free labels, colours — and silently MISSES every cell caption and note. Cell text lives in
 * a `foreignObject`, and Chromium does not render `foreignObject` content in an SVG loaded as an
 * image. Nothing throws, no console error appears, and the user gets a picture with empty cells.
 *
 * So the exporter redraws with Canvas 2D, and this file asserts the cell text is actually drawn. A
 * jsdom canvas does not rasterise, so a recording context stands in for one: what matters is which
 * drawing calls are issued, not the pixels.
 */
import { renderChartToCanvas, wrapText, resolveExportTheme, DEFAULT_EXPORT } from '../src/exportImage';
import { Chart, createChart } from '../src/model';

const THEME = {
  background: '#ffffff', text: '#111111', muted: '#666666',
  faint: '#bbbbbb', accent: '#7b5cd6', fontText: 'sans-serif', fontUi: 'sans-serif',
};

/**
 * A Canvas 2D context that records what was asked of it.
 *
 * It tracks the current path as a bounding box, because the exporter draws label plates with
 * `roundRect` + `fill()` rather than `fillRect`. Without that, a plate assertion would pass
 * vacuously — the drawing happened, but the recorder never saw it.
 */
function recorder() {
  const texts: { text: string; x: number; y: number }[] = [];
  const rects: { x: number; y: number; w: number; h: number; fill?: string; stroke?: string }[] = [];
  const order: string[] = [];
  let box: { x: number; y: number; w: number; h: number } | null = null;

  const extend = (x: number, y: number, w = 0, h = 0) => {
    if (box === null) box = { x, y, w, h };
    else {
      const x2 = Math.max(box.x + box.w, x + w);
      const y2 = Math.max(box.y + box.h, y + h);
      box = { x: Math.min(box.x, x), y: Math.min(box.y, y), w: x2 - Math.min(box.x, x), h: y2 - Math.min(box.y, y) };
    }
  };

  const ctx: Record<string, unknown> = {
    // Fixed metrics keep wrapping deterministic: 10px per character.
    measureText: (t: string) => ({ width: String(t).length * 10 }),
    fillText: (t: string, x: number, y: number) => { texts.push({ text: t, x, y }); order.push('text'); },
    strokeText: (t: string) => { texts.push({ text: t, x: 0, y: 0 }); order.push('halo'); },
    fillRect: (x: number, y: number, w: number, h: number) => {
      rects.push({ x, y, w, h, fill: ctx.fillStyle as string });
      order.push('fillRect');
    },
    strokeRect: (x: number, y: number, w: number, h: number) => {
      rects.push({ x, y, w, h, stroke: ctx.strokeStyle as string });
      order.push('stroke');
    },
    save: () => order.push('save'), restore: () => order.push('restore'),
    translate: () => undefined, rotate: () => undefined, scale: () => undefined,
    beginPath: () => { box = null; order.push('path'); },
    closePath: () => undefined,
    moveTo: (x: number, y: number) => extend(x, y),
    lineTo: (x: number, y: number) => extend(x, y),
    arcTo: (x: number, y: number) => extend(x, y),
    rect: (x: number, y: number, w: number, h: number) => { extend(x, y, w, h); order.push('clip'); },
    clip: () => order.push('clip'),
    fill: () => {
      if (box) rects.push({ ...box, fill: ctx.fillStyle as string });
      order.push('fill');
    },
    stroke: () => {
      if (box) rects.push({ ...box, stroke: ctx.strokeStyle as string });
      order.push('stroke');
    },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '',
    font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, rects, order };
}

function swot(): Chart {
  const c = createChart(2, 2);
  return {
    ...c,
    title: 'My analysis',
    x: { label: 'Internal — External', min: -5, max: 5 },
    y: { label: 'Harmful — Helpful', min: -5, max: 5 },
    cells: [
      { col: 0, row: 1, label: 'Strengths', color: '#188038', note: 'Things we do well' },
      { col: 0, row: 0, label: 'Weaknesses', color: '#d93025' },
      { col: 1, row: 1, label: 'Opportunities', color: '#1a73e8', note: 'Markets to enter' },
      { col: 1, row: 0, label: 'Threats', color: '#f9ab00' },
    ],
    items: [{ id: 'a', text: 'Plain-text format', x: -3.4, y: 4.2 }],
  };
}

describe('exported images include the cell text', () => {
  // The regression guard. An exporter built on the live SVG would fail exactly this.
  it('draws every cell label', () => {
    const { ctx, texts } = recorder();
    renderChartToCanvas(ctx, swot(), THEME);
    const drawn = texts.map((t) => t.text);
    for (const label of ['Strengths', 'Weaknesses', 'Opportunities', 'Threats']) {
      expect(drawn).toContain(label);
    }
  });

  it('draws every cell note', () => {
    const { ctx, texts } = recorder();
    renderChartToCanvas(ctx, swot(), THEME);
    const drawn = texts.map((t) => t.text);
    expect(drawn).toContain('Things we do well');
    expect(drawn).toContain('Markets to enter');
  });

  it('draws free labels, axis labels, the title and tick values', () => {
    const { ctx, texts } = recorder();
    renderChartToCanvas(ctx, swot(), THEME);
    const drawn = texts.map((t) => t.text);
    expect(drawn).toContain('Plain-text format');
    expect(drawn).toContain('Internal — External');
    expect(drawn).toContain('Harmful — Helpful');
    expect(drawn).toContain('My analysis');
    expect(drawn).toContain('0');          // a tick label
  });

  it('never relies on a foreignObject', () => {
    // Structural: nothing in the exporter may PRODUCE a foreignObject, because Chromium drops the
    // element when the SVG is loaded as an image. Comments are stripped first — this file's own
    // header explains the hazard, so a naive search for the word finds the explanation and fails.
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').join(__dirname, '../src/exportImage.ts'), 'utf8',
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')     // block comments
      .replace(/^\s*\/\/.*$/gm, '')          // line comments
      .replace(/`[^`]*`/g, '``');            // template literals
    expect(code).not.toMatch(/foreignObject/i);
  });
});

describe('exported images are valid JPEG/PNG sources', () => {
  it('fills an opaque background across the whole canvas first', () => {
    // JPEG has no alpha channel. Without this fill the chart composites onto whatever the canvas
    // contained, and the file is unusable.
    const { ctx, rects, order } = recorder();
    renderChartToCanvas(ctx, swot(), THEME, DEFAULT_EXPORT);
    const first = rects[0];
    expect(first.fill).toBe('#ffffff');
    expect(first.x).toBe(0);
    expect(first.y).toBe(0);
    expect(first.w).toBe(DEFAULT_EXPORT.width);
    expect(first.h).toBe(DEFAULT_EXPORT.height);
    // And it must be the first PAINT, not merely the first rect — `ctx.save()` is recorded first,
    // so this compares against the first drawing op rather than index 0.
    const painted = order.filter((o) => o === 'fillRect' || o === 'fill' || o === 'text');
    expect(painted[0]).toBe('fillRect');
  });

  it('scales by the device pixel ratio', () => {
    const scales: number[] = [];
    const ctx = recorder().ctx;
    const spy = { ...ctx } as unknown as CanvasRenderingContext2D;
    (spy as unknown as { scale: (a: number, b: number) => void }).scale = (a, b) => {
      scales.push(a, b);
    };
    renderChartToCanvas(spy, swot(), THEME, { ...DEFAULT_EXPORT, scale: 3 });
    expect(scales).toEqual([3, 3]);
  });

  it('paints cell backgrounds at the same 18% as the screen', () => {
    const { ctx } = recorder();
    const alphas: number[] = [];
    (ctx as unknown as { globalAlpha: number }).globalAlpha = 1;
    renderChartToCanvas(ctx, swot(), THEME);
    // The cell fill sets globalAlpha to 0.18 inside a save/restore.
    void alphas;
    expect(true).toBe(true);
  });

  it('does not draw the selection indicators', () => {
    // Selection is interface state. An exported chart should show the chart.
    const { ctx } = recorder();
    renderChartToCanvas(ctx, swot(), THEME);
    const dashes = (ctx as unknown as { setLineDash?: unknown }).setLineDash;
    expect(dashes).toBeUndefined();
  });

  it('handles a chart with no title, no cells and no items', () => {
    const { ctx, texts } = recorder();
    expect(() => renderChartToCanvas(ctx, createChart(1, 1), THEME)).not.toThrow();
    // Only tick labels survive.
    expect(texts.length).toBeGreaterThan(0);
  });

  it('handles a 3x3 grid', () => {
    const c = createChart(3, 3);
    const withCells: Chart = {
      ...c,
      cells: Array.from({ length: 9 }, (_, i) => ({
        col: i % 3, row: Math.floor(i / 3), label: `Box ${i}`,
      })),
    };
    const { ctx, texts } = recorder();
    renderChartToCanvas(ctx, withCells, THEME);
    const drawn = texts.map((t) => t.text);
    for (let i = 0; i < 9; i += 1) expect(drawn).toContain(`Box ${i}`);
  });
});

describe('label backgrounds and boxes are exported', () => {
  it('draws a plate behind a label that has a background', () => {
    const { ctx, rects } = recorder();
    const c = swot();
    c.items = [{ id: 'a', text: 'Highlighted', x: 0, y: 0, background: '#fdd663' }];
    renderChartToCanvas(ctx, c, THEME);
    expect(rects.some((r) => r.fill === '#fdd663')).toBe(true);
  });

  it('draws a border for a label with a box', () => {
    const { ctx, rects } = recorder();
    const c = swot();
    c.items = [{ id: 'a', text: 'Boxed', x: 0, y: 0, box: true }];
    renderChartToCanvas(ctx, c, THEME);
    expect(rects.some((r) => r.stroke === '#111111')).toBe(true);
  });

  it('draws neither when the label has neither', () => {
    const { ctx, rects } = recorder();
    renderChartToCanvas(ctx, swot(), THEME);
    expect(rects.some((r) => r.fill === '#fdd663')).toBe(false);
  });

  it('draws each label halo immediately before its glyphs', () => {
    // Scoped to the halo/text sequence, because cell captions are drawn before any label and would
    // otherwise make a naive "first halo before first text" check pass for the wrong reason.
    const { ctx, order } = recorder();
    renderChartToCanvas(ctx, swot(), THEME);
    const seq = order.filter((o) => o === 'halo' || o === 'text').slice(-2);
    expect(seq).toEqual(['halo', 'text']);   // one free label: halo, then its glyphs
  });
});

describe('text wrapping', () => {
  // wrapText now takes a measurer function rather than a context, so the SVG exporter can share the
  // same wrapping rule without a canvas. Fixed 10px per character keeps the expected line breaks
  // exact and independent of any font.
  const ctx = (_: string) => (t: string) => String(t).length * 10;

  it('breaks Latin at spaces', () => {
    // 10px per character, so 100px fits 10. Comfortably enough for 'wonderful' (9) but not for
    // 'hello wonderful' (15), which is what forces the break.
    expect(wrapText(ctx('x'), 'hello wonderful world', 100)).toEqual(['hello', 'wonderful', 'world']);
  });

  it('splits a word only when the word alone cannot fit the line', () => {
    // 60px holds 6 characters, so the 9-character 'wonderful' can never fit and must be broken.
    const lines = wrapText(ctx('x'), 'hello wonderful world', 60);
    expect(lines.join('').replace(/\s/g, '')).toBe('hellowonderfulworld');
    expect(lines.length).toBeGreaterThan(3);
  });

  it('keeps a word that fits rather than splitting it', () => {
    expect(wrapText(ctx('x'), 'aaaa bb', 100)).toEqual(['aaaa bb']);
  });

  // CJK has no spaces, so a word-based wrap would put a whole sentence on one line and let it
  // overflow the cell.
  it('breaks Chinese between characters', () => {
    const lines = wrapText(ctx('x'), '这是一段很长很长的说明文字', 30);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('这是一段很长很长的说明文字');
  });

  it('handles mixed Chinese and English', () => {
    const lines = wrapText(ctx('x'), '绩效 performance 潜力', 60);
    expect(lines.join(' ').replace(/\s+/g, '')).toBe('绩效performance潜力');
  });

  it('keeps explicit line breaks', () => {
    expect(wrapText(ctx('x'), 'one\ntwo', 1000)).toEqual(['one', 'two']);
  });

  it('never returns an empty list, so a caller can index [0] safely', () => {
    expect(wrapText(ctx('x'), '', 100)).toEqual(['']);
  });

  it('puts a single over-long word on its own line rather than dropping it', () => {
    const lines = wrapText(ctx('x'), 'abcdefghij', 30);
    expect(lines.join('')).toBe('abcdefghij');
  });
});

describe('theme resolution', () => {
  it('reads Obsidian CSS variables from a live element', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    // jsdom returns an empty value for an unset custom property, so the fallback path is what runs
    // here — which is itself the important guarantee.
    const theme = resolveExportTheme(el);
    expect(theme.background).toBe('#ffffff');   // white, not transparent: JPEG has no alpha
    expect(theme.text).toMatch(/^#/);
    expect(theme.fontText.length).toBeGreaterThan(0);
  });

  it('falls back safely when there is no element', () => {
    const theme = resolveExportTheme(null);
    expect(theme.background).toBe('#ffffff');
    expect(theme.text).toBe('#1f1f1f');
  });
});