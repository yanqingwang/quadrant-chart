/**
 * @jest-environment jsdom
 *
 * Where a new label goes.
 *
 * The bug this pins, measured rather than assumed: `addItem()` with no coordinates placed the label
 * at the centre of the data range. On a 2x2 grid whose range is -5…5, that centre is the point (0,0)
 * — which lies exactly ON the boundary between all four cells. `cellAt` then resolved the ambiguity
 * to the top-right cell every time, so a new label landed in (1,1) no matter which cell was
 * selected, and in a 3x3 grid the centre point landed on the boundary between four cells too.
 *
 * The correct behaviour is the centre of the SELECTED cell. Two separate requirements are checked:
 * the position must respect the selection, and it must be strictly INSIDE the cell rather than on
 * its edge — a label sitting exactly on a boundary is ambiguous to every later reader, including the
 * cell-lookup this file uses to verify.
 */
import { ChartCanvas } from '../src/canvas';
import { Chart, createChart } from '../src/model';
import { cellAt } from '../src/geometry';

const FILE = { path: 'c.mdx' } as never;

function makeChart(columns: number, rows: number, min = -5, max = 5): Chart {
  const c = createChart(columns, rows);
  return { ...c, x: { label: 'X', min, max }, y: { label: 'Y', min, max } };
}

function build(chart: Chart) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
  document.body.appendChild(container);
  const changes: Chart[] = [];
  const canvas = new ChartCanvas(container, chart, {
    onChange: (c) => changes.push(c),
    onSelectCell: () => undefined,
    promptText: async () => 'new label',
  });
  canvas.measure();
  canvas.render();
  return { canvas, changes };
}

/** Add a label with no coordinates, i.e. the toolbar "Add label" button. */
async function addWithNoCoords(canvas: ChartCanvas, chart: Chart) {
  const before = canvas.getChart().items.length;
  await canvas.addItem();
  const item = canvas.getChart().items[before];
  if (!item) throw new Error('addItem did not add anything');
  return item;
}

