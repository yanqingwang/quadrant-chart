/**
 * Jest stubs for the `obsidian` module. The real package is a type-only facade at runtime (it needs
 * Electron), so anything under test has to be given a working substitute.
 *
 * `parseYaml` / `stringifyYaml` delegate to js-yaml so the .mdx tests exercise the same
 * serialisation Obsidian performs rather than a hand-written imitation that could drift.
 *
 * `FileView` exists so the VIEW LIFECYCLE can be tested. That lifecycle is the plugin's highest-risk
 * surface — a wrong hook means edits silently never reach disk — and it cannot be checked by
 * reading types alone, because the types say what is allowed, not when the framework calls it.
 */
const yaml = require('js-yaml');

class TFile {
  constructor(path, content = '') {
    this.path = path;
    this.basename = path.split('/').pop();
    this.extension = (path.split('.').pop() || '').toLowerCase();
    this._content = content;
  }
  get stat() {
    return { ctime: 0, mtime: 0, size: this._content.length };
  }
}

class TFolder {
  constructor(path) {
    this.path = path;
    this.name = path.split('/').pop();
  }
}

class Notice {
  constructor(message) {
    Notice.messages.push(message);
  }
}
Notice.messages = [];

class Menu {
  addItem(cb) { cb(this._item()); }
  addSeparator() {}
  showAtMouseEvent() {}
  _item() {
    const self = this;
    return {
      setTitle(t) { self.title = t; return this; },
      setChecked(c) { self.checked = c; return this; },
      onClick(fn) { self.onClick = fn; return this; },
    };
  }
}

class Modal {
  constructor(app) { this.app = app; this.contentEl = makeEl('div'); this.titleEl = makeEl('div'); }
  open() { if (this.onOpen) this.onOpen(); }
  close() { if (this.onClose) this.onClose(); }
}

/**
 * Obsidian augments HTMLElement with createDiv/createSpan/createEl/empty. The view relies on those,
 * so the stub installs them on the prototype rather than per-element, matching how the real runtime
 * behaves and keeping makeEl itself simple.
 */
function installElementHelpers() {
  const proto = globalThis.HTMLElement?.prototype;
  if (!proto) return;
  if (proto.__qcPatched) return;
  proto.__qcPatched = true;
  const opts = (o) => (typeof o === 'string' ? { cls: o } : (o || {}));
  proto.createEl = function (tag, o) {
    const c = this.ownerDocument.createElement(tag);
    const opt = opts(o);
    if (opt.cls) c.className = opt.cls;
    if (opt.text) c.textContent = opt.text;
    if (opt.type) c.setAttribute('type', opt.type);
    if (opt.href) c.setAttribute('href', opt.href);
    this.appendChild(c);
    return c;
  };
  proto.createDiv = function (o) { return this.createEl('div', o); };
  proto.createSpan = function (o) { return this.createEl('span', o); };
  proto.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
  proto.addClass = function (c) { this.classList.add(c); };
  proto.setText = function (t) { this.textContent = t; };
  proto.detach = function () { this.remove(); };
}

if (typeof globalThis.document !== 'undefined') installElementHelpers();

function makeEl(tag) {
  return document.createElement(tag);
}

/**
 * Mirrors the parts of Obsidian's FileView lifecycle the plugin depends on, including the ordering
 * that caused the save bug: `onOpen` runs while `file` is still null, and the file only arrives via
 * `onLoadFile`. A stub that set the file eagerly would hide exactly the bug it is meant to catch.
 */
class ItemView {
  constructor(leaf, app) {
    this.leaf = leaf;
    // Obsidian hands the app to ItemView, and every view reaches it as `this.app`. Without this the
    // stub fails for a reason that has nothing to do with the code under test.
    this.app = app;
    this.containerEl = makeEl('div');
    this.contentEl = makeEl('div');
  }
  getViewType() { throw new Error('not implemented'); }
  getDisplayText() { return ''; }
  getIcon() { return 'document'; }
  getState() { return {}; }
  onOpen() {}
  onClose() {}
}

class FileView extends ItemView {
  constructor(leaf, app) {
    super(leaf, app);
    this.file = null;
  }

  /** Assigns the file and calls the hook, as Obsidian does. */
  async __setFile(file) {
    this.file = file;
    await this.onLoadFile(file);
  }
  async __clearFile() {
    const f = this.file;
    this.file = null;
    if (f) await this.onUnloadFile(f);
  }
  async onLoadFile() {}
  async onUnloadFile() {}
  canAcceptExtension() { return true; }
}

function setIcon(el) { el.textContent = '*'; }

function normalizePath(p) { return p.replace(/\\/g, '/').replace(/\/+/g, '/'); }

module.exports = {
  parseYaml: (t) => yaml.load(t),
  stringifyYaml: (o) => yaml.dump(o, { lineWidth: -1 }),
  TFile, TFolder, Notice, Menu, Modal, FileView, ItemView, setIcon, normalizePath,
  Platform: { isMobile: false, isDesktop: true },
};
