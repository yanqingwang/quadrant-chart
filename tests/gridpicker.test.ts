/**
 * @jest-environment jsdom
 *
 * The grid picker, verified rather than assumed.
 *
 * The reported problem was "I can only pick 2 × 2". The menu could always set any size, but it
 * listed them as a flat run of "N × M" strings with nothing saying which number was columns and
 * which was rows, so every non-square option read as noise. These tests pin the two things that
 * actually matter: that the sizes offered are real, and that picking one applies to the model.
 *
 * The menu is driven through a fake Menu/MenuItem so the whole interaction is exercised, not just
 * the helper that builds it.
 */
import { QuadrantChartView } from '../src/view';
import { TFile, Menu } from 'obsidian';
import { Chart, LIMITS } from '../src/model';

const CHART = `---
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
---

body
`;

/** Collects what the view put into the Menu, and lets a test click an item by title. */
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

beforeAll(() => {
  // Replace the Menu class the view imports, recording every item it adds.
  (Menu as unknown as { items: FakeMenuItem[] }).prototype.addItem = function (cb: (i: FakeMenuItem) => void) {
    const item = new FakeMenuItem();
    cb(item);
    captured.push(item);
    return this;
  };
  (Menu as unknown as { addSeparator(): unknown }).prototype.addSeparator = function () { return this; };
  (Menu as unknown as { showAtMouseEvent(): unknown }).prototype.showAtMouseEvent = function () { return this; };
});
beforeEach(() => { captured = []; });

function makeView() {
  const files = new Map<string, string>([['c.mdx', CHART]]);
  const vault = {
    getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p, files.get(p)) : null),
    read: async (f: TFile) => files.get(f.path) ?? '',
    process: async (f: TFile, fn: (t: string) => string) => { files.set(f.path, fn(files.get(f.path) ?? '')); return files.get(f.path)!; },
    modify: async (f: TFile, d: string) => { files.set(f.path, d); },
  };
  const app = {
    vault,
    fileManager: { processFrontMatter: async () => undefined },
    workspace: { on: () => ({}), getLeavesOfType: () => [], setActiveLeaf: () => {} },
  } as never;
  const plugin = {
    app,
    settings: { defaultColumns: 2, defaultRows: 2, confirmOverwrite: true },
    promptText: jest.fn(async () => ''),
    saveSettings: jest.fn(async () => undefined),
  } as never;
  const view = new QuadrantChartView({} as never, plugin);
  (view as unknown as { app: unknown }).app = app;
  (view as unknown as { canvas: unknown }).canvas = { setGrid: (c: number, r: number) => { view['chart'].grid = { columns: c, rows: r }; } };
  return view as QuadrantChartView & { chart: Chart };
}

const titlesIn = (section: string) => captured.filter((i) => i.section.startsWith(section)).map((i) => i.title);

describe('grid picker — what it offers', () => {
  it('offers columns and rows as separate, labelled choices', () => {
    const view = makeView();
    (view as unknown as { pickGrid(e: MouseEvent): void }).pickGrid({} as MouseEvent);
    const cols = titlesIn('Columns');
    const rows = titlesIn('Rows');
    expect(cols).toContain('2 columns');
    expect(rows).toContain('2 rows');
    // Singular wording, so "1" is not ambiguous between the two axes.
    expect(cols).toContain('1 column');
    expect(rows).toContain('1 row');
  });

  it('offers more than the four square presets', () => {
    const view = makeView();
    (view as unknown as { pickGrid(e: MouseEvent): void }).pickGrid({} as MouseEvent);
    const total = captured.filter((i) => !i.section.startsWith('Presets')).length;
    expect(total).toBe(16); // 8 columns + 8 rows
    expect(titlesIn('Presets').length).toBeGreaterThanOrEqual(3);
  });

  it('marks the current size as checked', () => {
    const view = makeView();
    (view as unknown as { pickGrid(e: MouseEvent): void }).pickGrid({} as MouseEvent);
    const checkedCols = captured.filter((i) => i.section.startsWith('Columns') && i.checked).map((i) => i.title);
    const checkedRows = captured.filter((i) => i.section.startsWith('Rows') && i.checked).map((i) => i.title);
    expect(checkedCols).toEqual(['2 columns']);
    expect(checkedRows).toEqual(['2 rows']);
  });

  it('applies a non-square size when clicked — the thing reported as missing', () => {
    const view = makeView();
    (view as unknown as { pickGrid(e: MouseEvent): void }).pickGrid({} as MouseEvent);
    const fourCols = captured.find((i) => i.title === '4 columns')!;
    fourCols.click!();
    expect(view.chart.grid).toEqual({ columns: 4, rows: 2 });

    const sixRows = captured.find((i) => i.title === '6 rows')!;
    sixRows.click!();
    expect(view.chart.grid).toEqual({ columns: 4, rows: 6 });
  });

  it('never offers a size the model would reject', () => {
    const view = makeView();
    (view as unknown as { pickGrid(e: MouseEvent): void }).pickGrid({} as MouseEvent);
    for (const t of titlesIn('Columns')) {
      const n = parseInt(t, 10);
      expect(n).toBeGreaterThanOrEqual(LIMITS.minSplits);
      expect(n).toBeLessThanOrEqual(LIMITS.maxSplits);
    }
  });

  it('applies a preset', () => {
    const view = makeView();
    (view as unknown as { pickGrid(e: MouseEvent): void }).pickGrid({} as MouseEvent);
    captured.find((i) => i.title === '3 × 3')!.click!();
    expect(view.chart.grid).toEqual({ columns: 3, rows: 3 });
  });
});

describe('grid changes persist to the file', () => {
  it('a new grid size is written, not just held in memory', async () => {
    const files = new Map<string, string>([['c.mdx', CHART]]);
    const vault = {
      getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p, files.get(p)) : null),
      read: async (f: TFile) => files.get(f.path) ?? '',
      process: async (f: TFile, fn: (t: string) => string) => { files.set(f.path, fn(files.get(f.path) ?? '')); return files.get(f.path)!; },
      modify: async (f: TFile, d: string) => { files.set(f.path, d); },
    };
    const app = { vault, fileManager: { processFrontMatter: async () => undefined }, workspace: { on: () => ({}), getLeavesOfType: () => [], setActiveLeaf: () => {} } } as never;
    const plugin = { app, settings: { defaultColumns: 2, defaultRows: 2, confirmOverwrite: true }, promptText: jest.fn(async () => ''), saveSettings: jest.fn(async () => undefined) } as never;
    const view = new QuadrantChartView({} as never, plugin);
    (view as unknown as { app: unknown }).app = app;

    const applied: number[][] = [];
    (view as unknown as { canvas: unknown }).canvas = {
      setGrid: (c: number, r: number) => { applied.push([c, r]); },
    };
    await view.onOpen();
    (view as unknown as { file: TFile }).file = new TFile('c.mdx', CHART);

    // Installed AFTER onOpen: onOpen builds the real canvas, which would otherwise replace this stub.
    (view as unknown as { canvas: unknown }).canvas = {
      setGrid: (c: number, r: number) => { applied.push([c, r]); },
    };

    (view as unknown as { pickGrid(e: MouseEvent): void }).pickGrid({} as MouseEvent);
    captured.find((i) => i.title === '5 columns')!.click!();
    expect(applied).toEqual([[5, 2]]);
  });
});