describe('a new label goes in the selected cell', () => {
  it('lands inside the cell the user selected', async () => {
    const chart = makeChart(2, 2);
    const { canvas } = build(chart);
    canvas.setSelectedCell(0, 0);
    const item = await addWithNoCoords(canvas, chart);
    expect(cellAt(chart, item.x, item.y)).toEqual({ col: 0, row: 0 });
  });

  it('respects every cell of a 2x2, not just the default one', async () => {
    const chart = makeChart(2, 2);
    for (const [col, row] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const { canvas } = build(chart);
      canvas.setSelectedCell(col, row);
      const item = await addWithNoCoords(canvas, chart);
      expect({ selected: [col, row], landed: cellAt(chart, item.x, item.y) })
        .toEqual({ selected: [col, row], landed: { col, row } });
    }
  });

  // The old behaviour resolved every selection to (1,1) because the label sat on the centre point.
  it('does not always land in the top-right cell', async () => {
    const chart = makeChart(2, 2);
    const { canvas } = build(chart);
    canvas.setSelectedCell(0, 1);
    const item = await addWithNoCoords(canvas, chart);
    expect(cellAt(chart, item.x, item.y)).toEqual({ col: 0, row: 1 });
  });

  it('respects every cell of a 3x3, including the middle', async () => {
    const chart = makeChart(3, 3);
    for (const [col, row] of [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]]) {
      const { canvas } = build(chart);
      canvas.setSelectedCell(col, row);
      const item = await addWithNoCoords(canvas, chart);
      expect({ selected: [col, row], landed: cellAt(chart, item.x, item.y) })
        .toEqual({ selected: [col, row], landed: { col, row } });
    }
  });

  // A label on a boundary is ambiguous to anyone reading the chart afterwards.
  it('places the label strictly inside the cell, never on its edge', async () => {
    const chart = makeChart(3, 3);
    const { canvas } = build(chart);
    canvas.setSelectedCell(1, 2);
    const item = await addWithNoCoords(canvas, chart);
    const cellW = (chart.x.max - chart.x.min) / 3;
    const cellH = (chart.y.max - chart.y.min) / 3;
    const xLow = chart.x.min + 1 * cellW;
    const xHigh = chart.x.min + 2 * cellW;
    const yLow = chart.y.min + 2 * cellH;
    const yHigh = chart.y.min + 3 * cellH;
    expect(item.x).toBeGreaterThan(xLow);
    expect(item.x).toBeLessThan(xHigh);
    expect(item.y).toBeGreaterThan(yLow);
    expect(item.y).toBeLessThan(yHigh);
  });

  it('sits at the centre of the cell', async () => {
    const chart = makeChart(2, 2);
    const { canvas } = build(chart);
    canvas.setSelectedCell(0, 0);
    const item = await addWithNoCoords(canvas, chart);
    expect(item.x).toBeCloseTo(-2.5, 5);
    expect(item.y).toBeCloseTo(-2.5, 5);
  });

  it('falls back to the middle cell when nothing is selected', async () => {
    const chart = makeChart(2, 2);
    const { canvas } = build(chart);
    const item = await addWithNoCoords(canvas, chart);
    expect(cellAt(chart, item.x, item.y)).toEqual({ col: 1, row: 1 });
  });

  it('handles an odd range without rounding to the wrong cell', async () => {
    // 0…10 across 3 columns puts the column boundaries at 3.33 and 6.67, so a whole-number label
    // near a middle cell's centre still has to land in that cell.
    const chart = makeChart(3, 3, 0, 10);
    const { canvas } = build(chart);
    canvas.setSelectedCell(1, 1);
    const item = await addWithNoCoords(canvas, chart);
    expect(cellAt(chart, item.x, item.y)).toEqual({ col: 1, row: 1 });
  });

  it('handles a negative range without clamping into the top cell', async () => {
    const chart = makeChart(2, 2, -10, -2);
    const { canvas } = build(chart);
    canvas.setSelectedCell(0, 0);
    const item = await addWithNoCoords(canvas, chart);
    expect(cellAt(chart, item.x, item.y)).toEqual({ col: 0, row: 0 });
  });

  it('honours an explicit position, so double-click placement is unaffected', async () => {
    const chart = makeChart(2, 2);
    const { canvas } = build(chart);
    canvas.setSelectedCell(0, 0);            // deliberately NOT where the label is going
    await canvas.addItem(-4, 4);
    const item = canvas.getChart().items[0];
    expect({ x: item.x, y: item.y }).toEqual({ x: -4, y: 4 });
    expect(cellAt(chart, item.x, item.y)).toEqual({ col: 0, row: 1 });
  });

  it('gives two labels in one cell distinct ids', async () => {
    const chart = makeChart(2, 2);
    const { canvas } = build(chart);
    canvas.setSelectedCell(1, 0);
    await canvas.addItem();
    await canvas.addItem();
    const items = canvas.getChart().items;
    expect(items).toHaveLength(2);
    expect(items[0].id).not.toBe(items[1].id);
  });

  it('still saves through onChange, so the label reaches the file', async () => {
    const chart = makeChart(2, 2);
    const { canvas, changes } = build(chart);
    canvas.setSelectedCell(0, 1);
    await canvas.addItem();
    expect(changes).toHaveLength(1);
    expect(changes[0].items).toHaveLength(1);
  });

  it('does not add anything when the prompt is cancelled', async () => {
    const chart = makeChart(2, 2);
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
    document.body.appendChild(container);
    const changes: Chart[] = [];
    const canvas = new ChartCanvas(container, chart, {
      onChange: (c) => changes.push(c),
      onSelectCell: () => undefined,
      promptText: async () => null,
    });
    canvas.measure();
    canvas.render();
    await canvas.addItem();
    expect(canvas.getChart().items).toHaveLength(0);
    expect(changes).toHaveLength(0);
  });
});

describe('the selected cell is chosen by clicking, which is what makes this work', () => {
  // The behaviour above depends on a click setting the selection. Without a selection, "the selected
  // cell" has no meaning, and the fallback would silently move to the middle.
  it('a click on a cell hit rect sets the selection that addItem then uses', () => {
    const chart = makeChart(2, 2);
    const { canvas } = build(chart);
    const rect = (canvas['svg'] as SVGSVGElement)
      .querySelector('rect[data-cell-col="0"][data-cell-row="0"]')!;
    expect(rect).toBeTruthy();
    rect.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(canvas.getSelectedCell()).toEqual({ col: 0, row: 0 });
  });
});