// Geometry and model are the parts that decide WHERE a label lands. A wrong pixel here is
// invisible in code review and only shows up as "the chart is wrong", so these are tested directly
// rather than left to the SVG to reveal.
import {
  Axis, Chart, createChart, normalizeChart, DEFAULTS, LIMITS,
} from '../src/model';
import {
  cellAt, findCell, axisTicks, cellRect, dataToScreenX, dataToScreenY,
  screenToDataX, screenToDataY, formatTick, splitPositions,
} from '../src/geometry';

const RECT = { x: 100, y: 50, width: 400, height: 200 };
const X: Axis = { label: 'x', min: 0, max: 10 };
const Y: Axis = { label: 'y', min: 0, max: 10 };

describe('data <-> screen mapping', () => {
  it('maps the axis minimum to the left/bottom edge and the maximum to the right/top', () => {
    expect(dataToScreenX(0, X, RECT)).toBe(100);
    expect(dataToScreenX(10, X, RECT)).toBe(500);
    // Y is inverted: data-y 0 is the BOTTOM of the plot, which is the largest screen y.
    expect(dataToScreenY(0, Y, RECT)).toBe(250);
    expect(dataToScreenY(10, Y, RECT)).toBe(50);
  });

  it('round-trips through screen space', () => {
    for (const v of [0, 1, 3.7, 9.99, 10]) {
      expect(screenToDataX(dataToScreenX(v, X, RECT), X, RECT)).toBeCloseTo(v, 6);
      expect(screenToDataY(dataToScreenY(v, Y, RECT), Y, RECT)).toBeCloseTo(v, 6);
    }
  });

  it('handles a negative range', () => {
    const ax: Axis = { label: 'x', min: -5, max: 5 };
    expect(dataToScreenX(-5, ax, RECT)).toBe(100);
    expect(dataToScreenX(0, ax, RECT)).toBe(300);
    expect(dataToScreenX(5, ax, RECT)).toBe(500);
  });

  it('clamps screen coordinates to the axis range', () => {
    expect(screenToDataX(-9999, X, RECT)).toBe(0);
    expect(screenToDataX(9999, X, RECT)).toBe(10);
  });

  it('survives a collapsed plot rect without producing NaN', () => {
    const tiny = { x: 0, y: 0, width: 0, height: 0 };
    // A zero-width pane happens during pane drags; NaN here would poison the model permanently.
    expect(Number.isFinite(dataToScreenX(5, X, tiny))).toBe(true);
    expect(Number.isFinite(screenToDataX(0, X, tiny))).toBe(true);
  });
});

describe('axisTicks', () => {
  it('produces round numbers rather than equal divisions', () => {
    const ticks = axisTicks({ label: 'x', min: 0, max: 10 });
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(10);
    // Every tick must land on a clean step, not 3.33333.
    for (const t of ticks) expect(Number.isInteger(t)).toBe(true);
  });

  it('honours explicit ticks when given', () => {
    expect(axisTicks({ label: 'x', min: 0, max: 10, ticks: [1, 4, 9] })).toEqual([1, 4, 9]);
  });

  it('does not loop forever on a zero-width range', () => {
    expect(axisTicks({ label: 'x', min: 5, max: 5 })).toEqual([5]);
  });

  it('handles a fractional range', () => {
    const ticks = axisTicks({ label: 'x', min: 0, max: 1 });
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks[0]).toBeCloseTo(0, 6);
  });
});

describe('formatTick', () => {
  it('compacts large numbers', () => {
    expect(formatTick(1500000)).toBe('1.5M');
    expect(formatTick(20000)).toBe('20k');
    expect(formatTick(3.14159)).toBe('3.14');
  });
});

