/**
 * Jest runs in node, so the `obsidian` module must be stubbed: the real package is a type-only
 * facade that needs Electron. Only the two helpers the .mdx format actually uses are implemented,
 * and both delegate to js-yaml so the tests exercise the same serialisation Obsidian performs
 * rather than a hand-written imitation of it that could drift from the real thing.
 *
 * The values are produced eagerly, not per-call, so a test that serialises ten documents does not
 * re-parse js-yaml's module resolution ten times — and, more importantly, so a js-yaml load error
 * surfaces at require time with a clear stack rather than inside an unrelated assertion.
 */
const yaml = require('js-yaml');

module.exports = {
  parseYaml: (text) => yaml.load(text),
  stringifyYaml: (obj) => yaml.dump(obj, { lineWidth: -1 }),
};
