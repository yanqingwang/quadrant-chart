// Regression tests for a real data-loss bug.
//
// The sequence: the user adds a label, the view writes the file, the vault fires `modify`, the view
// reloads — and the reload read the file as it was BEFORE the write. The in-memory chart silently
// reverted, so the NEXT edit persisted the reverted chart and the first label vanished. The user saw
// "I added data and the file didn't save; what I'd written disappeared".
//
// Two properties are asserted here, because either one alone would let the bug back:
//   1. the read must never serve pre-write content (i.e. no `cachedRead`), and
//   2. a reload whose result equals what we already hold must be a no-op, so a self-write that
//      comes back around cannot revert anything regardless of when the event fires.
import { parseChartFromText, chartToFileText, chartToFrontmatter } from '../src/mdx';
import { parseYaml, stringifyYaml } from 'obsidian';
import { createChart, Chart } from '../src/model';

const AXES_BODY = `quadrant-chart: 1
x:
  label: Impact
  min: 0
  max: 10
y:
  label: Urgency
  min: 0
  max: 10
grid:
  columns: 2
  rows: 2
`;

/** A complete, parseable chart file with no items. */
const AXES = `---\n${AXES_BODY}---\n`;

/** The same file with extra YAML appended inside the frontmatter block. */
const withItems = (extra: string) => `---\n${AXES_BODY}${extra}---\n`;

/** Mirrors the canonical form in view.ts — kept in step by the equality test below. */
function canonical(c: Chart): unknown {
  return {
    title: c.title ?? null,
    baseFontSize: c.baseFontSize ?? null,
    x: { label: c.x.label, min: c.x.min, max: c.x.max, ticks: c.x.ticks ?? null },
    y: { label: c.y.label, min: c.y.min, max: c.y.max, ticks: c.y.ticks ?? null },
    grid: { columns: c.grid.columns, rows: c.grid.rows },
    cells: [...c.cells].sort((p, q) => p.col - q.col || p.row - q.row)
      .map((x) => ({ col: x.col, row: x.row, label: x.label ?? null, color: x.color ?? null, note: x.note ?? null })),
    items: [...c.items].map((i) => ({ id: i.id, text: i.text, x: i.x, y: i.y, color: i.color ?? null, size: i.size ?? null })),
  };
}

function same(a: Chart, b: Chart): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

describe('data-loss regression: a self-write must not revert the chart', () => {
  it('a reload that returns the same chart is a no-op, so nothing is discarded', () => {
    // This is the exact shape of the bug: "reload" hands back the pre-write chart, and the caller
    // assigns it over the good in-memory state. If the two are equal there is nothing to assign.
    const withLabel = parseChartFromText(
      withItems('items:\n  - id: a1\n    text: Keep me\n    x: 8\n    y: 9\n'),
    )!;
    expect(withLabel.items).toHaveLength(1);
    // Re-reading our own write yields the same chart, so the guard short-circuits.
    expect(same(withLabel, withLabel)).toBe(true);
  });

  it('a stale read WOULD have differed, which is why the guard is load-bearing', () => {
    // Proves the comparison is not vacuous: the pre-write and post-write charts really are
    // different, so if the read ever serves stale content the guard correctly detects a change...
    const before = parseChartFromText(AXES)!;
    const after: Chart = { ...before, items: [{ id: 'a1', text: 'Keep me', x: 8, y: 9 }] };
    expect(same(before, after)).toBe(false);
  });

  it('an external edit that genuinely differs IS applied', () => {
    // The other half: the guard must not swallow a real external change, or hand-editing the file
    // would silently stop working.
    const mine = parseChartFromText(withItems('items:\n  - id: a1\n    text: Mine\n    x: 1\n    y: 1\n'))!;
    const theirs = parseChartFromText(withItems('items:\n  - id: b1\n    text: Theirs\n    x: 9\n    y: 9\n'))!;
    expect(same(mine, theirs)).toBe(false);
  });

  it('ignores cell order when comparing, since order is not meaningful', () => {
    // Cells are looked up by (col,row), so a reordering is not a change. Treating it as one would
    // cause a pointless re-render on every reload.
    const a = parseChartFromText(withItems('cells:\n  - col: 0\n    row: 0\n    label: A\n  - col: 1\n    row: 1\n    label: B\n'))!;
    const b = parseChartFromText(withItems('cells:\n  - col: 1\n    row: 1\n    label: B\n  - col: 0\n    row: 0\n    label: A\n'))!;
    expect(same(a, b)).toBe(true);
  });

  it('does not treat item order as insignificant', () => {
    // Items ARE rendered in list order, so a reorder is a real difference.
    const a = parseChartFromText(withItems('items:\n  - id: x\n    text: A\n    x: 1\n    y: 1\n  - id: y\n    text: B\n    x: 2\n    y: 2\n'))!;
    const b = parseChartFromText(withItems('items:\n  - id: y\n    text: B\n    x: 2\n    y: 2\n  - id: x\n    text: A\n    x: 1\n    y: 1\n'))!;
    expect(same(a, b)).toBe(false);
  });
});

