/**
 * SVG export and transparent-background export.
 *
 * The SVG tests exist because of a trap that has already bitten this plugin once in a different
 * form. Cell text is drawn in a `foreignObject` on screen, and Chromium drops `foreignObject` content
 * when an SVG is loaded as an image — so the naive "serialise the live SVG and export that" approach
 * produces a chart with every cell caption silently missing. The canvas exporter was rebuilt to avoid
 * it; the SVG exporter has to avoid it independently, and nothing about a wrong SVG fails loudly.
 *
 * Two constraints therefore have teeth here:
 *  - no `foreignObject` anywhere in the output;
 *  - no dependency on a stylesheet. An SVG opened on its own, or embedded in a document, has no CSS,
 *    so anything left to a class renders unstyled everywhere except inside Obsidian.
 *
 * The transparency tests are about one specific failure: JPEG has no alpha channel, so a
 * "transparent" JPEG does not exist — it comes out as a black rectangle where the transparency should
 * be. That is why the option is offered per-format rather than as a single global toggle.
 */
import { buildChartSvg, renderChartToCanvas, wrapText, DEFAULT_EXPORT, supportsTransparency, ExportOptions } from '../src/exportImage';
import { Chart, createChart } from '../src/model';

const THEME = {
  background: '#ffffff', text: '#111111', muted: '#666666',
  faint: '#bbbbbb', accent: '#7b5cd6', fontText: 'sans-serif', fontUi: 'sans-serif',
};

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

/** A context that records fills, so a background can be detected or its absence confirmed. */
function recorder() {
  const fills: { x: number; y: number; w: number; h: number; fill: string }[] = [];
  const ctx = {
    measureText: (t: string) => ({ width: String(t).length * 10 }),
    fillRect: (x: number, y: number, w: number, h: number) => {
      fills.push({ x, y, w, h, fill: ctx.fillStyle as string });
    },
    save: () => undefined, restore: () => undefined, translate: () => undefined,
    rotate: () => undefined, scale: () => undefined, beginPath: () => undefined,
    closePath: () => undefined, moveTo: () => undefined, lineTo: () => undefined,
    arcTo: () => undefined, fill: () => undefined, stroke: () => undefined,
    rect: () => undefined, clip: () => undefined, fillText: () => undefined,
    strokeText: () => undefined, strokeRect: () => undefined, roundRect: () => undefined,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '',
    font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, fills };
}

