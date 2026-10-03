/**
 * @jest-environment jsdom
 *
 * Deleting a label — reported as "after adding a label, I still can't delete it".
 *
 * The delete action itself worked at every level (canvas, menu, file round trip all verified). What
 * was broken was that nothing told the user it was available: clicking a label left the toolbar's
 * Label button still reading "Label", and opening it produced a single disabled row. So the sequence
 * a person actually follows — add a label, look for a way to remove it, open the Label menu — dead
 * ended with no delete anywhere on screen.
 *
 * Two further defects turned up while chasing it:
 *  - the context menu deleted twice, costing two writes and TWO undo steps to walk back;
 *  - there was only one route to deletion at all, and it ran through `contextmenu`, the one event a
 *    host application can swallow.
 *
 * These tests assert the AFFORDANCE, not just the action: that the toolbar reflects the selection,
 * that deletion fires exactly once, and that Delete/Backspace works without any menu.
 */
import { QuadrantChartView } from '../src/view';
import { ChartCanvas } from '../src/canvas';
import { TFile, Menu, MenuItem } from 'obsidian';

const BASE = `---
quadrant-chart: 1
x: {label: X, min: 0, max: 10}
y: {label: Y, min: 0, max: 10}
grid: {columns: 2, rows: 2}
---

body
`;

/** A MenuItem double that records everything, so a menu can be read and clicked. */
class FakeMenuItem {
  title = ''; section = ''; checked: boolean | null = null; disabled = false;
  click: (() => void) | null = null;
  setTitle(t: string) { this.title = t; return this; }
  setSection(s: string) { this.section = s; return this; }
  setChecked(c: boolean) { this.checked = c; return this; }
  setDisabled(d: boolean) { this.disabled = d; return this; }
  setIcon() { return this; }
  onClick(cb: () => void) { this.click = cb; return this; }
}

let captured: FakeMenuItem[] = [];
beforeAll(() => {
  (Menu as unknown as Record<string, unknown>).prototype.addItem =
    function (cb: (i: FakeMenuItem) => void) { const i = new FakeMenuItem(); cb(i); captured.push(i); return this; };
  (Menu as unknown as Record<string, unknown>).prototype.addSeparator = function () { return this; };
  (Menu as unknown as Record<string, unknown>).prototype.showAtMouseEvent = function () { return this; };
});
beforeEach(() => { captured = []; });

/** A view taken through the REAL lifecycle: onOpen builds chrome, then onLoadFile fills it. */
async function makeView() {
  const files = new Map<string, string>([['c.mdx', BASE]]);
  const app = {
    vault: {
      read: async (f: TFile) => files.get(f.path) ?? '',
      process: async (f: TFile, fn: (t: string) => string) => {
        files.set(f.path, fn(files.get(f.path) ?? '')); return files.get(f.path)!;
      },
      getAbstractFileByPath: () => null,
    },
    workspace: { on: () => ({}), getLeavesOfType: () => [], setActiveLeaf: () => {} },
  } as never;
  const plugin = {
    app,
    settings: { defaultColumns: 2, defaultRows: 2, confirmOverwrite: true },
    promptText: async (d: string) => d,
  } as never;
  const view = new QuadrantChartView({} as never, plugin);
  (view as unknown as { app: unknown }).app = app;
  (view as unknown as { file: unknown }).file = new TFile('c.mdx', BASE);
  await view.onOpen();
  await view.onLoadFile(view.file as TFile);

  const canvas = (view as unknown as { canvas: ChartCanvas }).canvas;
  const svg = canvas['svg'] as SVGSVGElement;
  // jsdom implements no SVGAnimatedRect; without this the click handler throws and selection
  // silently never happens, which is the very thing being tested.
  Object.defineProperty(svg, 'viewBox', { value: { baseVal: { width: 800, height: 600 } }, configurable: true });
  const toolbar = () => [...(view as unknown as { toolbarEl: HTMLElement }).toolbarEl
    .querySelectorAll('.qc-btn-label')].map((e) => e.textContent ?? '');
  /**
   * Wait for every queued write to land.
   *
   * Saves are serialised through `writeChain`, so a delete queues behind whatever created the
   * label. Sleeping a fixed 30ms races that and produced a test that failed for no real reason; the
   * chain itself is the honest thing to await.
   */
  const flush = () => (view as unknown as { writeChain: Promise<void> }).writeChain;
  return { view, canvas, svg, toolbar, files, flush };
}

async function withLabel() {
  const h = await makeView();
  await h.canvas.addItem(5, 5);
  const id = h.canvas.getChart().items[0].id;
  h.svg.querySelector(`g[data-item-id="${id}"] .qc-item-hit`)!
    .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400, clientY: 300 }));
  return { ...h, id };
}

