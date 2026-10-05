/**
 * @jest-environment jsdom
 *
 * Axis notes.
 *
 * A note is a line drawn beside an axis saying what the scale actually is — where the numbers came
 * from, what the score measures. It is the one piece of context a quadrant chart cannot live without
 * and that a cell note is the wrong place for: the cell says what is in it, the axis says what the
 * whole scale means.
 *
 * What this file really guards is the margin. The note is drawn outside the plot, in space the chart
 * has to explicitly reserve — so the same rule has to hold in three renderers and in the writer, or
 * a note is invisible on screen and present in the file, or clipped off the bottom of an export.
 */
import { buildChartSvg } from '../src/exportImage';
import { ChartCanvas } from '../src/canvas';
import { chartToFileText, parseChartFromText } from '../src/mdx';
import {
  AXIS_CAPTION_DX, AXIS_CAPTION_DY, AXIS_NOTE_DX, AXIS_NOTE_DY, AXIS_NOTE_BOTTOM,
  AXIS_NOTE_LEFT, AXIS_NOTE_SIZE, DEFAULT_MARGINS, marginsFor,
} from '../src/geometry';
import { Chart, createChart } from '../src/model';

const THEME = {
  background: '#ffffff', text: '#1f1f1f', muted: '#5c5c5c',
  faint: '#b0b0b0', accent: '#7b5cd6', fontText: 'sans-serif', fontUi: 'sans-serif',
};
const OPTS = { width: 1400, height: 900, scale: 2, quality: 0.92, background: '#ffffff' } as const;

function chartWith(xNote?: string, yNote?: string): Chart {
  const c = createChart(2, 2);
  const out: Chart = { ...c, x: { ...c.x, label: 'X' }, y: { ...c.y, label: 'Y' } };
  if (xNote !== undefined) out.x.note = xNote;
  if (yNote !== undefined) out.y.note = yNote;
  return out;
}

function build(chart: Chart) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
  document.body.appendChild(container);
  const canvas = new ChartCanvas(container, chart, {
    onChange: () => undefined,
    onSelectCell: () => undefined,
    promptText: async (d) => d,
  });
  canvas.measure();
  canvas.render();
  return { canvas, svg: canvas['svg'] as SVGSVGElement };
}

/**
 * The text of every note element, in document order.
 *
 * Matched on the class, not the font size: tick labels are also 11px, so a size-based match would
 * sweep up every number on the axes.
 */
