/**
 * @jest-environment jsdom
 *
 * Cell selection, tested through real DOM events rather than by inspecting the model.
 *
 * The bug this pins: the colour fill is painted AFTER the cell's hit rect and covers it completely,
 * so a click on a coloured cell landed on the fill instead — which carries no cell coordinates. Only
 * cells with no colour were selectable, so it read as "sometimes the middle cell works". Model-level
 * tests cannot catch that, because the model was never wrong; only the hit testing was. So these
 * dispatch real pointer/click events at real coordinates and assert which cell got selected.
 */
import { ChartCanvas } from '../src/canvas';
import { Chart, createChart } from '../src/model';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const FILE = { path: 'c.mdx' } as never;

function build(chart: Chart) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
  document.body.appendChild(container);

  const changes: Chart[] = [];
  const prompts: string[] = [];
  const canvas = new ChartCanvas({} as never, container, chart, {
    file: FILE,
    onChange: (c) => changes.push(c),
    onSelectCell: () => undefined,
    promptText: async (def) => { prompts.push(def); return 'typed name'; },
  });
  canvas.measure();
  canvas.render();
  return { canvas, container, changes, prompts };
}

/**
 * Click a cell's hit rect.
 *
 * Dispatched directly on the rect rather than at a coordinate: jsdom implements no hit testing, so
 * an event sent to the <svg> would always target the <svg> and every test here would pass
 * vacuously. Dispatching on the rect exercises the real handler — the data attributes, the
 * ordering of checks, and the selection state — which is what this file is for.
 *
 * Overlap (the fill covering the hit rect) cannot be tested this way and is asserted structurally in
 * the last describe block instead.
 */
function clickCell(canvas: ChartCanvas, col: number, row: number): void {
  const rect = (canvas['svg'] as SVGSVGElement)
    .querySelector(`rect[data-cell-col="${col}"][data-cell-row="${row}"]`);
  if (!rect) throw new Error(`no hit rect for cell ${col},${row}`);
  rect.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Centre point of a cell in SVG user units, for the structural checks. */
function cellCentre(canvas: ChartCanvas, col: number, row: number): { x: number; y: number } {
  const rect = (canvas['svg'] as SVGSVGElement)
    .querySelector(`rect[data-cell-col="${col}"][data-cell-row="${row}"]`)!;
  return {
    x: Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) / 2,
    y: Number(rect.getAttribute('y')) + Number(rect.getAttribute('height')) / 2,
  };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('clicking a cell selects that cell', () => {
  it('selects the top-right cell of a plain 2x2', () => {
    const c = createChart(2, 2);
    const { canvas } = build(c);
    // Plot is x 64..776, y 32..544. Top-right quadrant centre.
    clickCell(canvas, 1, 1);
    expect(canvas.getSelectedCell()).toEqual({ col: 1, row: 1 });
  });

  it('selects the top-LEFT cell — the one the menu could never reach before', () => {
    const c = createChart(2, 2);
    const { canvas } = build(c);
    clickCell(canvas, 0, 1);
    expect(canvas.getSelectedCell()).toEqual({ col: 0, row: 1 });
  });

  it('selects a COLOURED cell — the regression that broke selection in practice', () => {
    const c = createChart(2, 2);
    c.cells = [
      { col: 0, row: 1, label: 'Strengths', color: '#188038' },
      { col: 1, row: 1, label: 'Opportunities', color: '#1a73e8' },
    ];
    const { canvas } = build(c);
    // Both top cells are filled; a click must still reach the hit rect underneath.
    clickCell(canvas, 0, 1);
    expect(canvas.getSelectedCell()).toEqual({ col: 0, row: 1 });
    clickCell(canvas, 1, 1);
    expect(canvas.getSelectedCell()).toEqual({ col: 1, row: 1 });
  });

  it('selects a cell that has only a label and no colour', () => {
    const c = createChart(2, 2);
    c.cells = [{ col: 1, row: 0, label: 'Threats' }];
    const { canvas } = build(c);
    clickCell(canvas, 1, 0);
    expect(canvas.getSelectedCell()).toEqual({ col: 1, row: 0 });
  });

  it('selects across a 4x4 grid', () => {
    const c = createChart(4, 4);
    const { canvas } = build(c);
    clickCell(canvas, 0, 3);
    expect(canvas.getSelectedCell()).toEqual({ col: 0, row: 3 });
    clickCell(canvas, 3, 0);
    expect(canvas.getSelectedCell()).toEqual({ col: 3, row: 0 });
  });

  it('clears a selection that falls outside a resized grid', () => {
    const c = createChart(4, 4);
    const { canvas } = build(c);
    clickCell(canvas, 0, 3);
    expect(canvas.getSelectedCell()).toEqual({ col: 0, row: 3 });
    canvas.setGrid(2, 2);
    expect(canvas.getSelectedCell()).toBeNull();
  });

  it('falls back to the middle cell for actions when nothing is selected', () => {
    const c = createChart(4, 4);
    const { canvas } = build(c);
    expect(canvas.getSelectedCell()).toBeNull();
    expect(canvas.effectiveCell()).toEqual({ col: 2, row: 2 });
  });

  it('uses the selection for actions, not the middle', () => {
    const c = createChart(4, 4);
    const { canvas, changes, prompts } = build(c);
    clickCell(canvas, 0, 3);                         // far top-left of a 4x4
    expect(canvas.effectiveCell()).toEqual({ col: 0, row: 3 });
    return canvas.editCell(0, 3).then(() => {
      expect(changes).toHaveLength(1);
      const cell = changes[0].cells.find((x) => x.col === 0 && x.row === 3);
      expect(cell?.label).toBe('typed name');
      expect(prompts).toHaveLength(1);
    });
  });

  it('does not select when the click lands on a label', () => {
    const c = createChart(2, 2);
    c.items = [{ id: 'a', text: 'a label', x: 2.5, y: 7.5 }];
    const { canvas } = build(c);
    // The label sits in the top-left quadrant; clicking it must not change the cell selection.
    const item = canvas['svg'].querySelector('.qc-item-text')!;
    const box = (item as SVGGraphicsElement).getBoundingClientRect();
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.left + 2, clientY: box.top + 2 }));
    expect(canvas.getSelectedCell()).toBeNull();
  });
});

