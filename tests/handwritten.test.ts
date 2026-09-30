// Verifies a chart authored the way a USER would author one — a hand-written .mdx file, not one
// produced by this plugin — is accepted. The plugin's own writer is not the only producer of these
// files, and a format that only round-trips against itself is not really a file format.
import { parseChartFromText, extractBody } from '../src/mdx';

const HAND_WRITTEN = `---
quadrant-chart: 1
title: Q1 Priorities
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
cells:
  - col: 1
    row: 1
    label: Do now
    color: "#d93025"
    note: Blocking a release
  - col: 0
    row: 1
    label: Schedule
    color: "#f9ab00"
items:
  - id: a1
    text: Rework the sync engine
    x: 8.2
    y: 9
  - id: a2
    text: Rewrite the onboarding docs
    x: 3
    y: 6.5
  - id: a3
    text: Explore a new sync backend
    x: 6
    y: 2
---

# Notes

This body is yours. The plugin only rewrites the frontmatter above.
`;

describe('a hand-written .mdx file', () => {
  it('is recognised as a chart', () => {
    expect(parseChartFromText(HAND_WRITTEN)).not.toBeNull();
  });

  it('reads every field an author would write', () => {
    const c = parseChartFromText(HAND_WRITTEN)!;
    expect(c.title).toBe('Q1 Priorities');
    expect(c.x.label).toBe('Impact');
    expect(c.y.label).toBe('Urgency');
    expect(c.grid).toEqual({ columns: 2, rows: 2 });
    expect(c.cells).toHaveLength(2);
    expect(c.items).toHaveLength(3);
  });

  it('keeps quoted hex colours intact', () => {
    const c = parseChartFromText(HAND_WRITTEN)!;
    // Unquoted #d93025 is a YAML comment; a file that quotes it must not lose the '#'.
    expect(c.cells.find((x) => x.label === 'Do now')?.color).toBe('#d93025');
  });

  it('leaves the body intact', () => {
    expect(extractBody(HAND_WRITTEN)).toContain('This body is yours.');
  });

  it('accepts a minimal file with nothing but the marker', () => {
    const c = parseChartFromText('---\nquadrant-chart: 1\n---\n');
    expect(c).not.toBeNull();
    expect(c!.grid.columns).toBe(2);
    expect(c!.items).toEqual([]);
  });

  it('accepts a chart with items but no cells', () => {
    const c = parseChartFromText('---\nquadrant-chart: 1\nitems:\n  - text: solo\n    x: 1\n    y: 2\n---\n')!;
    expect(c.items).toHaveLength(1);
    expect(c.items[0].text).toBe('solo');
  });
});
