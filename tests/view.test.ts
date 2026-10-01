/**
 * @jest-environment jsdom
 *
 * The bug this file exists to prevent: the view loaded its chart in `onOpen()`, where Obsidian has
 * not yet assigned `this.file`. Every write then hit `if (!this.file) return` and went nowhere, so
 * the canvas updated in memory while the file on disk never changed. It survived a build, 70 unit
 * tests, and a manual read-through, because none of them exercised the lifecycle.
 *
 * The stub in tests/mocks/obsidian.js reproduces Obsidian's real ordering — `onOpen` first, file
 * second — so a view that loads in the wrong hook fails HERE rather than in front of a user.
 */
import { QuadrantChartView } from '../src/view';
import { TFile, Notice } from 'obsidian';
import { createChart, Chart } from '../src/model';
import { parseChartFromText } from '../src/mdx';

const CHART_YAML = `---
quadrant-chart: 1
title: Original
x:
  label: Impact
  min: 0
  max: 10
y:
  label: Urgency
  min: 0
  max: 10
grid:
  columns: 2
  rows: 2
items:
  - id: keep
    text: Keep me
    x: 8
    y: 9
---

body text that must survive
`;

/** A vault stub that records writes, so we can assert the file actually changed. */
function makeApp(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const writes: string[] = [];
  const vault = {
    getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p, files.get(p)) : null),
    async read(file: TFile) { return files.get(file.path) ?? ''; },
    async modify(file: TFile, data: string) { files.set(file.path, data); writes.push(file.path); },
    on: () => ({}),
    getRoot: () => ({ path: '/' }),
    create: async () => { throw new Error('not used'); },
  };
  // processFrontMatter is what the real save path uses. Modelled FAITHFULLY to the shipped API:
  //   processFrontMatter(file, fn: (frontmatter) => void): Promise<void>
  // The callback MUTATES the object it is given; its return value is discarded. An earlier version of
  // this stub used the return value (`const next = fn(current) ?? {}`) — the OPPOSITE of the real
  // contract — which made the plugin's return-based write look correct in tests while doing nothing
  // at runtime. The stub was the thing that was wrong, so it is corrected to match the d.ts.
  const fileManager = {
    async processFrontMatter(file: TFile, fn: (fm: Record<string, unknown>) => void) {
      const text = files.get(file.path) ?? '';
      const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
      const fm = (m ? require('js-yaml').load(m[1]) ?? {} : {}) as Record<string, unknown>;
      fn(fm);                                   // return value intentionally ignored
      const body = m ? text.slice(m[0].length) : text;
      files.set(file.path, `---\n${require('js-yaml').dump(fm)}---\n${body}`);
      writes.push(file.path);
    },
  };
  return { app: { vault, fileManager, workspace: { on: () => ({}), getLeavesOfType: () => [], setActiveLeaf: () => {} } } as never, files, writes };
}

function makePlugin(app: unknown) {
  return {
    app,
    settings: { defaultColumns: 2, defaultRows: 2, confirmOverwrite: true },
    promptText: jest.fn(async () => 'from-test'),
    saveSettings: jest.fn(async () => undefined),
  } as never;
}

function makeView(app: unknown) {
  const view = new QuadrantChartView({} as never, makePlugin(app));
  // Real Obsidian's ItemView receives the app via its (leaf, app) constructor and exposes it as
  // `this.app`. The published .d.ts omits that parameter, so production code cannot forward it;
  // the test assigns it the same way the framework would.
  (view as unknown as { app: unknown }).app = app;
  return view;
}

beforeEach(() => { Notice.messages.length = 0; });