describe('grid geometry', () => {
  const chart: Chart = { ...createChart(3, 2), x: X, y: Y };

  it('splits without duplicating the outer frame', () => {
    const { xs, ys } = splitPositions(chart, RECT);
    expect(xs).toHaveLength(chart.grid.columns - 1);
    expect(ys).toHaveLength(chart.grid.rows - 1);
  });

  it('places cells with row 0 at the bottom', () => {
    const bottom = cellRect(chart, 0, 0, RECT);
    const top = cellRect(chart, 0, 1, RECT);
    expect(bottom.y).toBeGreaterThan(top.y);
    expect(bottom.y + bottom.height).toBeCloseTo(RECT.y + RECT.height, 6);
  });

  it('resolves the cell containing a point', () => {
    expect(cellAt(chart, 1, 1)).toEqual({ col: 0, row: 0 });
    expect(cellAt(chart, 9, 9)).toEqual({ col: 2, row: 1 });
    // The exact maximum is inside the last cell, not past the edge.
    expect(cellAt(chart, 10, 10)).toEqual({ col: 2, row: 1 });
  });

  it('returns null for a point outside the plot', () => {
    expect(cellAt(chart, 11, 5)).toBeNull();
    expect(cellAt(chart, 5, -1)).toBeNull();
  });

  it('finds a cell decoration and reports undefined when absent', () => {
    const withCell = normalizeChart({ cells: [{ col: 1, row: 0, label: 'Do now' }] });
    expect(findCell(withCell, 1, 0)?.label).toBe('Do now');
    expect(findCell(withCell, 0, 0)).toBeUndefined();
  });
});

describe('normalizeChart — the trust boundary for hand-edited files', () => {
  it('fills defaults for an empty object', () => {
    const c = normalizeChart({});
    expect(c.x.label).toBe(DEFAULTS.xAxis.label);
    expect(c.grid).toEqual({ columns: 2, rows: 2 });
    expect(c.items).toEqual([]);
  });

  it('survives a completely wrong type', () => {
    expect(() => normalizeChart('not an object')).not.toThrow();
    expect(() => normalizeChart(null)).not.toThrow();
    expect(() => normalizeChart(42)).not.toThrow();
  });

  it('repairs a reversed axis range instead of rendering nothing', () => {
    const c = normalizeChart({ x: { min: 10, max: 0 } });
    expect(c.x.min).toBe(0);
    expect(c.x.max).toBe(10);
  });

  it('repairs a zero-width range', () => {
    const c = normalizeChart({ y: { min: 3, max: 3 } });
    expect(c.y.max).toBeGreaterThan(c.y.min);
  });

  it('clamps the grid to the supported split range', () => {
    expect(normalizeChart({ grid: { columns: 0, rows: 0 } }).grid).toEqual({ columns: 1, rows: 1 });
    expect(normalizeChart({ grid: { columns: 999, rows: 999 } }).grid).toEqual({
      columns: LIMITS.maxSplits, rows: LIMITS.maxSplits,
    });
  });

  it('drops items with no text rather than rendering invisible nodes', () => {
    const c = normalizeChart({ items: [{ text: '   ', x: 1, y: 1 }, { text: 'keep', x: 1, y: 1 }] });
    expect(c.items).toHaveLength(1);
    expect(c.items[0].text).toBe('keep');
  });

  it('gives duplicate ids distinct values, since ids key drag targeting', () => {
    const c = normalizeChart({
      items: [
        { id: 'same', text: 'a', x: 1, y: 1 },
        { id: 'same', text: 'b', x: 2, y: 2 },
      ],
    });
    expect(c.items[0].id).not.toBe(c.items[1].id);
  });

  it('clamps item coordinates into the axis range', () => {
    const c = normalizeChart({ x: { min: 0, max: 10 }, items: [{ text: 'a', x: 999, y: -999 }] });
    expect(c.items[0].x).toBe(10);
    expect(c.items[0].y).toBe(0);
  });

  it('drops cell decorations that fall outside the current grid', () => {
    const c = normalizeChart({
      grid: { columns: 2, rows: 2 },
      cells: [{ col: 5, row: 5, label: 'nowhere' }, { col: 1, row: 1, label: 'here' }],
    });
    expect(c.cells).toHaveLength(1);
    expect(c.cells[0].label).toBe('here');
  });

  it('discards ticks outside the axis range', () => {
    const c = normalizeChart({ x: { min: 0, max: 10, ticks: [1, 999] } });
    expect(c.x.ticks).toEqual([1]);
  });

  it('de-duplicates and sorts explicit ticks', () => {
    const c = normalizeChart({ x: { min: 0, max: 10, ticks: [5, 1, 5] } });
    expect(c.x.ticks).toEqual([1, 5]);
  });
});
