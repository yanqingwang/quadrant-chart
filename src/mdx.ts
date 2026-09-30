/**
 * Reading and writing the `.mdx` frontmatter.
 *
 * Writing goes through Obsidian's `fileManager.processFrontMatter` rather than string surgery. That
 * helper re-serialises the frontmatter block but leaves the body byte-for-byte, so a user's prose
 * under the chart is never reformatted, reflowed, or lost — the failure mode that makes hand-rolled
 * frontmatter editors destroy notes. It also handles a file that has no frontmatter at all.
 *
 * The one thing we do NOT rely on it for is ordering: `processFrontMatter` writes plain objects, so
 * key order follows insertion order. We therefore build the object in a fixed, readable order
 * (title, axes, grid, cells, items) so the resulting YAML reads top-down rather than alphabetically.
 */

import { App, TFile, parseYaml, stringifyYaml } from 'obsidian';
import { Chart, normalizeChart, createChart, DEFAULTS } from './model';

/**
 * Marks a file as a quadrant chart. A file whose frontmatter lacks this is not treated as a chart,
 * which keeps the plugin from hijacking unrelated `.mdx` files that happen to sit in the vault.
 */
const FORMAT_KEY = 'quadrant-chart';

/** Frontmatter for a brand-new chart, in the order it should be read. */
export function chartToFrontmatter(chart: Chart): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out[FORMAT_KEY] = 1;
  if (chart.title) out['title'] = chart.title;
  out['x'] = axisToYaml(chart.x);
  out['y'] = axisToYaml(chart.y);
  out['grid'] = { columns: chart.grid.columns, rows: chart.grid.rows };
  if (chart.cells.length) out['cells'] = chart.cells.map((c) => {
    const o: Record<string, unknown> = { col: c.col, row: c.row };
    if (c.label) o['label'] = c.label;
    if (c.note) o['note'] = c.note;
    if (c.color) o['color'] = c.color;
    return o;
  });
  if (chart.items.length) {
    out['items'] = chart.items.map((i) => {
      const o: Record<string, unknown> = { id: i.id, text: i.text, x: round(i.x), y: round(i.y) };
      if (i.color) o['color'] = i.color;
      if (i.size) o['size'] = i.size;
      return o;
    });
  }
  if (chart.baseFontSize && chart.baseFontSize !== DEFAULTS.baseFontSize) {
    out['base-font-size'] = chart.baseFontSize;
  }
  return out;
}

/** Round to 2dp so a dragged coordinate does not accumulate float noise in the file. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function axisToYaml(axis: Chart['x']): Record<string, unknown> {
  const o: Record<string, unknown> = { label: axis.label, min: axis.min, max: axis.max };
  if (axis.ticks && axis.ticks.length) o['ticks'] = axis.ticks;
  return o;
}

/** True when this file is a chart this plugin owns. */
export function isChartFile(file: TFile): boolean {
  return file.extension === 'mdx';
}

/**
 * Parse a chart out of a file's frontmatter.
 *
 * Returns null only when the file is not a chart. A chart-shaped file whose contents are damaged
 * still yields a usable chart (via `normalizeChart`), because refusing to open it would leave the
 * user with no way to see — let alone repair — what went wrong.
 */
export async function readChart(app: App, file: TFile): Promise<Chart | null> {
  // `read`, never `cachedRead`. `cachedRead` is allowed to serve a cached copy that predates a
  // recent write, so using it here lets a reload observe the file as it was BEFORE our own write.
  // That reverts the in-memory chart, and the next edit then persists the reverted chart — which
  // silently drops whatever the user added in between. This is a data-loss bug, not a stale-UI one.
  const raw = await app.vault.read(file);
  return parseChartFromText(raw);
}

/** Pure text -> chart. Split out from `readChart` so it is unit-testable without an Obsidian vault. */
export function parseChartFromText(text: string): Chart | null {
  const fm = extractFrontmatter(text);
  if (!fm) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(fm);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (!(FORMAT_KEY in obj)) return null;
  // Accept both the dashed and camel spelling of the font-size key: users hand-edit these files.
  const camel = { ...obj };
  if ('base-font-size' in camel) {
    camel['baseFontSize'] = camel['base-font-size'];
    delete camel['base-font-size'];
  }
  return normalizeChart(camel);
}

/**
 * The text between the opening `---` line and the next `---` line.
 *
 * Written by hand rather than using Obsidian's `getFrontMatterInfo` so the parser stays testable
 * and so the rules are explicit: the opening delimiter must be the first non-blank line, and each
 * delimiter line may carry trailing whitespace without ending the block early.
 */
export function extractFrontmatter(text: string): string | null {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (i >= lines.length || lines[i].trim() !== '---') return null;
  const start = i + 1;
  for (let j = start; j < lines.length; j += 1) {
    if (lines[j].trim() === '---') return lines.slice(start, j).join('\n');
  }
  return null; // unterminated block: not a chart we can trust
}

/** The body text after the frontmatter, with surrounding blank lines trimmed. */
export function extractBody(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (i >= lines.length || lines[i].trim() !== '---') return text.trim();
  const start = i + 1;
  for (let j = start; j < lines.length; j += 1) {
    if (lines[j].trim() === '---') return lines.slice(j + 1).join('\n').trim();
  }
  return '';
}

/**
 * Write the chart back, preserving the body.
 *
 * `processFrontMatter` mutates the file in place, so this is a read-modify-write with no window in
 * which the file holds neither state.
 */
export async function writeChart(app: App, file: TFile, chart: Chart): Promise<void> {
  await app.fileManager.processFrontMatter(file, () => {
    // Return a fresh object: the callback's return value replaces the whole frontmatter block, so
    // keys the chart no longer has (a deleted item, a removed tick) must be absent, not left behind.
    return chartToFrontmatter(chart);
  });
}

/** Full file text for a new chart, frontmatter plus an optional body. */
export function chartToFileText(chart: Chart, body = ''): string {
  const fm = stringifyYaml(chartToFrontmatter(chart) as Record<string, unknown>);
  const trimmed = body.trim();
  return `---\n${fm}---\n${trimmed ? `\n${trimmed}\n` : ''}`;
}

/** Starter body text, so a new chart is self-explanatory in plain text. */
export function defaultBody(columns: number, rows: number): string {
  return [
    `# ${columns}x${rows} quadrant chart`,
    '',
    'The chart above is stored in this file\'s YAML frontmatter — edit it by hand if you like.',
    'Everything below this line is free text and is never touched by the plugin.',
  ].join('\n');
}

export { createChart };
