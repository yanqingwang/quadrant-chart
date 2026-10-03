/**
 * @jest-environment jsdom
 *
 * Two things a label needs that it could not do before:
 *
 *  1. **A font size you can choose.** `items[].size` was read from the file, honoured by the canvas
 *     and honoured by the exporter — and there was no UI anywhere that could set it. A format field
 *     with no writer is a field only a hand-editor can use, which is not the same as being a feature.
 *
 *  2. **A way to select a label that is under another.** Two labels at the same coordinate are
 *     indistinguishable in the file except by which comes first, and a pointer event only ever
 *     reports the topmost one. So the lower label was unreachable — clicking it always hit the one
 *     above. Two fixes: clicking the same spot again steps down the stack, and the label menu can
 *     reorder explicitly.
 *
 * The overlap tests are the interesting ones. jsdom does no hit testing, so they dispatch on the
 * real hit plate AND drive the geometric stack lookup the cycling depends on — the same thing the
 * click handler does.
 */
import { ChartCanvas } from '../src/canvas';
import { Chart, createChart } from '../src/model';

const FILE = { path: 'c.mdx' } as never;

function build(chart: Chart) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
  document.body.appendChild(container);
  const changes: Chart[] = [];
  const canvas = new ChartCanvas(container, chart, {
    onChange: (c) => changes.push(c),
    onSelectCell: () => undefined,
    promptText: async (d) => d,
  });
  canvas.measure();
  canvas.render();
  const svg = canvas['svg'] as SVGSVGElement;
  // jsdom implements no SVGAnimatedRect, so `svgPoint` would throw inside the click handler and the
  // gesture would silently do nothing.
  Object.defineProperty(svg, 'viewBox', { value: { baseVal: { width: 800, height: 600 } }, configurable: true });
  svg.setPointerCapture = () => undefined;
  svg.releasePointerCapture = () => undefined;
  return { canvas, changes, svg };
}

const svgOf = (c: ChartCanvas) => c['svg'] as SVGSVGElement;

function withItems(...items: Partial<Chart['items'][number]>[]): Chart {
  const c = createChart(2, 2);
  return {
    ...c,
    items: items.map((p, i) => ({ id: p.id ?? `l${i}`, text: p.text ?? `L${i}`, x: p.x ?? 1, y: p.y ?? 1, ...p })) as Chart['items'],
  };
}

// ── font size ─────────────────────────────────────────────────────────────────

