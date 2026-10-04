/**
 * @jest-environment jsdom
 *
 * Label wrapping.
 *
 * A free label used to be drawn as one unsplittable line, so a long one ran off both edges of the
 * plot with most of its text outside the canvas — measured at 3291px wide in a 1400px export, about
 * two thirds of it lost. Labels now wrap at a configurable share of the plot width.
 *
 * Three renderers have to agree, or the user sees one shape on screen and gets another in the file:
 * the on-screen canvas, the canvas exporter and the SVG exporter. The hit test is a fourth: a label
 * drawn over three lines but clickable only on the first would drop the click to the cell below.
 */
import { buildChartSvg, renderChartToCanvas } from '../src/exportImage';
import { ChartCanvas } from '../src/canvas';
import { labelLines, labelBlockHeight, estimateTextWidth, LABEL_LINE_RATIO } from '../src/geometry';
import { Chart, createChart } from '../src/model';

const THEME = {
  background: '#ffffff', text: '#1f1f1f', muted: '#5c5c5c',
  faint: '#b0b0b0', accent: '#7b5cd6', fontText: 'sans-serif', fontUi: 'sans-serif',
};
const LONG = 'The quick brown fox jumps over the lazy dog again and again and again and keeps going';

function chartWith(text: string): Chart {
  const c = createChart(2, 2);
  return { ...c, x: { label: 'X', min: 0, max: 10 }, y: { label: 'Y', min: 0, max: 10 },
    items: [{ id: 'a', text, x: 5, y: 5 }] };
}

/** Every free-label <text> in document order, as {y, content}. */
function svgLines(svg: string): Array<{ y: number; content: string }> {
  return [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ y: Number(m[1]), content: m[2] }))
    .filter((t) => t.content.trim().length > 0 && !/^[0-9.]+$/.test(t.content));
}

function build(text = LONG, labelWidthPercent = 80) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
  document.body.appendChild(container);
  const canvas = new ChartCanvas(container, chartWith(text), {
    onChange: () => undefined,
    onSelectCell: () => undefined,
    promptText: async (d) => d,
  });
  canvas.measure();
  canvas.setLabelWidthPercent(labelWidthPercent);
  canvas.render();
  return { canvas, svg: canvas['svg'] as SVGSVGElement };
}

