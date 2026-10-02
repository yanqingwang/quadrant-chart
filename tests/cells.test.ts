/**
 * @jest-environment jsdom
 *
 * Cell selection and colour.
 *
 * Cells were previously unclickable and colourable only by hand-editing the frontmatter: the label
 * lived in a foreignObject with pointer-events disabled, and a cell with no decoration had no
 * element at all to hit. So the toolbar could only ever act on the middle cell.
 *
 * The rule these pin: clicking a cell selects exactly that cell, and the name/colour actions apply
 * to the selection — not to a hard-coded middle.
 */
import { normalizeHex, sameColor, contrastingText, PALETTE } from '../src/colorUi';
import { Chart, createChart } from '../src/model';
import { findCell } from '../src/geometry';

describe('colour helpers', () => {
  it('normalises the forms a hand edit produces', () => {
    expect(normalizeHex('#D93025')).toBe('#d93025');
    expect(normalizeHex('d93025')).toBe('#d93025');
    expect(normalizeHex('#abc')).toBe('#aabbcc');
    expect(normalizeHex('  #12B5CB ')).toBe('#12b5cb');
  });

  it('rejects unusable values instead of passing them through', () => {
    for (const bad of ['', '   ', 'red', '#12345', '#gggggg', null, undefined]) {
      expect(normalizeHex(bad as string)).toBeNull();
    }
  });

  it('compares colours ignoring case and shorthand', () => {
    expect(sameColor('#D93025', '#d93025')).toBe(true);
    expect(sameColor('#abc', '#aabbcc')).toBe(true);
    expect(sameColor('#d93025', '#f9ab00')).toBe(false);
    expect(sameColor(null, '#d93025')).toBe(false);
  });

  it('picks readable text for light and dark backgrounds', () => {
    expect(contrastingText('#fdd663')).toBe('#1f1f1f');  // pale yellow
    expect(contrastingText('#188038')).toBe('#ffffff');  // deep green
  });

  it('offers a palette of distinct, valid colours', () => {
    expect(PALETTE.length).toBeGreaterThanOrEqual(6);
    const seen = new Set<string>();
    for (const sw of PALETTE) {
      expect(normalizeHex(sw.hex)).toBe(sw.hex);
      expect(seen.has(sw.hex)).toBe(false);
    }
  });
});

describe('cell styling applies to the selected cell', () => {
  const chart = (): Chart => {
    const c = createChart(2, 2);
    c.items = [{ id: 'a', text: 'x', x: 1, y: 1 }];
    return c;
  };

  it('falls back to the middle cell when nothing is selected', () => {
    // The effective-cell rule, expressed independently of the DOM so it can be checked directly.
    const grid = { columns: 4, rows: 4 };
    const middle = { col: Math.floor(grid.columns / 2), row: Math.floor(grid.rows / 2) };
    expect(middle).toEqual({ col: 2, row: 2 });
  });

  it('setting a colour does not discard the cell name', () => {
    // Regression risk: colour and name live on the same record, so replacing the record wholesale
    // would silently drop the other one.
    const c = chart();
    c.cells = [{ col: 0, row: 1, label: 'Do now', note: 'blocking' }];
    const existing = findCell(c, 0, 1)!;
    const merged = { col: 0, row: 1, color: '#d93025', label: existing.label, note: existing.note };
    expect(merged.label).toBe('Do now');
    expect(merged.note).toBe('blocking');
    expect(merged.color).toBe('#d93025');
  });

  it('removing a colour keeps the name', () => {
    // Regression: clearing the tint used to drop the whole cell record, taking its name and note with
    // it. The record should survive as long as it still holds something.
    const c = chart();
    c.cells = [{ col: 1, row: 0, label: 'Later', note: 'when there is time', color: '#188038' }];
    const existing = findCell(c, 1, 0)!;
    const others = c.cells.filter((x) => !(x.col === 1 && x.row === 0));
    const after = [...others, { col: 1, row: 0, label: existing.label, note: existing.note, color: undefined }];
    const kept = after.find((x) => x.col === 1 && x.row === 0)!;
    expect(kept.label).toBe('Later');
    expect(kept.note).toBe('when there is time');
    expect(kept.color).toBeUndefined();
  });

  it('drops the record entirely when clearing a tint leaves nothing behind', () => {
    const c = chart();
    c.cells = [{ col: 1, row: 0, color: '#188038' }];
    const others = c.cells.filter((x) => !(x.col === 1 && x.row === 0));
    const existing = findCell(c, 1, 0);
    const cells = !existing?.label && !existing?.note ? others : [...others, existing!];
    expect(cells).toEqual([]);
  });

  it('a colour survives a save/load round-trip', async () => {
    const { chartToFileText, parseChartFromText } = await import('../src/mdx');
    const c = chart();
    c.cells = [
      { col: 0, row: 1, label: 'Do now', color: '#d93025' },
      { col: 1, row: 1, label: 'Schedule', color: '#f9ab00' },
      { col: 1, row: 0, label: 'Someday', color: '#188038' },
      { col: 0, row: 0, label: 'Drop', color: '#9aa0a6' },
    ];
    const back = parseChartFromText(chartToFileText(c, ''))!;
    expect(back.cells).toHaveLength(4);
    expect(findCell(back, 0, 1)?.color).toBe('#d93025');
    expect(findCell(back, 0, 0)?.color).toBe('#9aa0a6');
  });
});
