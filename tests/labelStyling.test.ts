/**
 * @jest-environment jsdom
 *
 * Label styling: background plate, outline box, edit and delete.
 *
 * These are file-format features as much as UI ones: `background` and `box` live in the `.mdx`
 * frontmatter, so a chart written by the Python API and one written by clicking must be the same
 * shape. That interop is asserted in tests/apiInterop.test.ts; this file covers the plugin side.
 *
 * Note the round-trip hazard these fields introduce. The writer omits `box` when false, and the
 * reader only accepts a real boolean — a hand-edited `box: "false"` string is truthy in JavaScript,
 * so accepting it would show a box the author explicitly turned off.
 */
import { ChartCanvas } from '../src/canvas';
import { chartToFrontmatter, parseChartFromText, chartToFileText } from '../src/mdx';
import { Chart, createChart, normalizeChart } from '../src/model';

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
  return { canvas, changes, svg: canvas['svg'] as SVGSVGElement };
}

const svgOf = (c: ChartCanvas) => c['svg'] as SVGSVGElement;

function labelled(extra: Partial<Chart['items'][number]> = {}): Chart {
  const c = createChart(2, 2);
  return { ...c, items: [{ id: 'l1', text: 'Styled label', x: 1, y: 1, ...extra }] };
}

describe('a label can have a background plate', () => {
  it('draws one when set', () => {
    const { svg } = build(labelled({ background: '#fdd663' }));
    const bg = svg.querySelector('g[data-item-id="l1"] .qc-item-bg');
    expect(bg).not.toBeNull();
    expect(bg!.getAttribute('fill')).toBe('#fdd663');
  });

  it('draws none when unset', () => {
    const { svg } = build(labelled());
    expect(svg.querySelector('.qc-item-bg')).toBeNull();
  });

  it('draws the plate behind the text', () => {
    const { svg } = build(labelled({ background: '#fdd663' }));
    const classes = Array.from(svg.querySelector('g[data-item-id="l1"]')!.children)
      .map((c) => c.getAttribute('class'));
    expect(classes.indexOf('qc-item-bg')).toBeLessThan(classes.indexOf('qc-item-text'));
  });
});

describe('a label can have an outline box', () => {
  it('draws one when box is true', () => {
    const { svg } = build(labelled({ box: true }));
    expect(svg.querySelector('g[data-item-id="l1"] .qc-item-box')).not.toBeNull();
  });

  it('draws none when box is false or absent', () => {
    expect(svgOf(build(labelled({ box: false })).canvas).querySelector('.qc-item-box')).toBeNull();
    expect(svgOf(build(labelled()).canvas).querySelector('.qc-item-box')).toBeNull();
  });

  it('keeps the author box and the selection box visually distinct', () => {
    const { canvas, svg } = build(labelled({ box: true }));
    svg.querySelector('g[data-item-id="l1"] .qc-item-hit')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Both present at once, each with its own class — the transient one must not replace the
    // permanent one, or deselecting would silently delete a border the author asked for.
    expect(svg.querySelector('.qc-item-box')).not.toBeNull();
    expect(svg.querySelector('.qc-item-selected')).not.toBeNull();
    expect(canvas.getSelectedItem()).toBe('l1');
  });

  it('a hand-edited "false" string does not turn the box on', () => {
    const chart = normalizeChart({
      'quadrant-chart': 1, grid: { columns: 2, rows: 2 },
      x: { label: 'X', min: 0, max: 10 }, y: { label: 'Y', min: 0, max: 10 },
      items: [{ id: 'a', text: 'hi', x: 1, y: 1, box: 'false' }],
    } as never);
    expect(chart.items[0].box).toBeUndefined();
  });
});

