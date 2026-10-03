/**
 * @jest-environment jsdom
 *
 * Clicking a label selects the label, not the cell underneath it.
 *
 * The reported symptom was "clicking on text selects the cell". Two independent defects combined:
 *
 *  1. `.qc-item-hit` was an 8px-wide strip centred on the label's anchor point. The cell hit rects
 *     cover the entire plot, so any click beside the glyphs — most of the label's own area — landed
 *     on a cell instead. It was hit-testable at all only by luck.
 *  2. `onClick` tested for a cell BEFORE testing for a label. So even a click that did land on the
 *     label could only ever select the cell.
 *
 * Fixing one without the other changes nothing, which is why both are asserted here.
 *
 * Testing note, from the same trap that bit this file's neighbours: jsdom does no hit testing, so an
 * event dispatched on the <svg> always targets the <svg>. Every click below is dispatched on the
 * actual target element, and the OVERLAP that jsdom cannot resolve is asserted structurally instead.
 */
import { ChartCanvas } from '../src/canvas';
import { Chart, createChart } from '../src/model';

const FILE = { path: 'c.mdx' } as never;

function build(chart: Chart) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
  document.body.appendChild(container);
  const cells: [number, number][] = [];
  const canvas = new ChartCanvas(container, chart, {
    onChange: () => undefined,
    onSelectCell: (col, row) => cells.push([col, row]),
    promptText: async (def) => def,
  });
  canvas.measure();
  canvas.render();
  return { canvas, cells, svg: canvas['svg'] as SVGSVGElement };
}

function withItems(...texts: string[]): Chart {
  const c = createChart(2, 2);
  return {
    ...c,
    x: { label: 'X', min: -5, max: 5 },
    y: { label: 'Y', min: -5, max: 5 },
    items: texts.map((t, i) => ({ id: `lbl${i}`, text: t, x: -1 + i * 2, y: 3 })),
  };
}