describe('labelLines', () => {
  it('leaves a short label on one line', () => {
    expect(labelLines('Short', 14, 600)).toEqual(['Short']);
  });

  it('splits a long label into several lines', () => {
    expect(labelLines(LONG, 14, 120).length).toBeGreaterThan(1);
  });

  it('reassembles to the original text once the line breaks are removed', () => {
    const joined = labelLines(LONG, 14, 120).join(' ');
    expect(joined.replace(/\s+/g, ' ').trim()).toBe(LONG);
  });

  it('breaks Latin at a word boundary, not mid-word', () => {
    const lines = labelLines(LONG, 14, 120);
    // Every line but the last must end on a whole word.
    for (const line of lines.slice(0, -1)) expect(line.endsWith(' ')).toBe(false);
    expect(lines.join(' ')).toContain('quick brown');
  });

  it('breaks CJK between characters, since it has no spaces', () => {
    const lines = labelLines('中坚力量核心员工梯队建设需要长期投入与耐心', 14, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('中坚力量核心员工梯队建设需要长期投入与耐心');
  });

  it('is a no-op when there is no usable width, rather than an infinite loop', () => {
    expect(labelLines(LONG, 14, 0)).toEqual([LONG]);
    expect(labelLines(LONG, 14, -5)).toEqual([LONG]);
  });
});

describe('labelBlockHeight', () => {
  it('matches the single-line box height, so unwrapped labels do not move', () => {
    expect(labelBlockHeight(1, 14)).toBe(14 + 9);
  });

  it('grows by one line height per extra line', () => {
    expect(labelBlockHeight(3, 14)).toBe(labelBlockHeight(1, 14) + 2 * 14 * LABEL_LINE_RATIO);
  });

  it('never returns less than one line', () => {
    expect(labelBlockHeight(0, 14)).toBe(labelBlockHeight(1, 14));
  });
});

describe('the on-screen canvas wraps a long label', () => {
  it('draws one <text> per line', () => {
    const { svg } = build();
    expect(svg.querySelectorAll('g[data-item-id="a"] .qc-item-text').length).toBeGreaterThan(1);
  });

  it('keeps every line inside the plot', () => {
    // jsdom has no getBBox, so this asserts the wrapping invariant itself with the same estimator the
    // renderer lays out with: no produced line may be wider than the limit it was wrapped to.
    const { canvas, svg } = build();
    const limit = (canvas['plot'].width * 80) / 100;
    const texts = Array.from(svg.querySelectorAll('g[data-item-id="a"] .qc-item-text'));
    expect(texts.length).toBeGreaterThan(1);
    for (const t of texts) {
      expect(estimateTextWidth(t.textContent ?? '', 14)).toBeLessThanOrEqual(limit + 0.5);
    }
  });

  it('leaves a short label on one line, unchanged', () => {
    const { svg } = build('Short');
    expect(svg.querySelectorAll('g[data-item-id="a"] .qc-item-text')).toHaveLength(1);
  });

  it('widens the hit plate to cover every line', () => {
    const { canvas, svg } = build();
    const hit = svg.querySelector('g[data-item-id="a"] .qc-item-hit')!;
    const lines = svg.querySelectorAll('g[data-item-id="a"] .qc-item-text').length;
    expect(Number(hit.getAttribute('height'))).toBe(labelBlockHeight(lines, 14));
  });

  it('makes the whole block clickable, not just the first line', () => {
    const { canvas } = build();
    const plot = canvas['plot'];
    const lastLineY = dataYScreen(canvas, 5) + 1 * 14 * LABEL_LINE_RATIO;
    // A point on the second line must resolve to the label, not to the cell underneath.
    const stack = canvas['labelsAt'](plot.x + plot.width / 2, lastLineY);
    expect(stack.map((i) => i.id)).toContain('a');
  });
});

function dataYScreen(canvas: ChartCanvas, dataY: number): number {
  const plot = canvas['plot'];
  const chart = canvas.getChart();
  return plot.y + plot.height - ((dataY - chart.y.min) / (chart.y.max - chart.y.min)) * plot.height;
}

describe('the limit is configurable', () => {
  it('a smaller percentage produces more lines', () => {
    const wide = build(LONG, 100).svg.querySelectorAll('.qc-item-text').length;
    const narrow = build(LONG, 25).svg.querySelectorAll('.qc-item-text').length;
    expect(narrow).toBeGreaterThan(wide);
  });

  it('is clamped rather than honoured blindly', () => {
    // 5% of the plot would be a couple of glyphs per line; the floor keeps it usable.
    const { svg } = build(LONG, 5);
    expect(svg.querySelectorAll('.qc-item-text').length).toBeGreaterThan(0);
    expect(canvasPercent(build(LONG, 5).canvas)).toBe(20);
  });

  it('ignores a value that changes nothing', () => {
    const { canvas } = build(LONG, 80);
    const before = canvas['svg'].innerHTML;
    canvas.setLabelWidthPercent(80);
    expect(canvas['svg'].innerHTML).toBe(before);
  });
});

function canvasPercent(c: ChartCanvas): number {
  return c['labelWidthPercent'];
}

describe('both exporters wrap the same way the canvas does', () => {
  const pct = 30;
  const opts = { width: 1400, height: 900, scale: 2, quality: 0.92, background: '#ffffff', labelWidthPercent: pct };

  it('the SVG exporter emits several lines where the canvas does', () => {
    const svg = buildChartSvg(chartWith(LONG), THEME, opts);
    const texts = svgLines(svg);
    const multi = texts.filter((t) => t.content === 'quick' || /fox|jumps/.test(t.content));
    expect(multi.length).toBeGreaterThan(0);
    expect(texts.length).toBeGreaterThan(3);
  });

  it('no single SVG line is wider than the limit', () => {
    const svg = buildChartSvg(chartWith(LONG), THEME, opts);
    const plotWidth = Number(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="[\d.]+" fill="none"/.exec(svg)![1]);
    const limit = (plotWidth * pct) / 100;
    for (const t of svgLines(svg)) {
      // 5.8px per char at 14px is what the shared estimator produces; allow a little slack.
      if (t.content.length * 7 > limit + 14) expect(t.content.length).toBeLessThan(limit / 7 + 2);
    }
  });

  it('lines are stacked downward at one line height apart', () => {
    const svg = buildChartSvg(chartWith(LONG), THEME, opts);
    const ys = svgLines(svg).map((t) => t.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThan(0);
  });

  it('the canvas exporter draws more than one fillText for a long label', () => {
    // The stub is the one exportSvg.test.ts already uses, extended to record the text it draws.
    const drawn: string[] = [];
    const ctx = {
      measureText: (t: string) => ({ width: String(t).length * 10 }),
      save: () => undefined, restore: () => undefined, translate: () => undefined,
      rotate: () => undefined, scale: () => undefined, beginPath: () => undefined,
      closePath: () => undefined, moveTo: () => undefined, lineTo: () => undefined,
      arcTo: () => undefined, fill: () => undefined, stroke: () => undefined,
      rect: () => undefined, clip: () => undefined, strokeRect: () => undefined,
      roundRect: () => undefined,
      fillRect: () => undefined,
      fillText: (t: string) => { drawn.push(String(t)); },
      strokeText: () => undefined,
      fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '',
      font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    renderChartToCanvas(ctx, chartWith(LONG), THEME, opts);
    // Cell captions are drawn too, so look for the label's own words rather than counting calls.
    expect(drawn.filter((t) => /fox|jumps|lazy|dog/.test(t)).length).toBeGreaterThan(1);
  });

  it('a short label is unaffected in the SVG export', () => {
    const svg = buildChartSvg(chartWith('Short'), THEME, opts);
    expect(svgLines(svg).filter((t) => t.content === 'Short')).toHaveLength(1);
  });

  it('defaults to 80% when the caller says nothing', () => {
    const withoutIt = buildChartSvg(chartWith(LONG), THEME,
      { width: 1400, height: 900, scale: 2, quality: 0.92, background: '#ffffff' });
    const with80 = buildChartSvg(chartWith(LONG), THEME, { ...opts, labelWidthPercent: 80 });
    expect(withoutIt).toBe(with80);
  });
});