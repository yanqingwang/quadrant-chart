/**
 * @jest-environment jsdom
 *
 * A double-click on a label must EDIT that label. It used to create a new one instead.
 *
 * The mechanism, which is why this is easy to get wrong and hard to see:
 *
 *   1. The first click of a double-click runs `selectItem`, and `selectItem` calls `render()`.
 *   2. `render()` is a full teardown — `while (svg.firstChild) svg.removeChild(svg.firstChild)` —
 *      so the `<text>` node the pointer is sitting on is destroyed and rebuilt.
 *   3. A browser resolves a `dblclick`'s target to the nearest common ancestor of its two mousedown
 *      targets. The first one has been detached, so the event lands on the `<svg>`.
 *   4. `target.closest('.qc-item')` is then null, the handler falls through to its "empty plot area"
 *      branch, and a brand-new label appears where the user meant to edit an existing one.
 *
 * The tests dispatch the `dblclick` on the `<svg>`, which is what the browser does once the original
 * target is gone, and assert that the first click really did detach the node — so if `render()` ever
 * stops rebuilding, this file says so instead of quietly testing something else.
 */
import { ChartCanvas } from '../src/canvas';
import { Chart, createChart } from '../src/model';
import { dataToScreenX, dataToScreenY } from '../src/geometry';

const W = 800;
const H = 600;

function build(chart: Chart) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: W, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: H, configurable: true });
  document.body.appendChild(container);

  const prompted: Array<[string, string]> = [];
  const canvas = new ChartCanvas(container, chart, {
    onChange: () => undefined,
    onSelectCell: () => undefined,
    promptText: async (def, title) => {
      prompted.push([def, title]);
      return def;
    },
  });
  canvas.measure();

  const svg = canvas['svg'] as SVGSVGElement;
  // jsdom implements neither the animated viewBox nor layout, and `svgPoint` needs both.
  Object.defineProperty(svg, 'viewBox', {
    value: { baseVal: { width: W, height: H } }, configurable: true,
  });
  Object.defineProperty(svg, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0 }),
    configurable: true,
  });

  canvas.render();
  return { canvas, svg, prompted };
}

function oneLabel(): Chart {
  const c = createChart(2, 2);
  return {
    ...c,
    x: { label: 'X', min: -10, max: 10 },
    y: { label: 'Y', min: -10, max: 10 },
    items: [{ id: 'lbl0', text: 'Editable label', x: 2, y: 3 }],
  };
}

/** Screen point at the centre of the label, in the same units `svgPoint` produces. */
function labelPoint(canvas: ChartCanvas): { x: number; y: number } {
  const plot = canvas['plot'];
  const chart = canvas.getChart();
  const item = chart.items[0];
  return { x: dataToScreenX(item.x, chart.x, plot), y: dataToScreenY(item.y, chart.y, plot) };
}

/** What a browser actually does over a double-click: click, then dblclick retargeted to the <svg>. */
function doubleClick(svg: SVGSVGElement, x: number, y: number): void {
  const first = svg.querySelector('g[data-item-id="lbl0"] .qc-item-hit');
  if (!first) throw new Error('no hit plate for the label');
  first.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
  // The whole point of the reproduction: selecting rebuilt the tree, so the node the pointer was
  // over no longer exists in the document.
  expect(document.contains(first)).toBe(false);
  svg.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }));
}

describe('double-clicking a label edits it', () => {
  it('offers the current text for editing instead of creating a label', async () => {
    const { canvas, svg, prompted } = build(oneLabel());
    const p = labelPoint(canvas);
    doubleClick(svg, p.x, p.y);
    await Promise.resolve();

    expect(prompted).toEqual([['Editable label', 'Edit label']]);
  });

  it('does not add a second label', async () => {
    const { canvas, svg } = build(oneLabel());
    const p = labelPoint(canvas);
    doubleClick(svg, p.x, p.y);
    await Promise.resolve();

    expect(canvas.getChart().items.map((i) => i.text)).toEqual(['Editable label']);
  });

  it('edits the label the user cycled to when two overlap', async () => {
    const chart = oneLabel();
    // Same position, so `labelsAt` returns both; the later one is painted on top.
    chart.items = [
      { id: 'under', text: 'Underneath', x: 2, y: 3 },
      { id: 'over', text: 'On top', x: 2, y: 3 },
    ];
    const { canvas, svg, prompted } = build(chart);
    const p = labelPoint(canvas);

    // Each click has to land on the label the way the browser aims it: the topmost one. Re-queried
    // every time, because selecting re-renders and replaces the node.
    const clickTopmost = (): void => {
      const hit = svg.querySelector('g[data-item-id="over"] .qc-item-hit');
      if (!hit) throw new Error('no hit plate on the top label');
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: p.x, clientY: p.y }));
    };

    // Two single clicks cycle the selection down to the hidden label…
    clickTopmost();
    expect(canvas.getSelectedItem()).toBe('over');
    clickTopmost();
    expect(canvas.getSelectedItem()).toBe('under');

    // …and the double-click must then edit that same one, not jump back to the top.
    svg.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: p.x, clientY: p.y }));
    await Promise.resolve();

    expect(prompted).toEqual([['Underneath', 'Edit label']]);
  });
});

describe('double-clicking empty plot area still creates a label', () => {
  it('offers a new label', async () => {
    const { canvas, svg, prompted } = build(oneLabel());
    // A point inside the plot that no label covers.
    const plot = canvas['plot'];
    const cx = plot.x + plot.width / 2;
    const cy = plot.y + plot.height / 2;
    svg.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: cx, clientY: cy }));
    await Promise.resolve();

    expect(prompted).toEqual([['New label', 'Add label']]);
    expect(canvas.getChart().items).toHaveLength(2);
  });

  it('ignores a double-click outside the plot entirely', async () => {
    const { canvas, svg, prompted } = build(oneLabel());
    // Far above the plot: in the top margin, where the axis captions live.
    svg.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 400, clientY: 2 }));
    await Promise.resolve();

    expect(prompted).toEqual([]);
    expect(canvas.getChart().items).toHaveLength(1);
  });
});