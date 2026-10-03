/**
 * @jest-environment jsdom
 *
 * Undo for canvas edits.
 *
 * Why this is not free: every canvas edit is written straight to the file the moment it is
 * committed, and nothing is buffered. That is the right default for a note-taking tool — a crash or a
 * closed tab never loses an edit — but it means Obsidian's own undo stack does not cover canvas
 * changes, because the plugin never goes through the editor. So an accidental drag, a mis-click that
 * deleted a label, or a grid resize had exactly one recovery route: hand-editing the YAML.
 *
 * The stack here is bounded and snapshot-based. A snapshot of a whole Chart is a few hundred bytes
 * for a realistic chart, so holding a few dozen is nothing; the alternative — diffing — would have
 * to reason about partial gestures and is where undo bugs actually live.
 *
 * Two rules the tests below pin:
 *  - A push happens BEFORE a change, storing the state to return TO.
 *  - A push must not happen for a change that did not change anything, or undo would appear to work
 *    while doing nothing.
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
  const canvas = new ChartCanvas({} as never, container, chart, {
    file: FILE,
    onChange: (c) => changes.push(c),
    onSelectCell: () => undefined,
    promptText: async (d) => d,
  });
  canvas.measure();
  canvas.render();
  return { canvas, changes, svg: canvas['svg'] as SVGSVGElement };
}

/** A canvas whose prompts answer with `answer`, so an edit actually changes something. */
function buildAnswering(chart: Chart, answer: string) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
  document.body.appendChild(container);
  const canvas = new ChartCanvas({} as never, container, chart, {
    file: FILE, onChange: () => undefined, onSelectCell: () => undefined,
    // Returning the default would make every edit a no-op, which tests nothing.
    promptText: async () => answer,
  });
  canvas.measure();
  canvas.render();
  return { canvas, svg: canvas['svg'] as SVGSVGElement };
}

function one(extra: Partial<Chart['items'][number]> = {}): Chart {
  const c = createChart(2, 2);
  return { ...c, items: [{ id: 'a', text: 'Label', x: 1, y: 1, ...extra }] };
}

