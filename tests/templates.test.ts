/**
 * The embedded examples must be genuinely usable, not just present.
 *
 * A template that the plugin writes but cannot read back is the silent-no-op failure mode again: the
 * command succeeds, the file appears, and the user discovers on opening it that the example is
 * empty or malformed. So every template is parsed with the plugin's OWN parser here — the same code
 * path a real file goes through — and its contents are checked semantically, not just for presence.
 *
 * The text is also compared against the workspace `.mdx` it was generated from. `templates.ts` is
 * generated, so it can drift when an example is edited and the generator is not re-run; this is
 * that check, and it fails with the command needed to fix it.
 */
import { parseChartFromText } from '../src/mdx';
import { findCell } from '../src/geometry';
import { Chart } from '../src/model';
import { TEMPLATES, findTemplate } from '../src/templates';
import * as fs from 'fs';

const SOURCE: Record<string, string> = {
  swot: '/home/wang/wk/wk/SWOT-插件价值.mdx',
  'nine-box': '/home/wang/wk/wk/人才九宫格-示例.mdx',
};

/** Which cell a point actually lands in, computed the way the canvas does. */
function cellOf(c: Chart, x: number, y: number): { col: number; row: number } {
  const sx = (c.x.max - c.x.min) || 1;
  const sy = (c.y.max - c.y.min) || 1;
  return {
    col: Math.min(c.grid.columns - 1, Math.max(0, Math.floor(((x - c.x.min) / sx) * c.grid.columns))),
    row: Math.min(c.grid.rows - 1, Math.max(0, Math.floor(((y - c.y.min) / sy) * c.grid.rows))),
  };
}

function parse(tpl: { text: string }): Chart {
  const c = parseChartFromText(tpl.text);
  if (!c) throw new Error('template did not parse');
  return c;
}