describe('a label can be given a font size', () => {
  it('stores it', () => {
    const { canvas, changes } = build(withItems({ text: 'Sized' }));
    canvas.setItemSize('l0', 24);
    expect(canvas.getChart().items[0].size).toBe(24);
    expect(changes).toHaveLength(1);
  });

  it('clears the override when passed null', () => {
    const { canvas } = build(withItems({ text: 'Sized', size: 24 }));
    expect(canvas.getChart().items[0].size).toBe(24);
    canvas.setItemSize('l0', null);
    expect(canvas.getChart().items[0].size).toBeUndefined();
  });

  it('actually changes the rendered font size', () => {
    const { canvas, svg } = build(withItems({ text: 'Sized' }));
    const sizeOf = () => Number(svg.querySelector('.qc-item-text')!.getAttribute('font-size'));
    const before = sizeOf();
    canvas.setItemSize('l0', 32);
    expect(sizeOf()).toBe(32);
    expect(sizeOf()).not.toBe(before);
  });

  it('widens the click target along with the text', () => {
    // A bigger label is a bigger target; a hit plate sized for the old text would leave the new
    // glyphs' edges outside it, which is the bug the width estimate originally caused.
    const { canvas, svg } = build(withItems({ text: 'A fairly long label here' }));
    const widthOf = () => Number(svg.querySelector('.qc-item-hit')!.getAttribute('width'));
    const before = widthOf();
    canvas.setItemSize('l0', 48);
    expect(widthOf()).toBeGreaterThan(before);
  });

  it('clamps to the model limits instead of accepting nonsense', () => {
    const { canvas } = build(withItems({ text: 'Clamped' }));
    canvas.setItemSize('l0', 5000);
    expect(canvas.getChart().items[0].size).toBe(96);    // LIMITS.maxFontSize
    canvas.setItemSize('l0', 1);
    expect(canvas.getChart().items[0].size).toBe(8);     // LIMITS.minFontSize
  });

  it('rounds a fractional size, so the file holds an integer', () => {
    const { canvas } = build(withItems({ text: 'Rounded' }));
    canvas.setItemSize('l0', 18.6);
    expect(canvas.getChart().items[0].size).toBe(19);
  });

  it('ignores an id that is not there', () => {
    const { canvas, changes } = build(withItems({ text: 'Only' }));
    canvas.setItemSize('nope', 20);
    expect(changes).toHaveLength(0);
  });

  it('pushes no undo snapshot when the size is unchanged', () => {
    const { canvas } = build(withItems({ text: 'Same', size: 20 }));
    canvas.setItemSize('l0', 20);
    expect(canvas.canUndo()).toBe(false);
  });

  it('pushes exactly one snapshot per real change', () => {
    const { canvas } = build(withItems({ text: 'Real' }));
    canvas.setItemSize('l0', 20);
    canvas.setItemSize('l0', 30);
    canvas.undo();
    expect(canvas.getChart().items[0].size).toBe(20);
    canvas.undo();
    expect(canvas.getChart().items[0].size).toBeUndefined();
  });

  it('round-trips through the file format', () => {
    const { canvas } = build(withItems({ text: 'Persisted', size: 32 }));
    const written = require('../src/mdx').chartToFileText(canvas.getChart());
    expect(written).toContain('size: 32');
    expect(require('../src/mdx').parseChartFromText(written)!.items[0].size).toBe(32);
  });

  it('undo restores a cleared size', () => {
    const { canvas } = build(withItems({ text: 'Undoable', size: 32 }));
    canvas.setItemSize('l0', null);
    expect(canvas.getChart().items[0].size).toBeUndefined();
    canvas.undo();
    expect(canvas.getChart().items[0].size).toBe(32);
  });
});

// ── overlapping labels ────────────────────────────────────────────────────────

/** Click the hit plate of `id`, at a client point. */
function clickLabel(svg: SVGSVGElement, id: string, clientX: number, clientY: number): void {
  const el = svg.querySelector(`g[data-item-id="${id}"] .qc-item-hit`);
  if (!el) throw new Error(`no hit plate for ${id}`);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }));
}