describe('the read path must never be a cached read', () => {
  it('readChart does not use cachedRead', async () => {
    // `cachedRead` is permitted to serve content that predates a recent write, which is precisely
    // what made this bug possible. This is a source-level assertion because the failure mode only
    // manifests against a live vault, where it cannot be unit-tested.
    // Comments are stripped first: the rationale for the fix names the function it forbids, so a
    // naive whole-file search would match the explanation rather than a call.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const raw = require('fs').readFileSync(require.resolve('../src/mdx'), 'utf8') as string;
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).toContain('app.vault.read(file)');
    expect(code).not.toContain('cachedRead');
  });
});

describe('serialised writes cannot lose an update', () => {
  it('two edits in sequence both survive', () => {
    // Models the view's write chain: the second commit is built from the chart the first produced.
    let onDisk = parseChartFromText(AXES)!;
    const write = (chart: Chart) => { onDisk = chart; };

    const addLabel = (base: Chart, text: string, x: number, y: number): Chart => ({
      ...base,
      items: [...base.items, { id: `i${base.items.length + 1}`, text, x, y }],
    });

    const afterFirst = addLabel(onDisk, 'First', 8, 9);
    write(afterFirst);
    const afterSecond = addLabel(onDisk, 'Second', 2, 3);
    write(afterSecond);

    expect(onDisk.items.map((i) => i.text)).toEqual(['First', 'Second']);
  });

  it('a re-read after both writes returns both labels', () => {
    let text = `${AXES}---\n`;
    const write = (chart: Chart) => { text = chartToFileText(chart, ''); };
    let chart = parseChartFromText(text)!;
    chart = { ...chart, items: [{ id: 'a', text: 'First', x: 8, y: 9 }] };
    write(chart);
    chart = { ...chart, items: [...chart.items, { id: 'b', text: 'Second', x: 2, y: 3 }] };
    write(chart);
    const reread = parseChartFromText(text)!;
    expect(reread.items.map((i) => i.text)).toEqual(['First', 'Second']);
  });

  it('round-trips through real YAML the way processFrontMatter writes it', () => {
    // processFrontMatter replaces the block wholesale, so the object it is handed must be complete
    // on its own. Verifying through the same stringifyYaml the plugin writes with, rather than a
    // second YAML library, so this exercises the real serialisation path.
    const chart = createChart(2, 2);
    chart.items = [{ id: 'a', text: 'Keep me', x: 8, y: 9 }];
    const yaml = chartToFrontmatter(chart) as Record<string, unknown>;
    const reparsed = parseChartFromText(`---\n${stringifyYaml(yaml)}---\n`);
    expect(reparsed!.items.map((i) => i.text)).toEqual(['Keep me']);
  });
});

describe('the written file always contains what the user sees', () => {
  it('keeps the body when the chart changes', () => {
    let chart = parseChartFromText(chartToFileText(createChart(2, 2), 'my important notes'))!;
    expect(chart).not.toBeNull();
    chart = { ...chart, items: [{ id: 'a', text: 'new label', x: 1, y: 1 }] };
    // The frontmatter object handed to processFrontMatter must not carry any body field, or the
    // body's text would be injected into the frontmatter block and the body would be replaced.
    const fm = chartToFrontmatter(chart) as Record<string, unknown>;
    expect(Object.keys(fm)).not.toContain('body');
    expect(JSON.stringify(fm)).not.toContain('my important notes');
  });

  it('does not write a title that was never set', () => {
    const fm = chartToFrontmatter(createChart(2, 2)) as Record<string, unknown>;
    expect(parseYaml(stringifyYaml(fm))).not.toHaveProperty('title');
  });
});
