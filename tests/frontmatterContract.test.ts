// The bug this file exists to prevent.
//
// `FileManager.processFrontMatter` is declared as:
//     processFrontMatter(file: TFile, fn: (frontmatter: any) => void): Promise<void>
// The callback MUTATES the frontmatter object it is given. Its return value is discarded.
//
// Writing `processFrontMatter(file, () => chartToFrontmatter(chart))` therefore compiles, runs
// without error, and does absolutely nothing — Obsidian writes the original frontmatter straight
// back. The file looks untouched, no exception is raised, and from the user's side the plugin
// simply never saves.
//
// It survived a build, 79 passing tests and two rounds of manual testing because the test STUB
// implemented the opposite contract (`const next = fn(current) ?? {}`). The stub had been written to
// match the assumption rather than the declaration, so it agreed with the bug.
//
// These tests pin the contract from the declaration itself, so a stub that lies the same way again
// cannot make a broken write look correct.
import { writeChart, chartToFrontmatter } from '../src/mdx';
import { parseChartFromText } from '../src/mdx';
import { Chart, createChart } from '../src/model';

/** The signature as declared in obsidian.d.ts. */
type ProcessFrontMatter = (file: unknown, fn: (frontmatter: Record<string, unknown>) => void) => Promise<void>;

function makeVault(initial: string) {
  let content = initial;
  let writes = 0;
  const file = { path: 'c.mdx' };
  const app = {
    fileManager: {
      // Faithful to the d.ts: pass the object in, ignore whatever comes back.
      processFrontMatter: (async (_f: unknown, fn: (fm: Record<string, unknown>) => void) => {
        const m = /^---\n([\s\S]*?)\n---\n?/.exec(content);
        const fm = (m ? require('js-yaml').load(m[1]) ?? {} : {}) as Record<string, unknown>;
        const ignored = fn(fm);
        expect(ignored).toBeUndefined();   // the callback must not rely on a return value
        const body = m ? content.slice(m[0].length) : content;
        content = `---\n${require('js-yaml').dump(fm)}---\n${body}`;
        writes += 1;
      }) as ProcessFrontMatter,
    },
  } as never;
  return { app, file, read: () => content, writes: () => writes };
}

const START = `---
quadrant-chart: 1
title: Original
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
items:
  - id: a
    text: First
    x: 1
    y: 1
---

body
`;

describe('writeChart obeys the real processFrontMatter contract', () => {
  it('changes the file on disk', async () => {
    const { app, file, read } = makeVault(START);
    const chart: Chart = { ...createChart(2, 2), title: 'Changed', items: [{ id: 'b', text: 'Second', x: 5, y: 5 }] };
    await writeChart(app, file as never, chart);
    const after = parseChartFromText(read());
    expect(after!.title).toBe('Changed');
    expect(after!.items.map((i) => i.text)).toEqual(['Second']);
  });

  it('keeps the body', async () => {
    const { app, file, read } = makeVault(START);
    await writeChart(app, file as never, { ...createChart(2, 2), title: 'X' });
    expect(read()).toContain('body');
  });

  it('removes keys the chart no longer has', async () => {
    // processFrontMatter writes back the object it was handed, so a stale key survives unless it is
    // actively deleted. Leaving `title` behind after it was cleared would resurrect deleted data.
    const { app, file, read } = makeVault(START);
    const chart = createChart(2, 2); // no title
    await writeChart(app, file as never, chart);
    const fm = require('js-yaml').load(/^---\n([\s\S]*?)\n---/.exec(read())![1]);
    expect(fm).not.toHaveProperty('title');
  });

  it('deletes an item when it is removed from the chart', async () => {
    const { app, file, read } = makeVault(START);
    await writeChart(app, file as never, { ...createChart(2, 2), items: [] });
    const fm = require('js-yaml').load(/^---\n([\s\S]*?)\n---/.exec(read())![1]);
    expect(fm).not.toHaveProperty('items');
  });

  it('writes the keys in the documented order, not the previous order', async () => {
    // Assigning to an existing key keeps its position, so without clearing first the file would keep
    // whatever order the first save happened to produce, forever.
    const { app, file, read } = makeVault(START);
    await writeChart(app, file as never, { ...createChart(2, 2), title: 'Ordered' });
    const keys = Object.keys(require('js-yaml').load(/^---\n([\s\S]*?)\n---/.exec(read())![1]));
    expect(keys).toEqual(Object.keys(chartToFrontmatter({ ...createChart(2, 2), title: 'Ordered' })));
  });

  it('actually writes more than once when edited repeatedly', async () => {
    const { app, file, read, writes } = makeVault(START);
    let chart: Chart = { ...createChart(2, 2), items: [{ id: 'x', text: 'One', x: 1, y: 1 }] };
    for (let i = 2; i <= 4; i += 1) {
      await writeChart(app, file as never, chart);
      chart = { ...chart, items: [...chart.items, { id: `x${i}`, text: `Item ${i}`, x: i, y: i }] };
    }
    await writeChart(app, file as never, chart);
    expect(writes()).toBe(4);
    expect(parseChartFromText(read())!.items.map((i) => i.text))
      .toEqual(['One', 'Item 2', 'Item 3', 'Item 4']);
  });
});
