/**
 * @jest-environment jsdom
 *
 * Redo.
 *
 * 1.0.0 shipped undo with an explicit note that redo was unavailable. That note was honest but the
 * feature was still missing, and it is the kind of missing that reads as a bug: you undo one step too
 * far and there is no way back except redoing the edit by hand.
 *
 * The mechanic is small — a second stack — and the ways to get it wrong are all in the transitions:
 *
 *  - redo must be dropped when a NEW change is committed, or it would replay an edit the user has
 *    since abandoned;
 *  - undo and redo must hand each other what they gave up, or repeated presses ping-pong;
 *  - both must survive a file reload boundary (they must NOT), or one file's history restores into
 *    another;
 *  - a corrupt snapshot must fail its own step, not the whole history.
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
  const svg = canvas['svg'] as SVGSVGElement;
  Object.defineProperty(svg, 'viewBox', { value: { baseVal: { width: 800, height: 600 } }, configurable: true });
  return { canvas, changes };
}

/** A canvas whose prompts answer `answer`, so an edit actually changes something. */
function answering(chart: Chart, answer: string) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
  document.body.appendChild(container);
  const canvas = new ChartCanvas({} as never, container, chart, {
    file: FILE, onChange: () => undefined, onSelectCell: () => undefined,
    promptText: async () => answer,
  });
  canvas.measure();
  canvas.render();
  return canvas;
}

const one = (extra: Partial<Chart['items'][number]> = {}): Chart => {
  const c = createChart(2, 2);
  return { ...c, items: [{ id: 'a', text: 'Label', x: 1, y: 1, ...extra }] };
};

describe('redo exists', () => {
  it('is refused when there is nothing to redo', () => {
    const { canvas } = build(one());
    expect(canvas.canRedo()).toBe(false);
    expect(canvas.redo()).toBe(false);
  });

  it('becomes available after an undo', () => {
    const { canvas } = build(one());
    canvas.removeItem('a');
    canvas.undo();
    expect(canvas.canRedo()).toBe(true);
  });

  it('is exhausted once fully replayed', () => {
    const { canvas } = build(one());
    canvas.removeItem('a');
    canvas.undo();
    expect(canvas.redo()).toBe(true);
    expect(canvas.canRedo()).toBe(false);
    expect(canvas.redo()).toBe(false);
  });
});

describe('undo and redo hand each other state', () => {
  it('redo restores what undo removed', () => {
    const { canvas } = build(one());
    canvas.removeItem('a');
    expect(canvas.getChart().items).toHaveLength(0);
    canvas.undo();
    expect(canvas.getChart().items).toHaveLength(1);
    canvas.redo();
    expect(canvas.getChart().items).toHaveLength(0);
  });

  it('survives many undo/redo cycles without drifting', () => {
    const { canvas } = build(createChart(2, 2));
    canvas.setGrid(3, 3);
    canvas.addItem(1, 1);
    const endState = JSON.stringify(canvas.getChart());

    canvas.undo(); canvas.undo();
    canvas.redo(); canvas.redo();
    expect(JSON.stringify(canvas.getChart())).toBe(endState);
  });

  it('replays two DISTINCT steps when two changes were undone', async () => {
    // Two changes are what make redo's steps distinguishable. With only one change undone, replaying
    // the same state twice looks identical to replaying it once — which is why the single-change
    // tests cannot catch a redo stack that duplicated an entry. Making redo() push onto the redo
    // stack as well as the undo stack is the concrete bug this pins.
    const { canvas } = build(createChart(2, 2));
    await canvas.addItem(1, 1);           // S0 -> S1
    canvas.setGrid(3, 3);                 // S1 -> S2
    canvas.undo();                        // back at S1
    canvas.undo();                        // back at S0

    canvas.redo();
    const afterFirst = canvas.getChart();
    expect(afterFirst.grid).toEqual({ columns: 2, rows: 2 });   // the 3x3 step is back
    expect(afterFirst.items).toHaveLength(1);

    canvas.redo();
    expect(canvas.getChart().grid).toEqual({ columns: 3, rows: 3 }); // and the other step too
    expect(canvas.getChart().items).toHaveLength(1);
  });

  it('does not replay the same step twice', async () => {
    const { canvas } = build(createChart(2, 2));
    await canvas.addItem(1, 1);
    canvas.setGrid(3, 3);
    canvas.undo();
    canvas.undo();
    canvas.redo();
    const first = JSON.stringify(canvas.getChart());
    canvas.redo();
    expect(JSON.stringify(canvas.getChart())).not.toBe(first);
  });

  it('alternating undo and redo lands on the same two states', () => {
    const { canvas } = build(one());
    canvas.removeItem('a');
    for (let n = 0; n < 5; n += 1) {
      canvas.undo();
      expect(canvas.getChart().items).toHaveLength(1);
      canvas.redo();
      expect(canvas.getChart().items).toHaveLength(0);
    }
  });

  it('a redo does not become undoable beyond where it started', () => {
    const { canvas } = build(one());
    canvas.removeItem('a');
    canvas.undo();
    canvas.redo();
    expect(canvas.canUndo()).toBe(true);
    canvas.undo();
    expect(canvas.canRedo()).toBe(true);
  });

  it('restores a styled label, not just its text', () => {
    const { canvas } = build(one({ background: '#fdd663', box: true }));
    canvas.setItemSize('a', 32);
    canvas.undo();
    expect(canvas.getChart().items[0].size).toBeUndefined();
    canvas.redo();
    expect(canvas.getChart().items[0]).toMatchObject({ background: '#fdd663', box: true, size: 32 });
  });

  it('restores a grid resize', () => {
    const { canvas } = build(one());
    canvas.setGrid(4, 4);
    canvas.undo();
    expect(canvas.getChart().grid).toEqual({ columns: 2, rows: 2 });
    canvas.redo();
    expect(canvas.getChart().grid).toEqual({ columns: 4, rows: 4 });
  });

  it('restores a rename', async () => {
    const canvas = answering(one(), 'Renamed');
    await canvas.renameItem(canvas.getChart().items[0]);
    expect(canvas.getChart().items[0].text).toBe('Renamed');
    canvas.undo();
    expect(canvas.getChart().items[0].text).toBe('Label');
    canvas.redo();
    expect(canvas.getChart().items[0].text).toBe('Renamed');
  });

  it('saves through onChange, so the file follows the redo', () => {
    const { canvas, changes } = build(one());
    canvas.removeItem('a');
    canvas.undo();
    const beforeRedo = changes.length;
    canvas.redo();
    expect(changes.length).toBe(beforeRedo + 1);
    expect(changes[changes.length - 1].items).toHaveLength(0);
  });
});