function notesIn(svg: string): string[] {
  return [...svg.matchAll(/<text class="qc-axis-note"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}

describe('a chart without notes keeps the layout it always had', () => {
  it('uses the default margins', () => {
    expect(marginsFor(chartWith())).toEqual(DEFAULT_MARGINS);
  });

  it('writes no note key at all', () => {
    expect(chartToFileText(chartWith(), 'body')).not.toContain('note:');
  });

  it('draws no note element on screen', () => {
    const { svg } = build(chartWith());
    expect(svg.querySelectorAll('.qc-axis-note')).toHaveLength(0);
  });

  it('draws no note element in the SVG export', () => {
    expect(notesIn(buildChartSvg(chartWith(), THEME, OPTS))).toHaveLength(0);
  });
});

describe('the margin is reserved only for the axis that has a note', () => {
  it('grows the bottom for an x note', () => {
    expect(marginsFor(chartWith('x only')).bottom).toBe(AXIS_NOTE_BOTTOM);
    expect(marginsFor(chartWith('x only')).left).toBe(DEFAULT_MARGINS.left);
  });

  it('grows the left for a y note', () => {
    expect(marginsFor(chartWith(undefined, 'y only')).left).toBe(AXIS_NOTE_LEFT);
    expect(marginsFor(chartWith(undefined, 'y only')).bottom).toBe(DEFAULT_MARGINS.bottom);
  });

  it('grows both when both have one', () => {
    const m = marginsFor(chartWith('a', 'b'));
    expect(m.bottom).toBe(AXIS_NOTE_BOTTOM);
    expect(m.left).toBe(AXIS_NOTE_LEFT);
  });

  it('leaves the other two margins alone', () => {
    const m = marginsFor(chartWith('a', 'b'));
    expect(m.top).toBe(DEFAULT_MARGINS.top);
    expect(m.right).toBe(DEFAULT_MARGINS.right);
  });
});

describe('the canvas re-measures when a note is set or cleared', () => {
  it('a note added after the first draw still gets its room', () => {
    const { canvas } = build(chartWith());
    const before = canvas['plot'].height;
    // The failure this guards: render() drew with a plot computed before the note existed, so the note
    // landed outside the plot it had been given margin for.
    canvas.setAxis('x', { note: 'added later' });
    expect(canvas['plot'].height).toBeLessThan(before);
  });

  it('clearing the note gives the room back', () => {
    const { canvas } = build(chartWith('has one'));
    const withNote = canvas['plot'].height;
    canvas.setAxis('x', { note: undefined });
    expect(canvas['plot'].height).toBeGreaterThan(withNote);
  });

  it('returns exactly to the no-note plot', () => {
    const plain = build(chartWith()).canvas['plot'];
    const noted = build(chartWith('a', 'b')).canvas['plot'];
    expect(noted.height).toBeLessThan(plain.height);
    expect(noted.width).toBeLessThan(plain.width);
  });
});

describe('all three renderers draw the note', () => {
  const chart = chartWith('under x', 'beside y');

  it('the on-screen canvas draws one per axis, at the shared size', () => {
    const { svg } = build(chart);
    const els = Array.from(svg.querySelectorAll('.qc-axis-note'));
    expect(els).toHaveLength(2);
    expect(els.every((e) => e.getAttribute('font-size') === String(AXIS_NOTE_SIZE))).toBe(true);
    expect(els.map((e) => e.textContent).sort()).toEqual(['beside y', 'under x']);
  });

  it('the SVG exporter draws both', () => {
    const svg = buildChartSvg(chart, THEME, OPTS);
    expect(svg).toContain('under x');
    expect(svg).toContain('beside y');
  });

  it('the canvas exporter draws both', () => {
    const drawn: string[] = [];
    const ctx = {
      measureText: (t: string) => ({ width: String(t).length * 10 }),
      save: () => undefined, restore: () => undefined, translate: () => undefined,
      rotate: () => undefined, scale: () => undefined, beginPath: () => undefined,
      closePath: () => undefined, moveTo: () => undefined, lineTo: () => undefined,
      arcTo: () => undefined, fill: () => undefined, stroke: () => undefined,
      rect: () => undefined, clip: () => undefined, strokeRect: () => undefined,
      roundRect: () => undefined, fillRect: () => undefined, strokeText: () => undefined,
      fillText: (t: string) => { drawn.push(String(t)); },
      fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '',
      font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    const { renderChartToCanvas } = jest.requireActual('../src/exportImage');
    renderChartToCanvas(ctx, chart, THEME, OPTS);
    expect(drawn).toContain('under x');
    expect(drawn).toContain('beside y');
  });

  it('the note sits below the caption, not on top of it', () => {
    expect(AXIS_NOTE_DY).toBeGreaterThan(AXIS_CAPTION_DY);
    expect(AXIS_NOTE_DX).toBeGreaterThan(AXIS_CAPTION_DX);
  });
});

describe('the note stays inside the canvas', () => {
  it('the x note baseline is above the bottom edge', () => {
    const svg = buildChartSvg(chartWith('under x'), THEME, OPTS);
    const el = /<text class="qc-axis-note"[^>]*>/.exec(svg)![0];
    const y = Number(/y="([\d.]+)"/.exec(el)![1]);
    // Bottom margin 84, note at +62 from the plot's bottom edge, canvas is 900 tall.
    expect(y).toBeLessThan(OPTS.height);
    expect(OPTS.height - y).toBeGreaterThan(AXIS_NOTE_SIZE);
  });

  it('the y note sits clear of both the caption and the tick labels', () => {
    // Caption at AXIS_CAPTION_DX, note beside it, tick labels end-anchored at plot.x - 9.
    const plotLeft = AXIS_NOTE_LEFT;
    expect(AXIS_NOTE_DX).toBeLessThan(plotLeft - 9);
    expect(AXIS_NOTE_DX).toBeGreaterThan(AXIS_CAPTION_DX + AXIS_NOTE_SIZE);
  });
});

describe('the file format', () => {
  it('round-trips a note through write and read', () => {
    const text = chartToFileText(chartWith('under x', 'beside y'), 'body');
    const back = parseChartFromText(text)!;
    expect(back.x.note).toBe('under x');
    expect(back.y.note).toBe('beside y');
  });

  it('omits the key when there is no note, so an untouched file produces no diff', () => {
    expect(chartToFileText(chartWith(), 'body')).not.toMatch(/\bnote:/);
  });

  it('ignores an empty or whitespace-only note rather than reserving room for it', () => {
    const text = chartToFileText(chartWith(), 'body').replace('min: 0', 'min: 0\n  note: "   "');
    expect(parseChartFromText(text)!.x.note).toBeUndefined();
    expect(marginsFor(parseChartFromText(text)!).bottom).toBe(DEFAULT_MARGINS.bottom);
  });

  it('trims surrounding whitespace', () => {
    const text = chartToFileText(chartWith('  padded  '), 'body');
    expect(parseChartFromText(text)!.x.note).toBe('padded');
  });

  it('survives a second write unchanged', () => {
    const once = chartToFileText(chartWith('under x'), 'body');
    expect(chartToFileText(parseChartFromText(once)!, 'body')).toBe(once);
  });

  it('a CJK note needs no escaping beyond quoting', () => {
    const note = '分数由上级按 5 档打分，2026 年 9 月校准过一次';
    const back = parseChartFromText(chartToFileText(chartWith(note), 'body'))!;
    expect(back.x.note).toBe(note);
  });
});