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
      if (i.background) o['background'] = i.background;
      // Only written when true. `box: false` in a file would be noise in every diff of a chart
      // where most labels have no box.
      if (i.box) o['box'] = true;
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
 * `processFrontMatter` hands the callback the CURRENT frontmatter and writes back whatever that
 * object contains when the callback returns. The callback's return value is IGNORED — its type is
 * `(frontmatter: any) => void`. Returning a fresh object therefore does nothing at all: the original
 * frontmatter is written straight back, the file looks untouched, and no error is raised.
 *
 * So the chart is applied by MUTATING the object in place. Every key is cleared first and then
 * re-added, which also fixes the key order: assigning to an existing key keeps its old position, so
 * without the clear a chart edited over many sessions would accumulate the original ordering.
 */
/**
 * Write the chart back, preserving the body.
 *
 * Uses `vault.process`, NOT `fileManager.processFrontMatter`.
 *
 * `processFrontMatter` was the obvious choice — it edits only the frontmatter block and leaves the
 * body alone — but on a `.mdx` file it is a NO-OP that resolves successfully. Measured on a live
 * vault: `commit items=4` -> `processFrontMatter returned OK` -> `VERIFY onDisk items=3`. It
 * resolves, raises nothing, and leaves the file byte-identical, so the plugin appeared to save while
 * nothing was ever written. Its contract is tied to Obsidian's markdown handling, which a custom
 * extension registered against a custom view does not go through.
 *
 * `vault.process(file, fn)` is a read-modify-write over the raw text, independent of file type, and
 * Obsidian performs it as a single operation. Only the frontmatter block is rewritten; everything
 * after it — the user's prose — is carried across untouched.
 */
export async function writeChart(app: App, file: TFile, chart: Chart): Promise<void> {
  await app.vault.process(file, (text) => spliceFrontmatter(text, chart));
  // Confirm the write landed rather than trusting the call — this plugin has been bitten by a write
  // API that resolves successfully and changes nothing, and re-reading is the only way to tell.
  //
  // Isolated in its own try/catch so a failure to VERIFY is never reported as a failed save when the
  // save itself worked; only a genuine mismatch propagates.
  try {
    const after = await app.vault.read(file);
    const reparsed = parseChartFromText(after);
    if (reparsed && reparsed.items.length !== chart.items.length) {
      throw new Error(`save verification failed: wrote ${chart.items.length} labels but the file has ${reparsed.items.length}`);
    }
  } catch (e) {
    if ((e as Error).message.startsWith('save verification failed')) throw e;
  }
}

/**
 * Replace only the YAML frontmatter block, returning the whole file.
 *
 * Deliberately byte-preserving outside the block: the lines before the opening `---` and every line
 * after the closing `---` are carried through unchanged, so a user's body keeps its own spacing,
 * trailing newlines and any `---` inside it. The body is never re-serialised, because doing so would
 * silently reflow their notes.
 *
 * Handles the three shapes a file can be in: a normal frontmatter block, no frontmatter at all (one
 * is prepended, keeping the old text as the body), and an unterminated block (treated as body, since
 * guessing where it was meant to end would risk eating real content).
 */
export function spliceFrontmatter(text: string, chart: Chart): string {
  const yaml = stringifyYaml(chartToFrontmatter(chart)).replace(/\n+$/, '');
  const lines = text.split('\n');

  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;

  if (i >= lines.length || lines[i].trim() !== '---') {
    const body = text.replace(/^\n+/, '');
    return `---\n${yaml}\n---\n\n${body}`;
  }

  const start = i + 1;
  let end = -1;
  for (let j = start; j < lines.length; j += 1) {
    if (lines[j].trim() === '---') { end = j; break; }
  }
  if (end === -1) {
    // Unterminated: the whole file is body. Prepending is the only safe reading.
    return `---\n${yaml}\n---\n\n${text.replace(/^\n+/, '')}`;
  }

  // Replace only the block's contents; the delimiters themselves and everything else stay put.
  lines.splice(start, end - start, ...yaml.split('\n'));
  return lines.join('\n');
}

/** Full file text for a new chart, frontmatter plus an optional body. */
export function chartToFileText(chart: Chart, body = ''): string {
  const fm = stringifyYaml(chartToFrontmatter(chart));
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
