/**
 * Checks the two generated demo charts, end to end.
 *
 * These exist because quadrant misplacement was hit twice while writing them: once in a hand-written
 * SWOT, once again in the generated one. Both looked fine and both were wrong — Threats sitting in
 * the Opportunities box, because `row 0` is the BOTTOM band and gets counted from the Y minimum.
 *
 * So the assertions are about SEMANTICS: which box a label lands in, and whether the declared cell
 * and the actual coordinates agree. A chart that renders but lies is worse than one that fails.
 */
import { parseChartFromText } from '../src/mdx';
import { findCell } from '../src/geometry';
import { Chart } from '../src/model';
import * as fs from 'fs';

const SWOT = '/home/wang/wk/wk/SWOT-插件价值.mdx';
const NINE = '/home/wang/wk/wk/人才九宫格-示例.mdx';

function readChart(p: string): Chart {
  const c = parseChartFromText(fs.readFileSync(p, 'utf8'));
  if (!c) throw new Error(`${p} did not parse`);
  return c;
}

/** Which cell a point actually lands in, computed the way the canvas does. */
function cellOf(c: Chart, x: number, y: number): { col: number; row: number } {
  const sx = (c.x.max - c.x.min) || 1;
  const sy = (c.y.max - c.y.min) || 1;
  return {
    col: Math.min(c.grid.columns - 1, Math.max(0, Math.floor(((x - c.x.min) / sx) * c.grid.columns))),
    row: Math.min(c.grid.rows - 1, Math.max(0, Math.floor(((y - c.y.min) / sy) * c.grid.rows))),
  };
}

describe('SWOT demo chart', () => {
  const c = readChart(SWOT);

  it('is a 2x2 grid with internal-left, helpful-up', () => {
    expect(c.grid).toEqual({ columns: 2, rows: 2 });
    expect(c.x.min).toBeLessThan(0);       // internal on the left
    expect(c.y.min).toBeLessThan(0);       // harmful at the bottom
  });

  it('places the four boxes in the textbook corners', () => {
    expect(findCell(c, 0, 1)?.label).toBe('Strengths');      // internal + helpful
    expect(findCell(c, 0, 0)?.label).toBe('Weaknesses');     // internal + harmful
    expect(findCell(c, 1, 1)?.label).toBe('Opportunities');  // external + helpful
    expect(findCell(c, 1, 0)?.label).toBe('Threats');        // external + harmful
  });

  it('gives every box a distinct colour', () => {
    expect(new Set(c.cells.map((x) => x.color)).size).toBe(4);
  });

  it('every label actually lands inside the box its id implies', () => {
    // The check that would have caught the Threats-in-Opportunities bug.
    const want: Record<string, { col: number; row: number }> = {
      s: { col: 0, row: 1 }, w: { col: 0, row: 0 },
      o: { col: 1, row: 1 }, t: { col: 1, row: 0 },
    };
    for (const item of c.items) {
      const prefix = item.id.replace(/[0-9]/g, '');
      const expected = want[prefix];
      expect({ id: item.id, ...cellOf(c, item.x, item.y) }).toEqual({ id: item.id, ...expected });
    }
  });

  it('no box is empty', () => {
    for (const cell of c.cells) {
      const n = c.items.filter((i) => {
        const p = cellOf(c, i.x, i.y);
        return p.col === cell.col && p.row === cell.row;
      }).length;
      expect({ box: cell.label, n }).toEqual({ box: cell.label, n: expect.any(Number) });
      expect(n).toBeGreaterThan(0);
    }
  });

  it('keeps the explanatory body', () => {
    expect(fs.readFileSync(SWOT, 'utf8')).toContain('The honest reading');
  });
});

describe('talent nine-box demo chart', () => {
  const c = readChart(NINE);

  it('is a 3x3 grid, every cell decorated exactly once', () => {
    expect(c.grid).toEqual({ columns: 3, rows: 3 });
    expect(c.cells).toHaveLength(9);
    expect(new Set(c.cells.map((x) => `${x.col},${x.row}`)).size).toBe(9);
  });

  it('uses the standard mapping: performance across, potential up', () => {
    // row 0 is the BOTTOM (low potential), col 0 is the LEFT (low performance).
    expect(findCell(c, 2, 2)?.label).toMatch(/明星 Star/);
    expect(findCell(c, 2, 1)?.label).toMatch(/绩优者/);
    expect(findCell(c, 2, 0)?.label).toMatch(/专业人士/);
    expect(findCell(c, 1, 2)?.label).toMatch(/高潜者/);
    expect(findCell(c, 1, 1)?.label).toMatch(/中坚力量/);
    expect(findCell(c, 1, 0)?.label).toMatch(/合格者/);
    expect(findCell(c, 0, 2)?.label).toMatch(/待观察/);
    expect(findCell(c, 0, 1)?.label).toMatch(/待改进/);
    expect(findCell(c, 0, 0)?.label).toMatch(/需优化/);
  });

  it('no two boxes share a name', () => {
    expect(new Set(c.cells.map((x) => x.label)).size).toBe(9);
  });

  it('leaves no box empty', () => {
    // This file is the user's scratch copy and now holds a tenth label they added while trying the
    // plugin out, so "exactly one occupant per box" is asserted on the SHIPPED template instead —
    // see tests/templates.test.ts. The invariant that must hold for any chart is that every
    // decorated box has something in it.
    for (const cell of c.cells) {
      const n = c.items.filter((i) => {
        const p = cellOf(c, i.x, i.y);
        return p.col === cell.col && p.row === cell.row;
      }).length;
      expect({ box: cell.label, n }).toEqual({ box: cell.label, n: expect.any(Number) });
      expect(n).toBeGreaterThan(0);
    }
  });

  it('marks the data as fictional, so it cannot be mistaken for a real assessment', () => {
    const text = fs.readFileSync(NINE, 'utf8');
    expect(text).toContain('虚构示例数据');
    expect(text).toContain('FICTIONAL');
  });
});
