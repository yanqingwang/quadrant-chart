import { parseChartFromText } from '../src/mdx';
import * as fs from 'fs';
import { findCell } from '../src/geometry';

const raw = fs.readFileSync('/home/wang/wk/wk/SWOT-示例.mdx', 'utf8');
const c = parseChartFromText(raw)!;

describe('the shipped SWOT example', () => {
  it('parses as a chart', () => { expect(c).not.toBeNull(); });
  it('is a 2x2 grid', () => { expect(c.grid).toEqual({ columns: 2, rows: 2 }); });
  it('names all four cells', () => {
    const labels = [findCell(c,0,1)?.label, findCell(c,1,1)?.label, findCell(c,0,0)?.label, findCell(c,1,0)?.label];
    expect(labels.sort()).toEqual(['Opportunities','Strengths','Threats','Weaknesses']);
  });
  it('gives every cell a distinct colour', () => {
    const colors = c.cells.map((x) => x.color);
    expect(new Set(colors).size).toBe(4);
  });
  it('keeps every label inside the plot', () => {
    for (const i of c.items) {
      expect(i.x).toBeGreaterThanOrEqual(c.x.min);
      expect(i.x).toBeLessThanOrEqual(c.x.max);
      expect(i.y).toBeGreaterThanOrEqual(c.y.min);
      expect(i.y).toBeLessThanOrEqual(c.y.max);
    }
  });
  it('puts labels in the quadrant their cell colour implies', () => {
    const inCell = (col: number, row: number) => c.items.filter((i) => {
      const cc = Math.min(1, Math.floor(((i.x - c.x.min) / 10) * 2));
      const rr = Math.min(1, Math.floor(((i.y - c.y.min) / 10) * 2));
      return cc === col && rr === row;
    });
    expect(inCell(1,1).length).toBeGreaterThanOrEqual(3);  // strengths
    expect(inCell(0,1).length).toBeGreaterThanOrEqual(3);  // weaknesses
    expect(inCell(1,0).length).toBeGreaterThanOrEqual(2);  // opportunities
    expect(inCell(0,0).length).toBeGreaterThanOrEqual(2);  // threats
  });
  it('keeps the explanatory body', () => {
    expect(raw).toContain('## How the colours are assigned');
    expect(raw).toContain('#188038');
  });
});