describe('a label under another can be selected', () => {
  // Two labels at exactly the same data coordinate: their hit plates coincide completely, which is
  // the worst case and the one that makes the label underneath unreachable.
  const stacked = () => withItems(
    { id: 'under', text: 'Underneath', x: 5, y: 5 },
    { id: 'over', text: 'On top of it', x: 5, y: 5 },
  );

  it('lists the overlapping labels topmost first', () => {
    const { canvas } = build(stacked());
    // The plot centre in screen coords for a 2x2 over -5..5 with the default margins.
    const centre = { x: 64 + (800 - 64 - 24) / 2, y: 32 + (600 - 32 - 56) / 2 };
    const ids = canvas.labelsAt(centre.x, centre.y).map((i) => i.id);
    expect(ids).toEqual(['over', 'under']);
  });

  it('finds nothing at a point with no label', () => {
    const { canvas } = build(stacked());
    expect(canvas.labelsAt(5, 5)).toEqual([]);
  });

  it('a first click selects the topmost label', () => {
    const { canvas, svg } = build(stacked());
    const centre = { x: 64 + (800 - 64 - 24) / 2, y: 32 + (600 - 32 - 56) / 2 };
    clickLabel(svg, 'over', centre.x, centre.y);
    expect(canvas.getSelectedItem()).toBe('over');
  });

  it('clicking the same spot again steps down to the one underneath', () => {
    const { canvas, svg } = build(stacked());
    const centre = { x: 64 + (800 - 64 - 24) / 2, y: 32 + (600 - 32 - 56) / 2 };
    clickLabel(svg, 'over', centre.x, centre.y);
    expect(canvas.getSelectedItem()).toBe('over');
    // The DOM still reports 'over' as the target, because it is on top — only the stack lookup can
    // find the one below, which is exactly why this works at all.
    clickLabel(svg, 'over', centre.x, centre.y);
    expect(canvas.getSelectedItem()).toBe('under');
  });

  it('wraps round the stack rather than sticking', () => {
    const { canvas, svg } = build(stacked());
    const centre = { x: 64 + (800 - 64 - 24) / 2, y: 32 + (600 - 32 - 56) / 2 };
    clickLabel(svg, 'over', centre.x, centre.y);
    clickLabel(svg, 'over', centre.x, centre.y);   // under
    clickLabel(svg, 'over', centre.x, centre.y);   // wraps back to over
    expect(canvas.getSelectedItem()).toBe('over');
  });

  it('steps through three stacked labels', () => {
    const { canvas, svg } = build(withItems(
      { id: 'a', text: 'Bottom layer', x: 5, y: 5 },
      { id: 'b', text: 'Middle layer', x: 5, y: 5 },
      { id: 'c', text: 'Top layer', x: 5, y: 5 },
    ));
    const centre = { x: 64 + (800 - 64 - 24) / 2, y: 32 + (600 - 32 - 56) / 2 };
    expect(canvas.labelsAt(centre.x, centre.y).map((i) => i.id)).toEqual(['c', 'b', 'a']);
    clickLabel(svg, 'c', centre.x, centre.y);
    expect(canvas.getSelectedItem()).toBe('c');
    clickLabel(svg, 'c', centre.x, centre.y);
    expect(canvas.getSelectedItem()).toBe('b');
    clickLabel(svg, 'c', centre.x, centre.y);
    expect(canvas.getSelectedItem()).toBe('a');
  });

  it('does not cycle when only one label is under the pointer', () => {
    const { canvas, svg } = build(withItems({ id: 'solo', text: 'Alone', x: 5, y: 5 }));
    const centre = { x: 64 + (800 - 64 - 24) / 2, y: 32 + (600 - 32 - 56) / 2 };
    clickLabel(svg, 'solo', centre.x, centre.y);
    clickLabel(svg, 'solo', centre.x, centre.y);
    expect(canvas.getSelectedItem()).toBe('solo');
  });

  it('resets the cycle when a different label elsewhere is selected', () => {
    const { canvas, svg } = build(withItems(
      { id: 'away', text: 'Elsewhere', x: 0, y: 0 },
      { id: 'over', text: 'On top', x: 5, y: 5 },
      { id: 'under', text: 'Underneath', x: 5, y: 5 },
    ));
    const centre = { x: 64 + (800 - 64 - 24) / 2, y: 32 + (600 - 32 - 56) / 2 };
    clickLabel(svg, 'over', centre.x, centre.y);
    expect(canvas.getSelectedItem()).toBe('over');
    // Selecting something unrelated must not leave the cursor mid-stack.
    clickLabel(svg, 'away', 200, 200);
    expect(canvas.getSelectedItem()).toBe('away');
    clickLabel(svg, 'over', centre.x, centre.y);
    expect(canvas.getSelectedItem()).toBe('over');
  });

  it('overlapping labels are not mistaken for a cell selection', () => {
    const { canvas, svg } = build(stacked());
    const centre = { x: 64 + (800 - 64 - 24) / 2, y: 32 + (600 - 32 - 56) / 2 };
    clickLabel(svg, 'over', centre.x, centre.y);
    clickLabel(svg, 'over', centre.x, centre.y);
    expect(canvas.getSelectedCell()).toBeNull();
  });
});