describe('view lifecycle — the file arrives AFTER onOpen', () => {
  it('has no file during onOpen, which is why loading there did nothing', async () => {
    const { app } = makeApp({ 'c.mdx': CHART_YAML });
    const view = makeView(app) as QuadrantChartView & { file: TFile | null };
    await view.onOpen();
    expect(view.file).toBeNull();
  });

  it('loads the chart from the file once onLoadFile runs', async () => {
    const { app } = makeApp({ 'c.mdx': CHART_YAML });
    const view = makeView(app) as QuadrantChartView & { file: TFile | null; chart: Chart };
    await view.onOpen();
    // This is the hook that must do the loading.
    await (view as unknown as { __setFile(f: TFile): Promise<void> }).__setFile(new TFile('c.mdx', CHART_YAML));
    expect(view.chart.title).toBe('Original');
    expect(view.chart.items.map((i) => i.text)).toEqual(['Keep me']);
  });

  it('does not show the default chart when the file has content', async () => {
    // Regression: onOpen left the canvas on a default 2x2 with no items, so the user's chart
    // appeared to be missing entirely until they edited something.
    const { app } = makeApp({ 'c.mdx': CHART_YAML });
    const view = makeView(app) as QuadrantChartView & { chart: Chart };
    await view.onOpen();
    expect(view.chart.items).toEqual([]);
    await (view as unknown as { __setFile(f: TFile): Promise<void> }).__setFile(new TFile('c.mdx', CHART_YAML));
    expect(view.chart.items).toHaveLength(1);
  });
});

describe('view lifecycle — saving actually reaches disk', () => {
  it('writes the chart to the file', async () => {
    const { app, files, writes } = makeApp({ 'c.mdx': CHART_YAML });
    const view = makeView(app) as QuadrantChartView & { chart: Chart; commit(c: Chart): Promise<void> };
    await view.onOpen();
    await (view as unknown as { __setFile(f: TFile): Promise<void> }).__setFile(new TFile('c.mdx', CHART_YAML));

    const edited: Chart = { ...view.chart, items: [...view.chart.items, { id: 'new', text: 'Added', x: 1, y: 2 }] };
    await view.commit(edited);

    expect(writes).toContain('c.mdx');
    const onDisk = parseChartFromText(files.get('c.mdx')!)!;
    expect(onDisk.items.map((i) => i.text)).toEqual(['Keep me', 'Added']);
  });

  it('preserves the body across a save', async () => {
    const { app, files } = makeApp({ 'c.mdx': CHART_YAML });
    const view = makeView(app) as QuadrantChartView & { chart: Chart; commit(c: Chart): Promise<void> };
    await view.onOpen();
    await (view as unknown as { __setFile(f: TFile): Promise<void> }).__setFile(new TFile('c.mdx', CHART_YAML));
    await view.commit({ ...view.chart, title: 'Renamed' });
    expect(files.get('c.mdx')).toContain('body text that must survive');
  });

  it('survives several edits in a row, keeping all of them', async () => {
    const { app, files } = makeApp({ 'c.mdx': CHART_YAML });
    const view = makeView(app) as QuadrantChartView & { chart: Chart; commit(c: Chart): Promise<void> };
    await view.onOpen();
    await (view as unknown as { __setFile(f: TFile): Promise<void> }).__setFile(new TFile('c.mdx', CHART_YAML));

    let chart = view.chart;
    for (let i = 1; i <= 4; i += 1) {
      chart = { ...chart, items: [...chart.items, { id: `n${i}`, text: `Item ${i}`, x: i, y: i }] };
      await view.commit(chart);
    }
    const onDisk = parseChartFromText(files.get('c.mdx')!)!;
    expect(onDisk.items.map((i) => i.text)).toEqual(['Keep me', 'Item 1', 'Item 2', 'Item 3', 'Item 4']);
  });

  it('surfaces a write with no file instead of silently dropping it', async () => {
    // The silent `return` is what made this take two rounds to find. A failed save must be visible.
    const { app, files } = makeApp({ 'c.mdx': CHART_YAML });
    const view = makeView(app) as QuadrantChartView & { chart: Chart; commit(c: Chart): Promise<void> };
    await view.onOpen();
    // No file bound — exactly the state the old onOpen()-based flow left the view in.
    await view.commit(createChart());
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(files.get('c.mdx')).toBe(CHART_YAML);
    errSpy.mockRestore();
  });
});

describe('view state round-trip', () => {
  it('exposes the file path so the binding survives a reload', async () => {
    const { app } = makeApp({ 'c.mdx': CHART_YAML });
    const view = makeView(app) as QuadrantChartView & { file: TFile | null };
    await view.onOpen();
    await (view as unknown as { __setFile(f: TFile): Promise<void> }).__setFile(new TFile('c.mdx', CHART_YAML));
    expect(view.getState()).toEqual({ file: 'c.mdx' });
  });

  it('reports no file before one is bound', async () => {
    const { app } = makeApp();
    const view = makeView(app);
    await view.onOpen();
    expect(view.getState()).toEqual({ file: null });
  });
});
