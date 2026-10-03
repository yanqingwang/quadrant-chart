/**
 * @jest-environment jsdom
 *
 * The label menu, verified rather than assumed.
 *
 * The reason this file exists: `items[].size` was in the file format, honoured by the canvas and by
 * the exporter, and had NO user interface that could set it. A format field with no writer is a field
 * only a hand-editor can reach — which is a real gap, and one no model-level test can detect, because
 * the model was never wrong. These tests drive the actual menu and assert what a user can choose.
 *
 * The same applies to paint order: a label under another was unreachable, and the fix is menu items.
 *
 * Uses the same fake Menu/MenuItem harness as the grid picker, so the whole interaction runs.
 */
import { QuadrantChartView } from '../src/view';
import { TFile, Menu } from 'obsidian';
import { Chart } from '../src/model';

const BASE = `---
quadrant-chart: 1
x:
  label: X
  min: 0
  max: 10
y:
  label: Y
  min: 0
  max: 10
grid:
  columns: 2
  rows: 2
items:
  - id: a
    text: First label
    x: 5
    y: 5
  - id: b
    text: Second label
    x: 6
    y: 6
---

body
`;

class FakeMenuItem {
  title = '';
  section = '';
  checked: boolean | null = null;
  disabled = false;
  click: (() => void) | null = null;
  setTitle(t: string) { this.title = t; return this; }
  setSection(s: string) { this.section = s; return this; }
  setChecked(c: boolean) { this.checked = c; return this; }
  setDisabled(d: boolean) { this.disabled = d; return this; }
  setIcon() { return this; }
  onClick(cb: () => void) { this.click = cb; return this; }
}

let captured: FakeMenuItem[] = [];
let prompts: string[] = [];

beforeAll(() => {
  (Menu as unknown as { items: FakeMenuItem[] }).prototype.addItem = function (cb: (i: FakeMenuItem) => void) {
    const item = new FakeMenuItem();
    cb(item);
    captured.push(item);
    return this;
  };
  (Menu as unknown as { addSeparator(): unknown }).prototype.addSeparator = function () { return this; };
  (Menu as unknown as { showAtMouseEvent(): unknown }).prototype.showAtMouseEvent = function () { return this; };
});
beforeEach(() => { captured = []; prompts = []; });

/** A view with `selectedId` as the currently selected label, if any. */
function makeView(selectedId: string | null = 'a') {
  const files = new Map<string, string>([['c.mdx', BASE]]);
  const vault = {
    getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p, files.get(p)) : null),
    read: async (f: TFile) => files.get(f.path) ?? '',
    process: async (f: TFile, fn: (t: string) => string) => { files.set(f.path, fn(files.get(f.path) ?? '')); return files.get(f.path)!; },
    createBinary: async () => ({}),
    configDir: '.obsidian',
  };
  const app = {
    vault,
    fileManager: { processFrontMatter: async () => undefined },
    workspace: { on: () => ({}), getLeavesOfType: () => [], setActiveLeaf: () => {} },
  } as never;
  const plugin = {
    app,
    settings: { defaultColumns: 2, defaultRows: 2, confirmOverwrite: true },
    promptText: jest.fn(async (def: string) => { prompts.push(def); return def; }),
    saveSettings: jest.fn(async () => undefined),
  } as never;

  const view = new QuadrantChartView({} as never, plugin);
  (view as unknown as { app: unknown }).app = app;
  (view as unknown as { file: unknown }).file = new TFile('c.mdx', BASE);
  (view as unknown as { chart: Chart }).chart = JSON.parse(
    JSON.stringify({ x: { label: 'X', min: 0, max: 10 }, y: { label: 'Y', min: 0, max: 10 },
      grid: { columns: 2, rows: 2 }, cells: [],
      items: [{ id: 'a', text: 'First label', x: 5, y: 5 }, { id: 'b', text: 'Second label', x: 6, y: 6 }] }),
  );

  // The canvas is stubbed so a menu action can be asserted on the chart without a DOM canvas.
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string) => (...args: unknown[]) => { calls.push({ method, args }); };
  (view as unknown as { canvas: unknown }).canvas = {
    getSelectedItem: () => selectedId,
    setItemSize: record('setItemSize'),
    reorderItem: record('reorderItem'),
    removeItem: record('removeItem'),
    setChart: () => undefined,
  };

  const v = view as QuadrantChartView & { chart: Chart };
  (v as unknown as { calls: { method: string; args: unknown[] }[] }).calls = calls;
  return v;
}

type View = ReturnType<typeof makeView>;

/** Open the menu and return the items it produced. Nothing else reads `captured`. */
function openMenu(view: View): FakeMenuItem[] {
  (view as unknown as { pickLabel(e: MouseEvent): void }).pickLabel({} as MouseEvent);
  return captured;
}

/**
 * Titles within a section, from an already-opened menu.
 *
 * These take the items explicitly rather than reading the module-level array. The previous version
 * read it directly, so a test that forgot to open the menu first got an empty result that read as a
 * genuine "the feature is missing" failure — and six tests made exactly that mistake.
 */
const inSection = (items: FakeMenuItem[], section: string) =>
  items.filter((i) => i.section.startsWith(section));
const titleIn = (items: FakeMenuItem[], section: string) =>
  inSection(items, section).map((i) => i.title);

