/**
 * Regression tests for the save path, built around the failure that was MEASURED on a live vault
 * rather than inferred:
 *
 *     commit ENTERED items=4 file=象限图示例.mdx
 *     writeChart: processFrontMatter returned OK
 *     writeChart: VERIFY onDisk items=3
 *
 * `fileManager.processFrontMatter` resolves successfully and writes nothing at all when the file is
 * a `.mdx` registered against a custom view — it never enters Obsidian's markdown handling. Three
 * earlier rounds of "fixes" passed 85 tests while the file stayed untouched, because every stub here
 * implemented that helper as if it worked.
 *
 * So the vault stub below deliberately reproduces the no-op, and these tests must pass WITHOUT
 * processFrontMatter being involved at all. If someone reintroduces it, the suite goes red.
 */
import { writeChart, spliceFrontmatter } from '../src/mdx';
import { parseChartFromText } from '../src/mdx';
import { Chart, createChart } from '../src/model';

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

# My notes

Body text that must survive every save.
`;

function makeVault(initial: string) {
  let content = initial;
  let modifies = 0;
  const file = { path: 'c.mdx', extension: 'mdx' };

  const app = {
    vault: {
      read: async () => content,
      // Obsidian's atomic read-modify-write. Independent of file type, which is the whole point.
      process: async (_f: unknown, fn: (t: string) => string) => {
        modifies += 1;
        content = fn(content);
        return content;
      },
      modify: async (_f: unknown, data: string) => { modifies += 1; content = data; },
    },
    fileManager: {
      /** Reproduces the real, observed behaviour: resolves, changes nothing. */
      processFrontMatter: async () => { /* no-op, exactly as on a .mdx */ },
    },
  } as never;

  return { app, file, read: () => content, modifies: () => modifies };
}

describe('save path — works without processFrontMatter', () => {
  it('actually changes the file on disk', async () => {
    const { app, file, read } = makeVault(START);
    const chart: Chart = {
      ...createChart(2, 2), title: 'Changed',
      items: [...parseChartFromText(START)!.items, { id: 'b', text: 'Second', x: 5, y: 5 }],
    };
    await writeChart(app, file as never, chart);
    const after = parseChartFromText(read())!;
    expect(after.title).toBe('Changed');
    expect(after.items.map((i) => i.text)).toEqual(['First', 'Second']);
  });

  it('keeps the body byte-for-byte', async () => {
    const { app, file, read } = makeVault(START);
    await writeChart(app, file as never, { ...createChart(2, 2), title: 'X' });
    expect(read()).toContain('# My notes');
    expect(read()).toContain('Body text that must survive every save.');
  });

  it('performs a real write, not a silent no-op', async () => {
    const { app, file, read, modifies } = makeVault(START);
    await writeChart(app, file as never, { ...createChart(2, 2), title: 'Written' });
    expect(modifies()).toBeGreaterThan(0);
    expect(read()).not.toBe(START);
  });

  it('survives repeated edits, accumulating every label', async () => {
    const { app, file, read } = makeVault(START);
    let chart: Chart = parseChartFromText(START)!;
    for (let i = 2; i <= 5; i += 1) {
      chart = { ...chart, items: [...chart.items, { id: `x${i}`, text: `Item ${i}`, x: i, y: i }] };
      await writeChart(app, file as never, chart);
    }
    expect(parseChartFromText(read())!.items.map((i) => i.text))
      .toEqual(['First', 'Item 2', 'Item 3', 'Item 4', 'Item 5']);
  });

  it('deletes labels that were removed', async () => {
    const { app, file, read } = makeVault(START);
    await writeChart(app, file as never, { ...createChart(2, 2), items: [] });
    expect(parseChartFromText(read())!.items).toEqual([]);
  });

  it('drops a title that was cleared', async () => {
    const { app, file, read } = makeVault(START);
    await writeChart(app, file as never, createChart(2, 2)); // no title
    expect(read()).not.toContain('title:');
  });

  it('preserves axes, grid and cell colours', async () => {
    const { app, file, read } = makeVault(START);
    const chart: Chart = {
      ...createChart(3, 4),
      x: { label: 'Reach', min: -10, max: 10 },
      y: { label: 'Cost', min: 0, max: 5 },
      cells: [{ col: 2, row: 3, label: 'Later', color: '#d93025' }],
      items: [{ id: 'a', text: 'x', x: 1, y: 1 }],
    };
    await writeChart(app, file as never, chart);
    const after = parseChartFromText(read())!;
    expect(after.grid).toEqual({ columns: 3, rows: 4 });
    expect(after.x.label).toBe('Reach');
    expect(after.y.max).toBe(5);
    expect(after.cells[0].color).toBe('#d93025');
  });

  it('adds a frontmatter block to a file that has none', async () => {
    const { app, file, read } = makeVault('# Just a note\n\nno frontmatter here\n');
    await writeChart(app, file as never, { ...createChart(2, 2), items: [{ id: 'a', text: 'new', x: 1, y: 1 }] });
    const after = parseChartFromText(read())!;
    expect(after.items).toHaveLength(1);
    expect(read()).toContain('no frontmatter here');
  });

  it('treats an unterminated block as body rather than eating the file', async () => {
    const { app, file, read } = makeVault('---\nquadrant-chart: 1\nthis never closes\n');
    await writeChart(app, file as never, { ...createChart(2, 2), items: [{ id: 'a', text: 'z', x: 1, y: 1 }] });
    expect(read()).toContain('this never closes');
    expect(parseChartFromText(read())!.items).toHaveLength(1);
  });
});

describe('spliceFrontmatter — byte preservation outside the block', () => {
  it('keeps a --- inside the body from being mistaken for the delimiter', () => {
    const withRule = START.replace('# My notes', '# My notes\n\n---\n\nafter a horizontal rule');
    const out = spliceFrontmatter(withRule, createChart(2, 2));
    expect(out).toContain('after a horizontal rule');
    expect(parseChartFromText(out)).not.toBeNull();
  });

  it('does not alter the body text at all', () => {
    const out = spliceFrontmatter(START, { ...createChart(2, 2), title: 'New' });
    const bodyBefore = START.slice(START.indexOf('\n---\n', 4) + 5);
    const bodyAfter = out.slice(out.indexOf('\n---\n', 4) + 5);
    expect(bodyAfter).toBe(bodyBefore);
  });

  it('is idempotent — splicing twice with the same chart changes nothing further', () => {
    const chart = { ...createChart(2, 2), title: 'Stable', items: [{ id: 'a', text: 'x', x: 1, y: 1 }] };
    const once = spliceFrontmatter(START, chart);
    expect(spliceFrontmatter(once, chart)).toBe(once);
  });

  it('handles CRLF line endings', async () => {
    const { app, file, read } = makeVault(START.replace(/\n/g, '\r\n'));
    await writeChart(app, file as never, { ...createChart(2, 2), items: [{ id: 'a', text: 'crlf', x: 1, y: 1 }] });
    expect(parseChartFromText(read())!.items[0].text).toBe('crlf');
  });
});