describe('the Label button reflects the selection', () => {
  // The reported bug. The button read "Label" whether or not anything was selected, so there was no
  // cue that the menu had anything to act on.
  it('names the label once it is selected', async () => {
    const { toolbar } = await withLabel();
    expect(toolbar().some((t) => t.includes('New label'))).toBe(true);
  });

  it('reads just "Label" before anything is selected', async () => {
    const { toolbar } = await makeView();
    expect(toolbar()).toContain('Label');
    expect(toolbar().some((t) => t.includes('New label'))).toBe(false);
  });

  it('goes back to "Label" after the label is deleted', async () => {
    const { canvas, toolbar, id, flush } = await withLabel();
    canvas.removeItem(id);
    await flush();
    expect(toolbar().some((t) => t.includes('New label'))).toBe(false);
    expect(toolbar()).toContain('Label');
  });

  it('updates when the selection is cleared without deleting anything', async () => {
    const { canvas, toolbar } = await withLabel();
    canvas.setSelectedItem(null);
    expect(toolbar()).toContain('Label');
  });

  it('does not churn the toolbar when the selection is unchanged', async () => {
    const { canvas } = await withLabel();
    canvas.setSelectedItem('l0');   // not the selected one, so it changes
    const first = (canvas as unknown as { cb: { onSelectLabel?: unknown } }).cb.onSelectLabel;
    canvas.setSelectedItem('l0');   // same value again
    expect((canvas as unknown as { cb: { onSelectLabel?: unknown } }).cb.onSelectLabel).toBe(first);
  });
});

describe('deleting through the menu', () => {
  it('offers Delete label for the selected label', async () => {
    const { view } = await withLabel();
    (view as unknown as { pickLabel(e: MouseEvent): void }).pickLabel({} as MouseEvent);
    const del = captured.find((i) => i.title === 'Delete label');
    expect(del).toBeDefined();
    expect(del!.disabled).toBe(false);
  });

  it('removes it from the canvas, the file and the screen', async () => {
    const { view, canvas, svg, files, id, flush } = await withLabel();
    (view as unknown as { pickLabel(e: MouseEvent): void }).pickLabel({} as MouseEvent);
    captured.find((i) => i.title === 'Delete label')!.click!();
    await flush();
    expect(canvas.getChart().items).toHaveLength(0);
    expect(svg.querySelectorAll('.qc-item')).toHaveLength(0);
    expect(/\nitems:/.test(files.get('c.mdx')!)).toBe(false);
    expect(id).toBeTruthy();
  });

  it('says what to do when nothing is selected, instead of showing an empty menu', async () => {
    const { view } = await makeView();
    (view as unknown as { pickLabel(e: MouseEvent): void }).pickLabel({} as MouseEvent);
    expect(captured).toHaveLength(1);
    expect(captured[0].disabled).toBe(true);
    // The wording must name the missing step, since that is the whole confusion.
    expect(captured[0].title).toMatch(/select it/i);
  });
});

describe('deleting by keyboard needs no menu and no right-click', () => {
  it('Delete removes the selected label', async () => {
    const { view, canvas, svg, files, flush } = await withLabel();
    (view as unknown as { contentEl: HTMLElement }).contentEl
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await flush();
    expect(canvas.getChart().items).toHaveLength(0);
    expect(/\nitems:/.test(files.get('c.mdx')!)).toBe(false);
    expect(svg.querySelectorAll('.qc-item')).toHaveLength(0);
    void view;
  });

  it('Backspace works too', async () => {
    const { canvas, view } = await withLabel();
    (view as unknown as { contentEl: HTMLElement }).contentEl
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(canvas.getChart().items).toHaveLength(0);
  });

  it('does nothing when no label is selected', async () => {
    const { canvas, view } = await makeView();
    await canvas.addItem(5, 5);
    (view as unknown as { contentEl: HTMLElement }).contentEl
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(canvas.getChart().items).toHaveLength(1);
  });

  it('never deletes while the user is typing', async () => {
    const { canvas, view } = await withLabel();
    const input = document.createElement('input');
    (view as unknown as { contentEl: HTMLElement }).contentEl.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(canvas.getChart().items).toHaveLength(1);
  });
});

describe('deleting fires exactly once', () => {
  it('a right-click costs one save and one undo step', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
    document.body.appendChild(container);
    const changes: unknown[] = [];
    const chart = { ...createBlank(), items: [{ id: 'a', text: 'Label', x: 5, y: 5 }] };
    const canvas = new ChartCanvas({} as never, container, chart, {
      file: { path: 'c.mdx' } as never,
      onChange: (c) => changes.push(c),
      onSelectCell: () => undefined,
      promptText: async (d) => d,
    });
    canvas.measure();
    canvas.render();
    const hit = (canvas['svg'] as SVGSVGElement).querySelector('g[data-item-id="a"] .qc-item-hit')!;
    hit.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));

    expect(canvas.getChart().items).toHaveLength(0);
    // Twice before: removeItem committed, then the handler committed the same state again.
    expect(changes).toHaveLength(1);
    expect(canvas.canUndo()).toBe(true);
    canvas.undo();
    expect(canvas.getChart().items).toHaveLength(1);
    expect(canvas.canUndo()).toBe(false);
  });
});

function createBlank() {
  // Imported lazily to keep this file's imports focused on the view.
  const { createChart } = require('../src/model');
  return createChart(2, 2);
}