describe('the label menu exists at all', () => {
  // Everything below is unreachable without this: the whole reported gap was a feature that existed
  // in the model with no route to it from the UI.
  it('offers actions when a label is selected', () => {
    const view = makeView('a');
    const titles = openMenu(view).map((i) => i.title);
    expect(titles).toContain('Edit text…');
    expect(titles).toContain('Delete label');
  });

  it('names the label it acts on', () => {
    const view = makeView('a');
    const sections = openMenu(view).map((i) => i.section);
    expect(sections.some((s) => s.includes('First label'))).toBe(true);
  });

  it('says so plainly when nothing is selected, rather than showing a dead menu', () => {
    const view = makeView(null);
    const items = openMenu(view);
    expect(items).toHaveLength(1);
    expect(items[0].disabled).toBe(true);
    expect(items[0].title).toMatch(/click a label/i);
  });
});

describe('text size', () => {
  it('offers a Default option, so the override can be cleared', () => {
    const items = openMenu(makeView('a'));
    expect(titleIn(items, 'Text size')).toContain('Default');
  });

  it('offers several pixel sizes', () => {
    const items = openMenu(makeView('a'));
    const sizes = titleIn(items, 'Text size').filter((t) => t.endsWith(' px'));
    expect(sizes.length).toBeGreaterThanOrEqual(5);
    expect(sizes).toContain('14 px');
    expect(sizes).toContain('32 px');
  });

  it('offers a custom value for sizes not on the list', () => {
    const items = openMenu(makeView('a'));
    expect(titleIn(items, 'Text size')).toContain('Custom…');
  });

  it('spreads the steps out, so neighbouring choices are visibly different', () => {
    // Closely spaced steps make it impossible to tell which one is checked at a glance, which
    // defeats the point of offering a menu instead of a number field.
    const items = openMenu(makeView('a'));
    const sizes = titleIn(items, 'Text size')
      .filter((t) => t.endsWith(' px'))
      .map((t) => Number(t.replace(' px', '')));
    for (let n = 1; n < sizes.length; n += 1) {
      expect(sizes[n] - sizes[n - 1]).toBeGreaterThanOrEqual(2);
    }
  });

  it('marks Default as checked when the label has no override', () => {
    const items = openMenu(makeView('a'));
    const def = inSection(items, 'Text size').find((i) => i.title === 'Default');
    expect(def?.checked).toBe(true);
    expect(inSection(items, 'Text size').filter((i) => i.checked && i.title.endsWith(' px'))).toHaveLength(0);
  });

  it('marks the current size as checked instead of Default', () => {
    const view = makeView('a');
    view.chart.items[0].size = 32;
    const items = openMenu(view);
    const def = inSection(items, 'Text size').find((i) => i.title === 'Default');
    const thirtyTwo = inSection(items, 'Text size').find((i) => i.title === '32 px');
    expect(def?.checked).toBe(false);
    expect(thirtyTwo?.checked).toBe(true);
  });

  it('applies a chosen size', () => {
    const view = makeView('a');
    openMenu(view).find((i) => i.title === '24 px')!.click!();
    expect(view.calls).toContainEqual({ method: 'setItemSize', args: ['a', 24] });
  });

  it('clears the override when Default is picked', () => {
    const view = makeView('a');
    openMenu(view).find((i) => i.title === 'Default')!.click!();
    expect(view.calls).toContainEqual({ method: 'setItemSize', args: ['a', null] });
  });
});

describe('overlapping labels', () => {
  it('offers both directions', () => {
    const items = openMenu(makeView('a'));
    expect(titleIn(items, 'Overlapping labels')).toEqual(['Bring to front', 'Send to back']);
  });

  it('brings a label to the front', () => {
    const view = makeView('a');
    openMenu(view).find((i) => i.title === 'Bring to front')!.click!();
    expect(view.calls).toContainEqual({ method: 'reorderItem', args: ['a', 'front'] });
  });

  it('sends a label to the back', () => {
    const view = makeView('a');
    openMenu(view).find((i) => i.title === 'Send to back')!.click!();
    expect(view.calls).toContainEqual({ method: 'reorderItem', args: ['a', 'back'] });
  });

  it('disables a direction that would change nothing', () => {
    // 'b' is last in the array, so it is already in front; offering "bring to front" as a live
    // action there would create a no-op that looks like it worked.
    const view = makeView('b');
    const front = openMenu(view).find((i) => i.title === 'Bring to front')!;
    const back = openMenu(view).find((i) => i.title === 'Send to back')!;
    expect(front.disabled).toBe(true);
    expect(back.disabled).toBe(false);
  });

  it('disables both when the chart has a single label', () => {
    const view = makeView('a');
    view.chart.items = [view.chart.items[0]];
    const front = openMenu(view).find((i) => i.title === 'Bring to front')!;
    const back = openMenu(view).find((i) => i.title === 'Send to back')!;
    expect(front.disabled).toBe(true);
    expect(back.disabled).toBe(true);
  });
});

describe('delete', () => {
  it('removes the selected label', () => {
    const view = makeView('a');
    openMenu(view).find((i) => i.title === 'Delete label')!.click!();
    expect(view.calls).toContainEqual({ method: 'removeItem', args: ['a'] });
  });

  it('offers it as a first-class action, not only via right-click', () => {
    // A phone has no right-click, so a gesture-only delete is a delete that does not exist there.
    const view = makeView('a');
    expect(openMenu(view).map((i) => i.title)).toContain('Delete label');
  });
});