describe('label paint order is explicit', () => {
  const three = () => withItems(
    { id: 'a', text: 'First', x: 1, y: 1 },
    { id: 'b', text: 'Second', x: 2, y: 2 },
    { id: 'c', text: 'Third', x: 3, y: 3 },
  );

  it('brings a label to the front', () => {
    const { canvas, changes } = build(three());
    canvas.reorderItem('a', 'front');
    expect(canvas.getChart().items.map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(changes).toHaveLength(1);
  });

  it('sends a label to the back', () => {
    const { canvas } = build(three());
    canvas.reorderItem('c', 'back');
    expect(canvas.getChart().items.map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps every label — reordering moves, it never drops', () => {
    const { canvas } = build(three());
    canvas.reorderItem('b', 'front');
    canvas.reorderItem('b', 'back');
    expect(canvas.getChart().items.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('changes the topmost label at an overlapping point', () => {
    const { canvas } = build(withItems(
      { id: 'under', text: 'Underneath', x: 5, y: 5 },
      { id: 'over', text: 'On top', x: 5, y: 5 },
    ));
    const centre = { x: 64 + (800 - 64 - 24) / 2, y: 32 + (600 - 32 - 56) / 2 };
    expect(canvas.labelsAt(centre.x, centre.y).map((i) => i.id)).toEqual(['over', 'under']);
    canvas.reorderItem('under', 'front');
    // The label that was buried is now the one a first click reaches.
    expect(canvas.labelsAt(centre.x, centre.y).map((i) => i.id)).toEqual(['under', 'over']);
  });

  it('does nothing when the label is already at that end', () => {
    const { canvas, changes } = build(three());
    canvas.reorderItem('c', 'front');
    expect(changes).toHaveLength(0);
    canvas.reorderItem('a', 'back');
    expect(changes).toHaveLength(0);
  });

  it('does nothing for a single label', () => {
    const { canvas, changes } = build(withItems({ text: 'Only one' }));
    canvas.reorderItem('l0', 'front');
    canvas.reorderItem('l0', 'back');
    expect(changes).toHaveLength(0);
  });

  it('is undoable', () => {
    const { canvas } = build(three());
    canvas.reorderItem('a', 'front');
    expect(canvas.getChart().items.map((i) => i.id)).toEqual(['b', 'c', 'a']);
    canvas.undo();
    expect(canvas.getChart().items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('ignores an id that is not there', () => {
    const { canvas, changes } = build(three());
    canvas.reorderItem('nope', 'front');
    expect(changes).toHaveLength(0);
  });

  it('persists in the file, since order is content', () => {
    const { canvas } = build(three());
    canvas.reorderItem('a', 'front');
    const parsed = require('../src/mdx').parseChartFromText(
      require('../src/mdx').chartToFileText(canvas.getChart()),
    )!;
    expect(parsed.items.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('a resized label is still hit-testable at its new size', () => {
  it('the stack lookup reflects the current font size', () => {
    const { canvas } = build(withItems(
      { id: 'big', text: 'A very long label indeed', x: 5, y: 5, size: 40 },
      { id: 'small', text: 'x', x: 5, y: 5 },
    ));
    const centre = { x: 64 + (800 - 64 - 24) / 2, y: 32 + (600 - 32 - 56) / 2 };
    // Both are at the same point, so both are found regardless of size.
    expect(canvas.labelsAt(centre.x, centre.y).map((i) => i.id)).toEqual(['small', 'big']);
    // Only the large label covers a point far to the side of the centre.
    const edge = centre.x + 60;
    expect(canvas.labelsAt(edge, centre.y).map((i) => i.id)).toEqual(['big']);
  });

  it('a label resized larger starts catching clicks it previously missed', () => {
    const { canvas } = build(withItems({ id: 'solo', text: 'Short', x: 5, y: 5 }));
    const centre = { x: 64 + (800 - 64 - 24) / 2, y: 32 + (600 - 32 - 56) / 2 };
    const edge = centre.x + 60;
    expect(canvas.labelsAt(edge, centre.y)).toEqual([]);
    canvas.setItemSize('solo', 48);
    expect(canvas.labelsAt(edge, centre.y).map((i) => i.id)).toEqual(['solo']);
  });
});