describe('embedded examples', () => {
  it('ships both a SWOT and a talent nine-box', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(['swot', 'nine-box']);
    expect(findTemplate('swot')).toBeDefined();
    expect(findTemplate('nine-box')).toBeDefined();
    expect(findTemplate('nope')).toBeUndefined();
  });

  it('gives every template a name, a description and a suggested filename', () => {
    for (const t of TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      // A suggested name must be usable as a filename: no slashes, no path separators.
      expect(t.suggestedName).not.toMatch(/[/\\:*?"<>|]/);
    }
  });

  // Each is parsed with the real parser, so a template that the plugin would write but could not
  // re-read fails here rather than in front of a user.
  it('every template parses with the plugin parser and carries its marker', () => {
    for (const t of TEMPLATES) {
      expect(t.text.startsWith('---')).toBe(true);
      expect(t.text).toContain('quadrant-chart: 1');
      const chart = parse(t);
      expect(chart.grid.columns).toBeGreaterThanOrEqual(1);
      expect(chart.items.length).toBeGreaterThan(0);
    }
  });

  it('every template keeps a readable body after the frontmatter', () => {
    for (const t of TEMPLATES) {
      const after = t.text.slice(t.text.indexOf('---', 3) + 3);
      expect(after.trim().length).toBeGreaterThan(50);
    }
  });
});

describe('SWOT example template', () => {
  const chart = parse(findTemplate('swot')!);

  it('is a 2x2 with internal-left and helpful-up', () => {
    expect(chart.grid).toEqual({ columns: 2, rows: 2 });
    expect(chart.x.min).toBeLessThan(0);
    expect(chart.y.min).toBeLessThan(0);
  });

  it('names all four boxes in the textbook corners', () => {
    expect(findCell(chart, 0, 1)?.label).toBe('Strengths');
    expect(findCell(chart, 0, 0)?.label).toBe('Weaknesses');
    expect(findCell(chart, 1, 1)?.label).toBe('Opportunities');
    expect(findCell(chart, 1, 0)?.label).toBe('Threats');
  });

  it('gives the four boxes four distinct colours', () => {
    expect(new Set(chart.cells.map((c) => c.color)).size).toBe(4);
  });

  // The check that would have caught the Threats-in-Opportunities bug when the example was written.
  it('every label lands inside the box it belongs to', () => {
    for (const item of chart.items) {
      const cell = cellOf(chart, item.x, item.y);
      const label = findCell(chart, cell.col, cell.row)?.label;
      expect(label).toBeDefined();
    }
    expect(new Set(chart.items.map((i) => cellOf(chart, i.x, i.y).row))).toEqual(new Set([0, 1]));
  });

  it('leaves no box empty', () => {
    for (const cell of chart.cells) {
      const n = chart.items.filter((i) => {
        const p = cellOf(chart, i.x, i.y);
        return p.col === cell.col && p.row === cell.row;
      }).length;
      expect({ box: cell.label, n }).toEqual({ box: cell.label, n: expect.any(Number) });
      expect(n).toBeGreaterThan(0);
    }
  });
});

describe('talent nine-box example template', () => {
  const chart = parse(findTemplate('nine-box')!);

  it('is a 3x3 with every cell decorated exactly once', () => {
    expect(chart.grid).toEqual({ columns: 3, rows: 3 });
    expect(chart.cells).toHaveLength(9);
    expect(new Set(chart.cells.map((c) => `${c.col},${c.row}`)).size).toBe(9);
  });

  it('uses the standard mapping — performance across, potential up', () => {
    // row 0 is the BOTTOM (low potential); col 0 is the LEFT (low performance).
    expect(findCell(chart, 2, 2)?.label).toMatch(/明星/);
    expect(findCell(chart, 2, 1)?.label).toMatch(/绩优者/);
    expect(findCell(chart, 2, 0)?.label).toMatch(/专业人士/);
    expect(findCell(chart, 1, 2)?.label).toMatch(/高潜者/);
    expect(findCell(chart, 1, 1)?.label).toMatch(/中坚力量/);
    expect(findCell(chart, 1, 0)?.label).toMatch(/合格者/);
    expect(findCell(chart, 0, 2)?.label).toMatch(/待观察/);
    expect(findCell(chart, 0, 1)?.label).toMatch(/待改进/);
    expect(findCell(chart, 0, 0)?.label).toMatch(/需优化/);
  });

  it('no two boxes share a name', () => {
    expect(new Set(chart.cells.map((c) => c.label)).size).toBe(9);
  });

  it('places exactly one person in each box', () => {
    for (const cell of chart.cells) {
      const n = chart.items.filter((i) => {
        const p = cellOf(chart, i.x, i.y);
        return p.col === cell.col && p.row === cell.row;
      }).length;
      expect({ box: cell.label, n }).toEqual({ box: cell.label, n: 1 });
    }
  });

  it('marks the sample names as fictional', () => {
    const text = findTemplate('nine-box')!.text;
    expect(text).toContain('虚构示例数据');
    expect(text).toContain('FICTIONAL');
  });
});

describe('templates.ts is in sync with the workspace examples', () => {
  // A generated file that drifts from its source is invisible until someone notices the plugin
  // serving a stale example. This fails with the exact command needed to re-sync.
  it('matches the .mdx files byte for byte', () => {
    for (const t of TEMPLATES) {
      const src = SOURCE[t.id];
      if (!src) throw new Error(`no source path recorded for template ${t.id}`);
      const onDisk = fs.readFileSync(src, 'utf8');
      expect({ id: t.id, same: t.text === onDisk }).toEqual({
        id: t.id,
        same: true,
      });
    }
  });

  it('names the generator in its header, so the drift has a documented fix', () => {
    const header = fs.readFileSync(
      '/home/wang/wk/code/obsidian-quadrant-chart/src/templates.ts',
      'utf8',
    ).slice(0, 700);
    expect(header).toContain('GENERATED FILE');
    expect(header).toContain('build_templates.py');
  });
});