/** Click the hit plate of a label. */
function clickLabel(svg: SVGSVGElement, id: string): void {
  const el = svg.querySelector(`g[data-item-id="${id}"] .qc-item-hit`);
  if (!el) throw new Error(`no hit plate for label ${id}`);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Click a cell's hit rect. */
function clickCell(svg: SVGSVGElement, col: number, row: number): void {
  const el = svg.querySelector(`rect[data-cell-col="${col}"][data-cell-row="${row}"]`);
  if (!el) throw new Error(`no hit rect for cell ${col},${row}`);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('clicking a label selects the label', () => {
  it('selects the label and not the cell', () => {
    const { canvas, cells } = build(withItems('A long label that spans some width'));
    clickLabel(canvas['svg'] as SVGSVGElement, 'lbl0');
    expect(canvas.getSelectedItem()).toBe('lbl0');
    expect(canvas.getSelectedCell()).toBeNull();
    expect(cells).toEqual([]);                       // onSelectCell must not fire
  });

  it('clears a cell selection that was already active', () => {
    const { canvas, svg } = build(withItems('Hello'));
    clickCell(svg, 0, 0);
    expect(canvas.getSelectedCell()).toEqual({ col: 0, row: 0 });
    clickLabel(svg, 'lbl0');
    expect(canvas.getSelectedItem()).toBe('lbl0');
    expect(canvas.getSelectedCell()).toBeNull();
  });

  it('selects whichever label was clicked', () => {
    const { canvas, svg } = build(withItems('First', 'Second', 'Third'));
    clickLabel(svg, 'lbl1');
    expect(canvas.getSelectedItem()).toBe('lbl1');
    clickLabel(svg, 'lbl2');
    expect(canvas.getSelectedItem()).toBe('lbl2');
  });

  it('selects a label in a cell other than the one that was previously selected', () => {
    const { canvas, svg } = build(withItems('Top label'));
    clickCell(svg, 0, 0);                            // bottom-left
    clickLabel(svg, 'lbl0');                         // label sits high up
    expect(canvas.getSelectedItem()).toBe('lbl0');
    expect(canvas.getSelectedCell()).toBeNull();
  });
});

describe('the label hit plate is actually clickable', () => {
  // Structural, because jsdom cannot resolve what overlaps what. These assert the geometry that
  // decides which element receives the click in a real browser.
  it('is far wider than the 8px strip it replaced', () => {
    const { svg } = build(withItems('A reasonably long label'));
    const hit = svg.querySelector('g[data-item-id="lbl0"] .qc-item-hit') as SVGRectElement;
    expect(Number(hit.getAttribute('width'))).toBeGreaterThan(60);
  });

  it('scales with the text, so a long label is not harder to hit than a short one', () => {
    const { canvas } = build(withItems('x', 'A much longer label indeed'));
    const svg = canvas['svg'] as SVGSVGElement;
    const w = (id: string) =>
      Number(svg.querySelector(`g[data-item-id="${id}"] .qc-item-hit`)!.getAttribute('width'));
    expect(w('lbl1')).toBeGreaterThan(w('lbl0'));
  });

  it('is centred on the label anchor', () => {
    const { svg } = build(withItems('Centred'));
    const hit = svg.querySelector('g[data-item-id="lbl0"] .qc-item-hit') as SVGRectElement;
    const x = Number(hit.getAttribute('x'));
    const width = Number(hit.getAttribute('width'));
    expect(x + width / 2).toBeCloseTo(0, 5);        // the <g> is translated to the anchor
  });

  it('covers the vertical extent of the text', () => {
    const { svg } = build(withItems('Height'));
    const hit = svg.querySelector('g[data-item-id="lbl0"] .qc-item-hit') as SVGRectElement;
    expect(Number(hit.getAttribute('height'))).toBeGreaterThanOrEqual(14);
  });

  it('sizes CJK labels by full-width characters, not Latin half-widths', () => {
    // Equal CHARACTER counts, so the only variable is the per-character width. Five CJK glyphs are
    // five em; five Latin glyphs are about 2.75. Under-estimating here would put the edge of a
    // Chinese label outside its own hit area — the same class of bug as the 8px strip, and for the
    // labels this plugin is most used with.
    const { canvas } = build({ ...withItems(), items: [
      { id: 'cn', text: '人才九宫格', x: 0, y: 0 },   // 5 full-width
      { id: 'en', text: 'abcde', x: 0, y: 0 },       // 5 half-width
    ] });
    const svg = canvas['svg'] as SVGSVGElement;
    const w = (id: string) =>
      Number(svg.querySelector(`g[data-item-id="${id}"] .qc-item-hit`)!.getAttribute('width'));
    expect(w('cn')).toBeCloseTo(70, 5);              // exactly 5 em at the 14px default
    expect(w('cn')).toBeGreaterThan(w('en') * 1.7);
  });

  it('gives even a one-character label a clickable target', () => {
    const { svg } = build(withItems('A'));
    const hit = svg.querySelector('g[data-item-id="lbl0"] .qc-item-hit') as SVGRectElement;
    expect(Number(hit.getAttribute('width'))).toBeGreaterThanOrEqual(14);
  });

  it('honours a larger font size', () => {
    const { canvas } = build({ ...withItems(), items: [{ id: 'big', text: 'Sized', x: 0, y: 0, size: 40 }] });
    const svg = canvas['svg'] as SVGSVGElement;
    const small = Number(
      svg.querySelector('g[data-item-id="big"] .qc-item-hit')!.getAttribute('width'),
    );
    const { svg: svg2 } = build(withItems('Sized'));
    const normal = Number(
      (svg2.querySelector('g[data-item-id="lbl0"] .qc-item-hit') as SVGRectElement)
        .getAttribute('width'),
    );
    expect(small).toBeGreaterThan(normal);
  });
});

describe('the selection box is drawn on the selected label only', () => {
  it('appears on click', () => {
    const { canvas, svg } = build(withItems('Selectable'));
    expect(svg.querySelector('.qc-item-selected')).toBeNull();
    clickLabel(svg, 'lbl0');
    expect(svg.querySelector('g[data-item-id="lbl0"] .qc-item-selected')).not.toBeNull();
  });

  it('is on exactly one label at a time', () => {
    const { canvas, svg } = build(withItems('One', 'Two'));
    clickLabel(svg, 'lbl0');
    expect(svg.querySelectorAll('.qc-item-selected')).toHaveLength(1);
    clickLabel(svg, 'lbl1');
    expect(svg.querySelectorAll('.qc-item-selected')).toHaveLength(1);
    expect(svg.querySelector('g[data-item-id="lbl1"] .qc-item-selected')).not.toBeNull();
  });

  it('marks the group so CSS can style the selected label', () => {
    const { canvas, svg } = build(withItems('Marked'));
    clickLabel(svg, 'lbl0');
    expect(svg.querySelector('g[data-item-id="lbl0"]')!.getAttribute('class')).toContain('qc-selected');
  });

  it('frames the label rather than covering the text', () => {
    const { canvas, svg } = build(withItems('Framed'));
    clickLabel(svg, 'lbl0');
    const g = svg.querySelector('g[data-item-id="lbl0"]')!;
    const box = g.querySelector('.qc-item-selected')!;
    const text = g.querySelector('.qc-item-text')!;
    const kids = Array.from(g.children).map((c) => c.getAttribute('class'));
    // The box must be painted before the text, or it would sit on top of the glyphs.
    expect(kids.indexOf('qc-item-selected')).toBeLessThan(kids.indexOf('qc-item-text'));
    expect(Number(box.getAttribute('width')))
      .toBeGreaterThan(Number(svg.querySelector('.qc-item-hit')!.getAttribute('width')));
    expect(text.textContent).toBe('Framed');
  });

  it('disappears when a cell is selected instead', () => {
    const { canvas, svg } = build(withItems('Temporary'));
    clickLabel(svg, 'lbl0');
    expect(svg.querySelectorAll('.qc-item-selected')).toHaveLength(1);
    clickCell(svg, 1, 1);
    expect(svg.querySelectorAll('.qc-item-selected')).toHaveLength(0);
    expect(canvas.getSelectedItem()).toBeNull();
  });

  it('does not survive the label being deleted', () => {
    const { canvas, svg } = build(withItems('Doomed'));
    clickLabel(svg, 'lbl0');
    canvas['onContextMenu']?.({
      preventDefault: () => undefined,
      target: svg.querySelector('g[data-item-id="lbl0"] .qc-item-hit'),
    } as unknown as MouseEvent);
    expect(canvas.getSelectedItem()).toBeNull();
    expect(svg.querySelectorAll('.qc-item-selected')).toHaveLength(0);
  });

  it('can be cleared programmatically', () => {
    const { canvas, svg } = build(withItems('Clearable'));
    clickLabel(svg, 'lbl0');
    canvas.setSelectedItem(null);
    expect(canvas.getSelectedItem()).toBeNull();
    expect(svg.querySelectorAll('.qc-item-selected')).toHaveLength(0);
  });
});

describe('cell selection still works', () => {
  // The label branch running first must not have broken the feature it was ordered ahead of.
  it('selects a cell on a click that misses every label', () => {
    const { canvas, cells, svg } = build(withItems('Only label'));
    clickCell(svg, 0, 1);
    expect(canvas.getSelectedCell()).toEqual({ col: 0, row: 1 });
    expect(canvas.getSelectedItem()).toBeNull();
    expect(cells).toEqual([[0, 1]]);
  });

  it('reports every cell to onSelectCell', () => {
    const { canvas, cells, svg } = build(createChart(3, 3));
    clickCell(svg, 0, 0); clickCell(svg, 1, 0); clickCell(svg, 2, 2);
    expect(cells).toEqual([[0, 0], [1, 0], [2, 2]]);
  });

  it('a cell click on an empty chart still selects', () => {
    const { canvas } = build(createChart(2, 2));
    clickCell(canvas['svg'] as SVGSVGElement, 1, 0);
    expect(canvas.getSelectedCell()).toEqual({ col: 1, row: 0 });
  });
});