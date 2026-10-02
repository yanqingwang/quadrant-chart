/**
 * The examples must survive the build, not merely exist in the source tree.
 *
 * `templates.ts` is a generated file that esbuild inlines into `main.js`, and the whole point of
 * embedding it was that a sidecar asset cannot go missing. That guarantee only holds if the text
 * really is inside the bundle — and checking it on the SOURCE file would prove nothing, because
 * esbuild could tree-shake it, rename the import, or fail to inline it.
 *
 * This was not hypothetical. A first pass of this check searched the built bundle for the literal
 * string `人才九宫格`, found nothing, and looked like a real failure. It was not: esbuild's default
 * `charset` is `ascii`, so every non-ASCII character is emitted as a `\uXXXX` escape. The Chinese
 * was in the bundle the whole time, encoded. So the check decodes first — and asserts on the
 * decoded text, which is what the browser will actually see.
 */
import { TEMPLATES } from '../src/templates';
import { parseChartFromText } from '../src/mdx';
import * as fs from 'fs';
import * as path from 'path';

const BUNDLE = path.resolve(__dirname, '../main.js');

/**
 * Undo esbuild's ascii charset escaping, so assertions read against what a browser would see.
 *
 * Both escape forms must be handled. esbuild emits 4-digit `\uXXXX` for U+0000–U+FFFF and 2-digit
 * `\xXX` above that — and the multiplication sign in "3×3" is U+00D7, so it comes out as `\xD7`.
 * A decoder that only handles the 4-digit form leaves those in place, and a search for
 * "SWOT analysis (2×2)" then fails even though the text is plainly in the bundle. That is exactly
 * the false alarm this file's header describes, one level deeper: the check has to be right, not
 * merely suspicious.
 */
function decodeEscapes(bundle: string): string {
  return bundle
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * The embedded frontmatter of one template, extracted from the bundle and turned back into real text.
 *
 * The template lives in the bundle as a JavaScript string literal, so its newlines are the two
 * characters `\` `n`, not real newlines. Searching the decoded bundle for a real `\n---\n`
 * therefore finds nothing even though the chart is right there — the second false alarm this file
 * has had to correct, and the reason the extraction is done explicitly rather than by slicing on
 * `\n`. Returns null rather than throwing, so a miss reports as a clean assertion failure.
 */
function extractEmbeddedChart(bundle: string): string | null {
  const marker = 'quadrant-chart: 1';
  const start = bundle.indexOf(marker);
  if (start === -1) return null;
  // The opening fence precedes the marker; step back over it and the literal's own newline.
  const fence = '---' + String.raw`\n`;
  const openAt = bundle.lastIndexOf(fence, start);
  if (openAt === -1) return null;
  const closeAt = bundle.indexOf(String.raw`\n---`, start);
  if (closeAt === -1) return null;
  // The closing fence is FIVE literal characters — `\`, `n`, and three hyphens — so the slice has
  // to run to closeAt+5, not +4. Off by one here truncates the fence to `--`, the YAML never
  // closes, and the parse returns null for a reason that has nothing to do with the template.
  //
  // Only the newline escaping is undone here; \u and \x were already handled by decodeEscapes, and
  // unescaping them twice would corrupt the text.
  const raw = bundle.slice(openAt, closeAt + 5).replace(/\\n/g, '\n');
  return raw;
}

describe('the built bundle carries the examples', () => {
  const exists = fs.existsSync(BUNDLE);
  const decoded = exists ? decodeEscapes(fs.readFileSync(BUNDLE, 'utf8')) : '';

  it('main.js has been built', () => {
    expect(exists).toBe(true);
    expect(decoded.length).toBeGreaterThan(1000);
  });

  it('registers the command-palette entry', () => {
    expect(decoded).toContain('create-quadrant-chart-from-template');
    expect(decoded).toContain('Create quadrant chart from example');
  });

  it('does not leave templates as an external module', () => {
    // An unbundled import would mean the examples ship as a file the plugin does not have.
    expect(decodeEscapes(fs.readFileSync(BUNDLE, 'utf8'))).not.toMatch(/require\(["']\.\/templates/);
  });

  it.each(TEMPLATES.map((t) => [t.id, t] as const))(
    'embeds the %s example, after decoding escapes',
    (_id, tpl) => {
      expect(decoded).toContain(tpl.name);
      expect(decoded).toContain(tpl.description);

      // Check the real chart content is inlined, not just the metadata. Sample from throughout the
      // text rather than only the start, so a bundle truncated partway through would fail.
      const lines = tpl.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 12);
      expect(lines.length).toBeGreaterThan(10);
      for (const line of [lines[0], lines[Math.floor(lines.length / 2)], lines[lines.length - 1]]) {
        expect(decoded).toContain(line);
      }
    },
  );

  it('embeds the Chinese text of the nine-box, which is what the raw check got wrong', () => {
    const nineBox = TEMPLATES.find((t) => t.id === 'nine-box')!;
    const chinese = nineBox.text.match(/[一-鿿]{2,}/g) ?? [];
    expect(chinese.length).toBeGreaterThan(0);
    for (const phrase of chinese.slice(0, 12)) {
      expect(decoded).toContain(phrase);
    }
  });

  it('embeds text that still parses into the intended chart', () => {
    // Pull the SWOT's own frontmatter out of the bundle and parse it, proving the embedded copy is
    // usable and not truncated at some size limit.
    const extracted = extractEmbeddedChart(decoded);
    expect(extracted).not.toBeNull();
    expect(extracted).toContain('quadrant-chart: 1');
    const parsed = parseChartFromText(`${extracted}\n---\n`);
    expect(parsed).not.toBeNull();
    expect(parsed!.cells.length).toBe(4);
    expect(parsed!.items.length).toBeGreaterThan(15);
  });

  it('the examples are worth their size — roughly 20 KB for both', () => {
    const total = TEMPLATES.reduce((n, t) => n + t.text.length, 0);
    expect(total).toBeGreaterThan(5000);
    expect(total).toBeLessThan(60_000);
  });
});