describe('the file format carries both fields', () => {
  it('writes background and box', () => {
    const fm = chartToFrontmatter(labelled({ background: '#fdd663', box: true }));
    expect((fm['items'] as Record<string, unknown>[])[0]).toMatchObject({
      background: '#fdd663', box: true,
    });
  });

  it('omits box when false, to keep diffs quiet', () => {
    const fm = chartToFrontmatter(labelled({ box: false }));
    expect(Object.keys(fm['items'] as object[] extends never ? never : Record<string, unknown>[])[0])
      .not.toContain('box');
  });

  it('omits background when unset', () => {
    const fm = chartToFrontmatter(labelled());
    expect((fm['items'] as Record<string, unknown>[])[0]).not.toHaveProperty('background');
  });

  it('round-trips through text', () => {
    const original = labelled({ background: '#fdd663', box: true });
    const parsed = parseChartFromText(chartToFileText(original))!;
    expect(parsed.items[0].background).toBe('#fdd663');
    expect(parsed.items[0].box).toBe(true);
    expect(parsed.items[0].text).toBe('Styled label');
  });

  it('round-trips a label with neither field', () => {
    const parsed = parseChartFromText(chartToFileText(labelled()))!;
    expect(parsed.items[0].background).toBeUndefined();
    expect(parsed.items[0].box).toBeUndefined();
  });
});

describe('a label can be deleted', () => {
  it('removes it and saves', () => {
    const { canvas, changes } = build(labelled());
    canvas.removeItem('l1');
    expect(canvas.getChart().items).toHaveLength(0);
    expect(changes).toHaveLength(1);
    expect(changes[0].items).toHaveLength(0);
  });

  it('is a no-op for an id that is not there', () => {
    const { canvas, changes } = build(labelled());
    canvas.removeItem('nope');
    expect(canvas.getChart().items).toHaveLength(1);
    expect(changes).toHaveLength(0);
  });

  it('leaves other labels alone', () => {
    const c = createChart(2, 2);
    const { canvas } = build({
      ...c,
      items: [
        { id: 'keep', text: 'Keep me', x: 1, y: 1 },
        { id: 'drop', text: 'Drop me', x: 2, y: 2 },
      ],
    });
    canvas.removeItem('drop');
    expect(canvas.getChart().items.map((i) => i.id)).toEqual(['keep']);
  });

  it('clears the selection when the selected label is deleted', () => {
    const { canvas, svg } = build(labelled());
    svg.querySelector('g[data-item-id="l1"] .qc-item-hit')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(canvas.getSelectedItem()).toBe('l1');
    canvas.removeItem('l1');
    expect(canvas.getSelectedItem()).toBeNull();
    expect(svg.querySelectorAll('.qc-item-selected')).toHaveLength(0);
  });

  it('does not clear a selection that points at a different label', () => {
    const c = createChart(2, 2);
    const { canvas, svg } = build({
      ...c,
      items: [
        { id: 'a', text: 'A', x: 1, y: 1 },
        { id: 'b', text: 'B', x: 2, y: 2 },
      ],
    });
    svg.querySelector('g[data-item-id="a"] .qc-item-hit')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    canvas.removeItem('b');
    expect(canvas.getSelectedItem()).toBe('a');
  });
});

describe('a label can be edited', () => {
  it('renames it and saves', async () => {
    const c = createChart(2, 2);
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
    document.body.appendChild(container);
    const changes: Chart[] = [];
    const canvas = new ChartCanvas({} as never, container, { ...c, items: [{ id: 'a', text: 'Before', x: 1, y: 1 }] }, {
      file: FILE,
      onChange: (ch) => changes.push(ch),
      onSelectCell: () => undefined,
      promptText: async () => 'After',
    });
    canvas.measure();
    canvas.render();
    await canvas.renameItem({ id: 'a', text: 'Before', x: 1, y: 1 });
    expect(canvas.getChart().items[0].text).toBe('After');
    expect(changes).toHaveLength(1);
  });

  it('keeps the styling when the text is edited', async () => {
    const c = createChart(2, 2);
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
    document.body.appendChild(container);
    const canvas = new ChartCanvas({} as never, container, {
      ...c, items: [{ id: 'a', text: 'Before', x: 1, y: 1, background: '#fdd663', box: true }],
    }, {
      file: FILE,
      onChange: () => undefined,
      onSelectCell: () => undefined,
      promptText: async () => 'After',
    });
    canvas.measure();
    canvas.render();
    await canvas.renameItem({ id: 'a', text: 'Before', x: 1, y: 1, background: '#fdd663', box: true });
    // The whole point of spreading `...i` rather than rebuilding the object.
    expect(canvas.getChart().items[0]).toMatchObject({ background: '#fdd663', box: true });
  });
});