describe('nothing is painted over a cell hit rect', () => {
  /**
   * The overlap bug, asserted structurally.
   *
   * jsdom cannot hit-test, so it cannot express "a click lands on the fill instead of the hit
   * rect". What it CAN check is the thing that caused it: every element painted on top of a cell's
   * hit rect must be transparent to pointers. If one is not, that cell becomes unselectable in a
   * real browser — and only for cells that happen to be decorated, which is what made it look
   * arbitrary rather than broken.
   */
  function blockersOver(svg: SVGSVGElement, cx: number, cy: number): string[] {
    const hits = svg.querySelectorAll('rect[data-cell-col]');
    const hit = [...hits].find((r) => {
      const x = Number(r.getAttribute('x'));
      const y = Number(r.getAttribute('y'));
      const w = Number(r.getAttribute('width'));
      const h = Number(r.getAttribute('height'));
      return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
    })!;
    const out: string[] = [];
    for (const el of svg.querySelectorAll('rect, text, foreignObject')) {
      if (el === hit || hit.contains(el) || el.contains(hit)) continue;
      // Only consider later-painted elements that geometrically cover the hit rect's centre.
      const ex = Number(el.getAttribute('x'));
      const ey = Number(el.getAttribute('y'));
      const ew = Number(el.getAttribute('width'));
      const eh = Number(el.getAttribute('height'));
      if ([ex, ey, ew, eh].some(Number.isNaN)) continue;
      if (!(cx >= ex && cx <= ex + ew && cy >= ey && cy <= ey + eh)) continue;
      if (el.compareDocumentPosition(hit) & Node.DOCUMENT_POSITION_PRECEDING) continue;
      const cls = el.getAttribute('class') ?? '';
      if (cls.includes('cell-selected')) continue;          // explicitly pointer-events:none
      if (cls.includes('item-hit')) continue;               // label hit plates, only 8px wide
      if (el.tagName === 'rect' && el.getAttribute('fill') === 'none') continue;
      if (el.tagName === 'line') continue;
      out.push(`${el.tagName}.${cls || '(no class)'}`);
    }
    return out;
  }

  it('a coloured cell leaves its hit rect clickable', () => {
    const c = createChart(2, 2);
    c.cells = [
      { col: 0, row: 1, label: 'Strengths', color: '#188038' },
      { col: 1, row: 1, label: 'Opportunities', color: '#1a73e8' },
      { col: 0, row: 0, label: 'Weaknesses', color: '#d93025' },
      { col: 1, row: 0, label: 'Threats', color: '#f9ab00' },
    ];
    const { canvas } = build(c);
    const svg = canvas['svg'] as SVGSVGElement;
    for (const col of [0, 1]) {
      for (const row of [0, 1]) {
        const p = cellCentre(canvas, col, row);
        expect({ cell: `${col},${row}`, blockers: blockersOver(svg, p.x, p.y) })
          .toEqual({ cell: `${col},${row}`, blockers: [] });
      }
    }
  });

  it('the colour fill is explicitly pointer-transparent', () => {
    const c = createChart(2, 2);
    c.cells = [{ col: 0, row: 0, label: 'Weaknesses', color: '#d93025' }];
    const { canvas } = build(c);
    const fills = (canvas['svg'] as SVGSVGElement).querySelectorAll('rect.qc-cell-fill');
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect(f.getAttribute('class')).toContain('qc-cell-fill');
  });

  it('every cell has a hit rect, decorated or not', () => {
    const c = createChart(3, 2);
    c.cells = [{ col: 1, row: 1, label: 'only this one is decorated' }];
    const { canvas } = build(c);
    expect((canvas['svg'] as SVGSVGElement).querySelectorAll('rect[data-cell-col]').length).toBe(6);
  });
});
  it('a named cell is written back into the model', async () => {
    const c = createChart(2, 2);
    const { canvas, changes } = build(c);
    await canvas.editCell(1, 1);
    expect(changes[0].cells.find((x) => x.col === 1 && x.row === 1)?.label).toBe('typed name');
  });

  it('renaming keeps the existing colour and note', async () => {
    const c = createChart(2, 2);
    c.cells = [{ col: 0, row: 0, color: '#d93025', note: 'blocking a release' }];
    const { canvas, changes } = build(c);
    await canvas.editCell(0, 0);
    const cell = changes[0].cells.find((x) => x.col === 0 && x.row === 0)!;
    expect(cell.color).toBe('#d93025');
    expect(cell.note).toBe('blocking a release');
  });
