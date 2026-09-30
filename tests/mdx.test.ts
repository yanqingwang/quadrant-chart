// The .mdx format is the plugin's contract with the user's data: it must round-trip, and a
// hand-edited file must never be able to crash the view. These tests cover both, without needing a
// running Obsidian vault — `parseChartFromText` and `extractFrontmatter` are pure by design.
import { parseChartFromText, extractFrontmatter, extractBody, chartToFrontmatter } from '../src/mdx';
import { parseYaml, stringifyYaml } from 'obsidian';

const MINIMAL = `---
quadrant-chart: 1
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
---

Some notes that must survive a save.
`;

describe('extractFrontmatter', () => {
  it('reads a normal block', () => {
    expect(extractFrontmatter(MINIMAL)).toContain('quadrant-chart: 1');
  });

  it('tolerates leading blank lines', () => {
    expect(extractFrontmatter('\n\n---\na: 1\n---\n')).toBe('a: 1');
  });

  it('tolerates trailing whitespace on the delimiters', () => {
    expect(extractFrontmatter('---  \na: 1\n---  \n')).toBe('a: 1');
  });

  it('returns null for a file with no frontmatter', () => {
    expect(extractFrontmatter('# just markdown')).toBeNull();
  });

  it('returns null for an unterminated block rather than swallowing the whole file', () => {
    // Treating an unterminated block as frontmatter would consume the body as YAML and lose it.
    expect(extractFrontmatter('---\na: 1\nstill going')).toBeNull();
  });

  it('returns null for an empty file', () => {
    expect(extractFrontmatter('')).toBeNull();
  });
});

describe('extractBody', () => {
  it('returns the text after the frontmatter', () => {
    expect(extractBody(MINIMAL)).toBe('Some notes that must survive a save.');
  });

  it('returns the whole file when there is no frontmatter', () => {
    expect(extractBody('# hi')).toBe('# hi');
  });

  it('returns empty for frontmatter with no body', () => {
    expect(extractBody('---\na: 1\n---\n')).toBe('');
  });
});

describe('parseChartFromText', () => {
  it('parses a valid chart', () => {
    const chart = parseChartFromText(MINIMAL);
    expect(chart).not.toBeNull();
    expect(chart!.x.label).toBe('Impact');
    expect(chart!.y.label).toBe('Urgency');
    expect(chart!.grid).toEqual({ columns: 2, rows: 2 });
  });

  it('returns null for a .mdx file that is not a chart', () => {
    // The plugin must not hijack unrelated .mdx files.
    expect(parseChartFromText('---\ntitle: something\n---\n')).toBeNull();
  });

  it('returns null for malformed YAML rather than throwing', () => {
    expect(parseChartFromText('---\nquadrant-chart: 1\n  bad: [[[\n---\n')).toBeNull();
  });

  it('accepts the dashed spelling of base-font-size', () => {
    const c = parseChartFromText('---\nquadrant-chart: 1\nbase-font-size: 20\n---\n');
    expect(c!.baseFontSize).toBe(20);
  });

  it('parses items and cells', () => {
    const c = parseChartFromText(`---
quadrant-chart: 1
cells:
  - col: 0
    row: 1
    label: Do now
items:
  - id: a
    text: Ship it
    x: 7.5
    y: 8
---`);
    expect(c!.cells[0].label).toBe('Do now');
    expect(c!.items).toHaveLength(1);
    expect(c!.items[0]).toMatchObject({ id: 'a', text: 'Ship it', x: 7.5, y: 8 });
  });
});

describe('frontmatter round-trip', () => {
  it('survives serialize -> parse unchanged', () => {
    const original = parseChartFromText(MINIMAL)!;
    const yaml = stringifyYaml(chartToFrontmatter(original) as Record<string, unknown>);
    const reparsed = parseChartFromText(`---\n${yaml}---\n`);
    expect(reparsed).toEqual(original);
  });

  it('omits the dashed font-size key when it equals the default', () => {
    // Writing a value that equals the default adds noise to every diff for no information.
    const yaml = stringifyYaml(chartToFrontmatter(parseChartFromText(MINIMAL)!) as Record<string, unknown>);
    expect(yaml).not.toContain('base-font-size');
  });

  it('keeps a non-default font size', () => {
    const c = parseChartFromText('---\nquadrant-chart: 1\nbase-font-size: 22\n---\n')!;
    const yaml = stringifyYaml(chartToFrontmatter(c) as Record<string, unknown>);
    expect(parseYaml(yaml)).toMatchObject({ 'base-font-size': 22 });
  });

  it('drops deleted items rather than resurrecting them', () => {
    // processFrontMatter REPLACES the whole block, so a key left behind would survive a delete.
    const c = parseChartFromText(MINIMAL)!;
    c.items = [];
    const yaml = stringifyYaml(chartToFrontmatter(c) as Record<string, unknown>);
    expect(yaml).not.toContain('items');
  });

  it('rounds coordinates so a dragged value does not accumulate float noise', () => {
    const c = parseChartFromText(MINIMAL)!;
    c.items = [{ id: 'a', text: 'x', x: 1.23456789, y: 2.987654321 }];
    const out = chartToFrontmatter(c);
    expect((out['items'] as Record<string, unknown>[])[0]['x']).toBe(1.23);
    expect((out['items'] as Record<string, unknown>[])[0]['y']).toBe(2.99);
  });

  it('keeps the format marker so the file stays recognised as a chart', () => {
    const yaml = stringifyYaml(chartToFrontmatter(parseChartFromText(MINIMAL)!) as Record<string, unknown>);
    expect(parseYaml(yaml)).toMatchObject({ 'quadrant-chart': 1 });
  });
});