describe('a new change abandons the redo branch', () => {
  // The rule that makes redo safe. Replaying an edit the user has replaced would resurrect work they
  // deliberately moved on from, which is worse than having no redo at all.
  it('clears redo when a change is committed after an undo', async () => {
    const { canvas } = build(one());
    canvas.removeItem('a');
    canvas.undo();
    expect(canvas.canRedo()).toBe(true);
    await canvas.addItem(5, 5);
    expect(canvas.canRedo()).toBe(false);
  });

  it('the abandoned change cannot come back', async () => {
    const { canvas } = build(one());
    canvas.removeItem('a');
    canvas.undo();
    await canvas.addItem(5, 5);
    expect(canvas.redo()).toBe(false);            // the branch was abandoned
    // Unchanged: both the restored label and the new one are still there.
    expect(canvas.getChart().items.map((i) => i.text)).toEqual(['Label', 'New label']);
  });

  it('undo after that walks back the new change, not the old one', async () => {
    const { canvas } = build(one());
    canvas.removeItem('a');
    canvas.undo();                 // back to one label
    await canvas.addItem(5, 5);     // two labels, new branch
    expect(canvas.getChart().items).toHaveLength(2);
    canvas.undo();
    expect(canvas.getChart().items).toHaveLength(1);
  });

  it('a no-op change does NOT clear redo', () => {
    // Setting the grid to the size it already has is not a change. Clearing redo on it would throw
    // away a real history because of a click that did nothing.
    const { canvas } = build(one());
    canvas.setGrid(3, 3);
    canvas.undo();
    expect(canvas.canRedo()).toBe(true);
    canvas.setGrid(2, 2);            // already 2x2
    expect(canvas.canRedo()).toBe(true);
  });
});

describe('history does not cross a file boundary', () => {
  it('is cleared when a different chart is loaded', () => {
    const { canvas } = build(one());
    canvas.removeItem('a');
    canvas.undo();
    expect(canvas.canRedo()).toBe(true);
    canvas.clearUndo();
    expect(canvas.canUndo()).toBe(false);
    expect(canvas.canRedo()).toBe(false);
  });

  it('clearing redo does not leave undo intact either', () => {
    const { canvas } = build(one());
    canvas.removeItem('a');
    canvas.clearUndo();
    expect(canvas.canUndo()).toBe(false);
    expect(canvas.redo()).toBe(false);
  });
});

describe('a corrupt snapshot fails only its own step', () => {
  it('undo reports failure and keeps the rest of the history', async () => {
    const { canvas } = build(one());
    canvas.setGrid(3, 3);                 // change 1
    await canvas.addItem(5, 5);           // change 2, so the stack has two entries
    const stack = canvas['undoStack'] as string[];
    expect(stack.length).toBeGreaterThanOrEqual(2);
    // Corrupt the deepest entry, the way a bad write would.
    stack[0] = '{not json';
    expect(canvas.undo()).toBe(true);    // the newest entry is fine
    expect(canvas.canUndo()).toBe(true); // the bad one is still there, not silently skipped
  });

  it('does not push onto redo when it failed', () => {
    const { canvas } = build(one());
    canvas.removeItem('a');
    (canvas['undoStack'] as string[])[0] = '{not json';
    expect(canvas.undo()).toBe(false);
    expect(canvas.canRedo()).toBe(false);
  });
});

describe('a selection cannot survive a jump onto a chart without it', () => {
  it('drops a selection naming a label the jump removed', () => {
    const { canvas } = build(one());
    canvas.setGrid(3, 3);
    canvas.removeItem('a');
    // Deliberately strand the selection: a real delete clears it, so the only way it can name a
    // missing label is if some other path left it. The guard exists for exactly that case, so it has
    // to be exercised by constructing it rather than waiting for it.
    canvas.setSelectedItem('a');
    expect(canvas.getSelectedItem()).toBe('a');
    canvas.undo();
    expect(canvas.getSelectedItem()).toBe('a');
    canvas.redo();                 // the label is gone again
    expect(canvas.getSelectedItem()).toBeNull();
  });

  it('drops a cell selection when redo shrinks the grid under it', () => {
    const { canvas } = build(one());
    canvas.setSelectedCell(1, 1);
    canvas.setGrid(1, 1);
    canvas.setSelectedCell(1, 1);  // strand it: a real resize clears it itself
    canvas.undo();
    expect(canvas.getSelectedCell()).toEqual({ col: 1, row: 1 });
    canvas.redo();                 // back to a 1x1 grid, so cell (1,1) no longer exists
    expect(canvas.getSelectedCell()).toBeNull();
  });
});