describe('the undo stack', () => {
  it('starts empty', () => {
    const { canvas } = build(one());
    expect(canvas.canUndo()).toBe(false);
  });

  it('cannot undo a chart that has never been edited', () => {
    const { canvas } = build(one());
    canvas.undo();
    expect(canvas.getChart().items).toHaveLength(1);
  });

  it('records a snapshot before a change', () => {
    const { canvas } = build(one());
    expect(canvas.canUndo()).toBe(false);
    canvas.removeItem('a');
    expect(canvas.canUndo()).toBe(true);
  });

  it('undo does not itself become undoable', () => {
    // Otherwise one undo becomes two, and the stack never drains.
    const { canvas } = build(one());
    canvas.removeItem('a');
    canvas.undo();
    expect(canvas.canUndo()).toBe(false);
    expect(canvas.getChart().items).toHaveLength(1);
  });

  it('drains one step at a time', async () => {
    const { canvas } = build(createChart(2, 2));
    await canvas.addItem(1, 1);
    await canvas.addItem(2, 2);
    expect(canvas.getChart().items).toHaveLength(2);
    canvas.undo();
    expect(canvas.getChart().items).toHaveLength(1);
    canvas.undo();
    expect(canvas.getChart().items).toHaveLength(0);
    expect(canvas.canUndo()).toBe(false);
  });

  it('forgets the future when a new change follows an undo', async () => {
    // Standard undo behaviour: editing after undoing discards the redo branch, rather than leaving
    // a stack where undo walks into a state that never happened.
    const { canvas } = build(createChart(2, 2));
    await canvas.addItem(1, 1);
    await canvas.addItem(2, 2);
    canvas.undo();
    await canvas.addItem(3, 3);
    expect(canvas.getChart().items).toHaveLength(2);
    canvas.undo();
    expect(canvas.getChart().items).toHaveLength(1);
  });

  it('restores a committed drag to where it was', () => {
    const { canvas, svg } = build(one());
    const before = canvas.getChart().items[0].x;
    // Drive the real gesture: pointerdown on the label, move, up. This is the path an accidental
    // drag takes, so it is the one undo has to cover.
    const g = svg.querySelector('g[data-item-id="a"] .qc-item-hit') as SVGRectElement;
    // jsdom implements neither PointerEvent nor SVGAnimatedRect, so `svgPoint` — which reads
    // `viewBox.baseVal` — throws inside the listener and the gesture silently does nothing. Supply
    // the viewBox so the coordinate maths runs for real.
    Object.defineProperty(svg, 'viewBox', {
      value: { baseVal: { width: 800, height: 600 } }, configurable: true,
    });
    svg.setPointerCapture = () => undefined;
    svg.releasePointerCapture = () => undefined;
    // jsdom has no PointerEvent, and the handlers only read clientX/clientY, so MouseEvent with
    // those fields carries the same information.
    // The event TYPE must be the real pointerdown/pointermove/pointerup — the listeners are
    // registered under those names. Only the class differs from a real PointerEvent.
    const at = (type: string, x: number) =>
      new MouseEvent(type, { bubbles: true, clientX: x, clientY: 300 });
    g.dispatchEvent(at('pointerdown', 400));
    svg.dispatchEvent(at('pointermove', 700));
    svg.dispatchEvent(at('pointerup', 700));
    expect(canvas.getChart().items[0].x).not.toBe(before);
    canvas.undo();
    expect(canvas.getChart().items[0].x).toBe(before);
  });

  it('restores a deleted label, with its styling', () => {
    const { canvas } = build(one({ background: '#fdd663', box: true }));
    canvas.removeItem('a');
    expect(canvas.getChart().items).toHaveLength(0);
    canvas.undo();
    expect(canvas.getChart().items[0]).toMatchObject({
      text: 'Label', background: '#fdd663', box: true,
    });
  });

  it('restores a renamed label', async () => {
    const { canvas } = buildAnswering(one(), 'Renamed');
    await canvas.renameItem(canvas.getChart().items[0]);
    expect(canvas.getChart().items[0].text).toBe('Renamed');
    canvas.undo();
    expect(canvas.getChart().items[0].text).toBe('Label');
  });

  it('restores a grid resize', () => {
    const { canvas } = build(one());
    canvas.setGrid(4, 4);
    expect(canvas.getChart().grid).toEqual({ columns: 4, rows: 4 });
    canvas.undo();
    expect(canvas.getChart().grid).toEqual({ columns: 2, rows: 2 });
  });

  it('restores a named cell', async () => {
    const { canvas } = buildAnswering(one(), 'Strengths');
    await canvas.editCell(0, 1);
    expect(canvas.getChart().cells).toHaveLength(1);
    canvas.undo();
    expect(canvas.getChart().cells).toHaveLength(0);
  });

  it('is bounded, so a long session cannot grow it without limit', () => {
    const { canvas } = build(createChart(2, 2));
    for (let n = 0; n < 300; n += 1) canvas.pushUndo();
    let steps = 0;
    while (canvas.canUndo() && steps < 1000) {
      canvas.undo();
      steps += 1;
    }
    // The cap is an implementation choice, so the test pins that it is FINITE and modest rather than
    // an exact number that would need changing for any tuning.
    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThanOrEqual(200);
  });

  it('is cleared when a different chart is loaded into the view', () => {
    // Otherwise undo in a newly opened file would restore the previous file's contents into it.
    const { canvas } = build(one());
    canvas.removeItem('a');
    expect(canvas.canUndo()).toBe(true);
    canvas.clearUndo();
    expect(canvas.canUndo()).toBe(false);
  });

  it('is not recorded when a change alters nothing', () => {
    const { canvas } = build(one());
    canvas.pushUndo();          // one entry
    canvas.undo();              // drains it
    expect(canvas.canUndo()).toBe(false);
    // Setting the grid to what it already is not a change, so it must not push a snapshot.
    canvas.setGrid(2, 2);
    expect(canvas.canUndo()).toBe(false);
    // And neither must setting an axis to the value it already holds.
    canvas.setAxis('x', { label: 'X axis' });
    expect(canvas.canUndo()).toBe(false);
  });
});