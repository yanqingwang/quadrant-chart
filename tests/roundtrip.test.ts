// The write path goes through `fileManager.processFrontMatter`, which is not available outside a
// running vault. What CAN be verified here is the contract that path depends on: a file written by
// `chartToFileText` must parse back to the identical chart, and the body must come back byte for
// byte. If that holds, the only remaining risk is Obsidian's own helper, not this plugin's format.
import { chartToFileText, parseChartFromText, extractBody, defaultBody } from '../src/mdx';
import { createChart, normalizeChart, Chart } from '../src/model';

function sample(): Chart {
  const c = createChart(3, 2);
  c.title = 'Q1 Priorities';
  c.x = { label: 'Impact', min: -5, max: 15 };
  c.y = { label: 'Urgency', min: 0, max: 8, ticks: [0, 4, 8] };
  c.cells = [
    { col: 2, row: 1, label: 'Do now', color: '#d93025', note: 'Blocking a release' },
    { col: 0, row: 0, label: 'Someday' },
  ];
  c.items = [
    { id: 'a1', text: 'Rework the sync engine', x: 8.2, y: 7 },
    { id: 'a2', text: 'Long text label that should wrap nicely inside its cell', x: -3.25, y: 1.5, color: '#1a73e8', size: 18 },
  ];
  return c;
}

describe('file round-trip', () => {
  it('write -> parse returns an identical chart', () => {
    const original = sample();
    expect(parseChartFromText(chartToFileText(original, defaultBody(3, 2)))).toEqual(original);
  });

  it('preserves a body containing YAML-looking text', () => {
    // A body that itself contains '---' must not be mistaken for a frontmatter delimiter.
    const body = ['# Notes', '', '---', 'not: frontmatter', '---', '', 'trailing text'].join('\n');
    const text = chartToFileText(sample(), body);
    expect(extractBody(text)).toBe(body);
  });

  it('preserves a body with unicode and emoji', () => {
    const body = '优先级 · 緊急度 ✅ 日本語';
    expect(extractBody(chartToFileText(sample(), body))).toBe(body);
  });

  it('survives an edit-and-resave cycle without drift', () => {
    // The real usage pattern: open, move a label, save, reopen. Repeated cycles must not
    // accumulate rounding drift or reorder entries.
    let chart = sample();
    for (let i = 0; i < 5; i += 1) {
      const text = chartToFileText(chart, 'body');
      const parsed = parseChartFromText(text);
      expect(parsed).toEqual(chart);
      chart = {
        ...parsed!,
        items: parsed!.items.map((it) => ({ ...it, x: Math.round((it.x + 0.1) * 100) / 100 })),
      };
    }
    const final = parseChartFromText(chartToFileText(chart, 'body'));
    expect(final!.items.map((i) => i.x)).toEqual(chart.items.map((i) => i.x));
  });

  it('keeps item order stable, since order is what the user sees', () => {
    const chart = sample();
    const out = parseChartFromText(chartToFileText(chart, ''))!;
    expect(out.items.map((i) => i.id)).toEqual(chart.items.map((i) => i.id));
  });

  it('does not lose a fractional coordinate beyond 2dp', () => {
    // Coordinates are rounded to 2dp on write, so a chart must be a fixed point of that rounding.
    const c = normalizeChart({ items: [{ id: 'x', text: 'a', x: 1.234, y: 2.345 }] });
    const again = parseChartFromText(chartToFileText(c, ''))!;
    expect(again.items[0].x).toBe(1.23);
    expect(parseChartFromText(chartToFileText(again, ''))!.items[0].x).toBe(1.23);
  });

  it('writes a file Obsidian will accept as markdown-ish text', () => {
    const text = chartToFileText(sample(), 'body');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('quadrant-chart: 1');
    // A NUL or a stray control character would make the file unreadable to the vault.
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)).toBe(false);
  });
});
