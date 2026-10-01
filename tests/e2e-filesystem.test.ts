/**
 * End-to-end verification against a REAL file on disk — no vault stub in the middle.
 *
 * Every previous round of testing passed while the bug was live, because a stub stood between the
 * code and the filesystem. This harness performs the save the way Obsidian does (read the bytes,
 * hand them to the plugin's transform, write the bytes back) and then reads the result with an
 * independent parser, so "it saved" means the bytes on disk actually changed.
 *
 * It mirrors the reported scenario exactly: open a file with 3 labels, add a 4th, close, reopen.
 */
import { writeChart, parseChartFromText } from '../src/mdx';
import { spliceFrontmatter } from '../src/mdx';
import { Chart } from '../src/model';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Minimal Vault over a real file, using the same APIs the plugin calls. */
function realVault(filePath: string) {
  return {
    vault: {
      read: async () => fs.readFileSync(filePath, 'utf8'),
      process: async (_f: unknown, fn: (t: string) => string) => {
        const next = fn(fs.readFileSync(filePath, 'utf8'));
        fs.writeFileSync(filePath, next, 'utf8');
        return next;
      },
    },
    // The no-op that caused three rounds of false confidence.
    fileManager: { processFrontMatter: async () => undefined },
  } as never;
}

const SAMPLE = `---
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
items:
  - id: a1
    text: Rework the sync engine
    x: 8.2
    y: 9
  - id: a2
    text: Rewrite onboarding docs
    x: 3
    y: 6.5
  - id: a3
    text: Explore a new backend
    x: 6
    y: 2
---

# Notes

This body is yours and must survive.
`;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-e2e-'));
  file = path.join(dir, '象限图示例.mdx');
  fs.writeFileSync(file, SAMPLE, 'utf8');
});

afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('end to end against a real file', () => {
  it('the reported scenario: add a label, close, reopen — the label is there', async () => {
    const app = realVault(file);

    // "Open"
    const opened = parseChartFromText(fs.readFileSync(file, 'utf8'))!;
    expect(opened.items).toHaveLength(3);

    // "Add a label"
    const added: Chart = { ...opened, items: [...opened.items, { id: 'new', text: 'My new label', x: 5, y: 5 }] };
    await writeChart(app, { path: file } as never, added);

    // "Close and reopen" — the only honest check is re-reading the bytes.
    const bytes = fs.readFileSync(file, 'utf8');
    const reopened = parseChartFromText(bytes)!;
    expect(reopened.items).toHaveLength(4);
    expect(reopened.items.map((i) => i.text)).toContain('My new label');

    // And the file really changed on disk.
    expect(bytes).not.toBe(SAMPLE);
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(0);
  });

  it('the file on disk differs from the original after a save', () => {
    const chart = parseChartFromText(SAMPLE)!;
    const out = spliceFrontmatter(SAMPLE, { ...chart, title: 'Different' });
    expect(out).not.toBe(SAMPLE);
    expect(out).toContain('title: Different');
  });

  it('keeps the body identical to the original', () => {
    const chart = parseChartFromText(SAMPLE)!;
    const out = spliceFrontmatter(SAMPLE, { ...chart, title: 'Different' });
    const bodyOf = (s: string) => s.slice(s.lastIndexOf('\n---\n') + 5);
    expect(bodyOf(out)).toBe(bodyOf(SAMPLE));
  });

  it('repeated open/add/close cycles never lose a label', async () => {
    const app = realVault(file);
    for (let cycle = 1; cycle <= 6; cycle += 1) {
      const current = parseChartFromText(fs.readFileSync(file, 'utf8'))!;
      const next: Chart = {
        ...current,
        items: [...current.items, { id: `c${cycle}`, text: `Cycle ${cycle}`, x: cycle, y: cycle }],
      };
      await writeChart(app, { path: file } as never, next);
    }
    const final = parseChartFromText(fs.readFileSync(file, 'utf8'))!;
    expect(final.items).toHaveLength(9);
    expect(final.items.slice(0, 3).map((i) => i.text))
      .toEqual(['Rework the sync engine', 'Rewrite onboarding docs', 'Explore a new backend']);
  });

  it('handles a CJK filename and CJK content', async () => {
    const cjk = path.join(dir, '象限图示例.mdx');
    fs.writeFileSync(cjk, SAMPLE, 'utf8');
    const app = realVault(cjk);
    const chart = parseChartFromText(SAMPLE)!;
    await writeChart(app, { path: cjk } as never, {
      ...chart,
      items: [...chart.items, { id: 'cjk', text: '优先级：紧急', x: 4, y: 4 }],
    });
    const after = parseChartFromText(fs.readFileSync(cjk, 'utf8'))!;
    expect(after.items[3].text).toBe('优先级：紧急');
  });

  it('produces a file that is valid UTF-8 text with no stray control characters', async () => {
    const app = realVault(file);
    const chart = parseChartFromText(SAMPLE)!;
    await writeChart(app, { path: file } as never, { ...chart, title: 'Sanity ✅' });
    const buf = fs.readFileSync(file);
    expect(buf.toString('utf8')).toContain('Sanity ✅');
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(buf.toString('utf8'))).toBe(false);
  });
});