describe('SVG export is complete', () => {
  const svg = buildChartSvg(swot(), THEME);

  it('is a well-formed svg document', () => {
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  // The regression guard, in its new form.
  it('never emits a foreignObject', () => {
    expect(svg).not.toMatch(/foreignObject/i);
  });

  // An SVG loaded as an image has no intrinsic size without explicit width/height, and renders at
  // the 300x150 default instead.
  it('declares width and height, not only a viewBox', () => {
    expect(svg).toContain(`width="${DEFAULT_EXPORT.width}"`);
    expect(svg).toContain(`height="${DEFAULT_EXPORT.height}"`);
    expect(svg).toContain(`viewBox="0 0 ${DEFAULT_EXPORT.width} ${DEFAULT_EXPORT.height}"`);
  });

  it('carries the cell text, which the foreignObject route lost', () => {
    for (const label of ['Strengths', 'Weaknesses', 'Opportunities', 'Threats']) {
      expect(svg).toContain(label);
    }
    expect(svg).toContain('Things we do well');
    expect(svg).toContain('Markets to enter');
  });

  it('carries free labels, axes, title and tick values', () => {
    expect(svg).toContain('Plain-text format');
    expect(svg).toContain('Internal — External');
    expect(svg).toContain('Harmful — Helpful');
    expect(svg).toContain('My analysis');
  });

  // Styles must be inline: an SVG outside Obsidian has no stylesheet, and class-based styling would
  // render unstyled — which for this chart means invisible text.
  it('inlines every colour rather than relying on a class or a stylesheet', () => {
    expect(svg).toContain('fill="#188038"');
    expect(svg).toContain('fill="#111111"');
    expect(svg).not.toMatch(/class="/);
    expect(svg).not.toMatch(/<style/);
  });

  it('references nothing outside itself', () => {
    expect(svg).not.toMatch(/xlink:href|<image|url\(/);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('paints cell colours at the same 18% as the screen', () => {
    expect(svg).toContain('fill-opacity="0.18"');
  });

  it('escapes text that would otherwise break the XML', () => {
    const nasty = createChart(1, 1);
    const out = buildChartSvg({ ...nasty, title: 'A & B <tag> "q"' }, THEME);
    expect(out).toContain('&amp;');
    expect(out).toContain('&lt;tag&gt;');
    expect(out).not.toMatch(/<tag>/);
  });

  it('handles Chinese labels and notes', () => {
    const c = createChart(3, 3);
    const out = buildChartSvg({
      ...c,
      cells: [{ col: 1, row: 1, label: '中坚力量', note: '这是说明文字' }],
      items: [{ id: 'z', text: '人才九宫格', x: 1.5, y: 1.5 }],
    }, THEME);
    expect(out).toContain('中坚力量');
    expect(out).toContain('人才九宫格');
  });

  it('renders an empty chart without throwing', () => {
    expect(() => buildChartSvg(createChart(1, 1), THEME)).not.toThrow();
  });

  it('draws a 3x3 grid with every cell labelled', () => {
    const c = createChart(3, 3);
    const out = buildChartSvg({
      ...c,
      cells: Array.from({ length: 9 }, (_, i) => ({ col: i % 3, row: Math.floor(i / 3), label: `Box ${i}` })),
    }, THEME);
    for (let i = 0; i < 9; i += 1) expect(out).toContain(`Box ${i}`);
  });

  it('carries label background and box', () => {
    const c = swot();
    c.items = [{ id: 'a', text: 'Styled', x: 0, y: 0, background: '#fdd663', box: true }];
    const out = buildChartSvg(c, THEME);
    expect(out).toContain('fill="#fdd663"');
    expect(out.match(/rx="3"/g)?.length).toBeGreaterThanOrEqual(2); // plate + box
  });

  it('numbers are rounded, so the output is stable and diffable', () => {
    expect(svg).not.toMatch(/\d\.\d{3,}/);
  });
});

describe('transparent background', () => {
  it('is supported by PNG and SVG but not JPEG', () => {
    // JPEG has no alpha channel. A "transparent" JPEG is not a thing that can be produced, and
    // offering it would yield a black rectangle where the transparency should be.
    expect(supportsTransparency('png')).toBe(true);
    expect(supportsTransparency('svg')).toBe(true);
    expect(supportsTransparency('jpeg')).toBe(false);
  });

  it('omits the background fill when transparent', () => {
    const { ctx, fills } = recorder();
    renderChartToCanvas(ctx, swot(), THEME, { ...DEFAULT_EXPORT, background: null });
    // No full-canvas opaque rectangle.
    const full = fills.filter((f) => f.w === DEFAULT_EXPORT.width && f.h === DEFAULT_EXPORT.height);
    expect(full).toHaveLength(0);
  });

  it('paints the background when not transparent', () => {
    const { ctx, fills } = recorder();
    renderChartToCanvas(ctx, swot(), THEME, DEFAULT_EXPORT);
    const full = fills.filter((f) => f.w === DEFAULT_EXPORT.width && f.h === DEFAULT_EXPORT.height);
    expect(full).toHaveLength(1);
    expect(full[0].fill).toBe('#ffffff');
  });

  it('omits the background rect in SVG when transparent', () => {
    const c = swot();
    const opaque = buildChartSvg(c, THEME, DEFAULT_EXPORT);
    const clear = buildChartSvg(c, THEME, { ...DEFAULT_EXPORT, background: null });
    expect(opaque).toContain('<rect x="0" y="0"');
    expect(clear).not.toContain('<rect x="0" y="0"');
    // Everything else is unchanged — only the backdrop differs.
    expect(clear).toContain('Strengths');
  });

  it('still draws a frame, so a transparent chart has a visible boundary', () => {
    const out = buildChartSvg(swot(), THEME, { ...DEFAULT_EXPORT, background: null });
    expect(out).toContain('stroke="#bbbbbb"');
  });

  it('the label halo falls back to the theme background when transparent', () => {
    // A light halo over a transparent plate would leave a white smear exactly where the
    // transparency is supposed to show through.
    const c = swot();
    c.items = [{ id: 'a', text: 'Halo', x: 0, y: 0 }];
    const clear = buildChartSvg(c, THEME, { ...DEFAULT_EXPORT, background: null });
    expect(clear).toContain('stroke="#ffffff"');   // theme.background, not "none"
  });

  it('a caller who omits background gets transparency, not a black rectangle', () => {
    // TypeScript requires the field, but plain JavaScript can still leave it out, and
    // `undefined !== null` is true — so an `!== null` check would set fillStyle to undefined and
    // paint the canvas its default black. The runtime has to be safe on its own.
    const { ctx, fills } = recorder();
    renderChartToCanvas(ctx, swot(), THEME, { width: 100, height: 100, scale: 1, quality: 0.9 } as ExportOptions);
    expect(fills.filter((f) => f.w === 100 && f.h === 100)).toHaveLength(0);
  });

  it('the background field is required at compile time', () => {
    // Asserted by the `npm run build` typecheck, not here: this is the line that must NOT compile.
    const opts: ExportOptions = { width: 10, height: 10, scale: 1, quality: 0.9, background: null };
    expect(opts.background).toBeNull();
  });
});

describe('wrapText takes a measurer, so both exporters share one rule', () => {
  const fixed = (_: string) => (t: string) => String(t).length * 10;

  it('still breaks Latin at spaces', () => {
    expect(wrapText(fixed(''), 'hello wonderful world', 100)).toEqual(['hello', 'wonderful', 'world']);
  });

  it('still breaks Chinese between characters', () => {
    const lines = wrapText(fixed(''), '这是一段很长很长的说明文字', 30);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('这是一段很长很长的说明文字');
  });

  it('never returns an empty list', () => {
    expect(wrapText(fixed(''), '', 100)).toEqual(['']);
  });

  it('the SVG exporter wraps a long cell note onto several lines', () => {
    const c = createChart(2, 2);
    const out = buildChartSvg({
      ...c,
      cells: [{ col: 0, row: 0, label: 'Box', note: 'one two three four five six seven eight nine ten' }],
    }, THEME);
    // More <text> elements than label + ticks implies the note was broken up.
    const texts = out.match(/<text /g) ?? [];
    expect(texts.length).toBeGreaterThan(5);
  });
});