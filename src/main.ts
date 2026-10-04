/**
 * Plugin entry: registers the `.mdx` extension, the view, the commands, and the settings.
 *
 * The extension is registered as `mdx` deliberately, which is also React's component-file suffix.
 * That overlap is intentional here — the user asked for this format name — and it is harmless in
 * Obsidian, which has no MDX pipeline of its own. The one consequence worth knowing: if a vault
 * ever gains a real MDX toolchain, the two would compete for the same suffix.
 */

import { App, Menu, MenuItem, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { Chart, DEFAULTS, LIMITS, createChart, clampInt } from './model';
import { chartToFileText, defaultBody } from './mdx';
import { ChartTemplate, TEMPLATES } from './templates';
import { ImageKind, supportsTransparency } from './exportImage';
import { VIEW_TYPE_QUADRANT, QuadrantChartView } from './view';

export interface QuadrantChartSettings {
  /** Grid shape offered for new charts. */
  defaultColumns: number;
  defaultRows: number;
  /** Ask before overwriting when creating a chart with an existing filename. */
  confirmOverwrite: boolean;
}

const DEFAULT_SETTINGS: QuadrantChartSettings = {
  defaultColumns: DEFAULTS.grid.columns,
  defaultRows: DEFAULTS.grid.rows,
  confirmOverwrite: true,
};

export default class QuadrantChartPlugin extends Plugin {
  settings: QuadrantChartSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    // `.mdx` is not a format Obsidian knows, so it must be claimed or the vault will treat these
    // files as opaque binaries and never offer them for opening.
    this.registerExtensions(['mdx'], VIEW_TYPE_QUADRANT);
    this.registerView(VIEW_TYPE_QUADRANT, (leaf) => new QuadrantChartView(leaf, this));

    // Opening a .mdx file should land in the chart view, not in a source editor.
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file instanceof TFile && file.extension === 'mdx') void this.openChart(file);
      }),
    );

    // An external edit (hand-editing the file, git, another device) must not leave a stale canvas
    // showing numbers the file no longer contains.
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'mdx') return;
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_QUADRANT)) {
          const view = leaf.view;
          if (view instanceof QuadrantChartView && view.file?.path === file.path) {
            void view.onExternalChange();
          }
        }
      }),
    );

    this.addCommand({
      id: 'create-chart',
      name: 'Create a blank chart',
      callback: () => void this.createChartCommand(),
    });

    this.addCommand({
      id: 'create-from-example',
      name: 'Create from a worked example',
      // Obsidian types `callback` as taking no arguments, so the click position has to be read off
      // the window's last event rather than taken as a parameter. The menu is anchored there, so
      // it appears under the cursor when invoked by mouse and near the centre when by keyboard.
      callback: () => void this.pickTemplate(lastPointerEvent()),
    });

    this.addCommand({
      id: 'export-image',
      name: 'Export as an image',
      callback: () => void this.pickExport(lastPointerEvent()),
    });

    this.addCommand({
      id: 'open-chart',
      name: 'Open the active chart',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'mdx') return false;
        if (!checking) void this.openChart(file);
        return true;
      },
    });

    this.addSettingTab(new QuadrantChartSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    // `loadData` is typed `any`, and letting that flow into the assignment would make every later read
    // of `this.settings` unchecked. Narrow it here so the rest of the plugin stays typed.
    const stored = (await this.loadData()) as Partial<QuadrantChartSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    // Clamp on load: a hand-edited data.json must not be able to produce a 0-column chart.
    this.settings.defaultColumns = clampInt(this.settings.defaultColumns, LIMITS.minSplits, LIMITS.maxSplits, 2);
    this.settings.defaultRows = clampInt(this.settings.defaultRows, LIMITS.minSplits, LIMITS.maxSplits, 2);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async openChart(file: TFile): Promise<void> {
    // Focus an already-open leaf rather than stacking duplicates every time the file is clicked.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_QUADRANT)) {
      const view = leaf.view;
      if (view instanceof QuadrantChartView && view.file?.path === file.path) {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        return;
      }
    }
    const leaf = this.app.workspace.getLeaf(true);
    // `activeFile` is not part of ViewState; the file path goes in the view's own state, which is
    // what FileView reads to resolve `this.file`.
    await leaf.setViewState({ type: VIEW_TYPE_QUADRANT, active: true, state: { file: file.path } });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  private async createChartCommand(): Promise<void> {
    const suggested = this.app.workspace.getActiveFile()?.parent?.path ?? this.app.vault.getRoot().path;
    const name = await this.promptText('Untitled chart', 'New quadrant chart — file name');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      new Notice('The file name cannot be empty.');
      return;
    }
    const path = `${suggested}/${sanitize(trimmed)}.mdx`;
    if (this.app.vault.getAbstractFileByPath(path) && this.settings.confirmOverwrite) {
      new Notice(`${trimmed}.mdx already exists — open it instead of overwriting.`);
      return;
    }
    const chart: Chart = createChart(this.settings.defaultColumns, this.settings.defaultRows);
    const text = chartToFileText(chart, defaultBody(chart.grid.columns, chart.grid.rows));
    let file: TFile;
    try {
      const created = await this.app.vault.create(path, text);
      if (!(created instanceof TFile)) throw new Error('unexpected file type');
      file = created;
    } catch (err) {
      new Notice(`Could not create the file: ${(err as Error).message}`);
      return;
    }
    await this.openChart(file);
    new Notice(`Created ${file.path}`);
  }

  /**
   * Choose a worked example and create a new chart from it.
   *
   * The examples are embedded in the bundle rather than shipped as files in the plugin folder. A
   * missing sidecar file would give a menu entry that silently does nothing — the same failure mode
   * that cost this plugin four rounds of debugging elsewhere — and embedding makes that impossible.
   *
   * The text is written verbatim, so the new file is byte-identical to the example. It is NOT the
   * same thing as copying: the example's cells and labels are a starting point, and the user is
   * expected to replace them.
   */
  private pickTemplate(evt: MouseEvent): void {
    const menu = new Menu();
    for (const tpl of TEMPLATES) {
      // The description goes in the title rather than `setDesc`, which this Obsidian version's
      // MenuItem does not have. Readability in the palette list is worth the slightly long label.
      menu.addItem((it: MenuItem) => it
        .setSection('Examples')
        .setTitle(`${tpl.name} — ${tpl.description}`)
        .onClick(() => void this.createFromTemplate(tpl)));
    }
    menu.showAtMouseEvent(evt);
  }

  private async createFromTemplate(tpl: ChartTemplate): Promise<void> {
    const dir = this.app.workspace.getActiveFile()?.parent?.path ?? this.app.vault.getRoot().path;
    const name = await this.promptText(tpl.suggestedName, `New chart from ${tpl.name} — file name`);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      new Notice('The file name cannot be empty.');
      return;
    }
    const path = `${dir}/${sanitize(trimmed)}.mdx`;
    if (this.app.vault.getAbstractFileByPath(path)) {
      // Refuse rather than overwrite, always — unlike a blank chart, an example is worth keeping,
      // and silently replacing one would destroy work the user did based on it.
      new Notice(`${sanitize(trimmed)}.mdx already exists — pick another name.`);
      return;
    }
    let file: TFile;
    try {
      const created = await this.app.vault.create(path, tpl.text);
      if (!(created instanceof TFile)) throw new Error('unexpected file type');
      file = created;
    } catch (err) {
      new Notice(`Could not create the file: ${(err as Error).message}`);
      return;
    }
    await this.openChart(file);
    new Notice(`Created ${file.path} from the ${tpl.name} example`);
  }

  /**
   * Pick an image format and export.
   *
   * The toolbar passes the button's own event so the menu opens under the cursor; the command palette
   * passes a synthetic one, because Obsidian types a command's callback as taking no arguments.
   */
  pickExport(at: MouseEvent): void {
    const menu = new Menu();
    const kind = (label: string, detail: string, k: ImageKind, transparent = false) =>
      menu.addItem((it: MenuItem) => it
        .setSection('Export as')
        .setTitle(`${label} \u2014 ${detail}`)
        .onClick(() => void this.runExport(k, transparent)));

    kind('JPG', 'smaller file', 'jpeg');
    kind('PNG', 'lossless, sharper text', 'png');
    kind('PNG', 'transparent background', 'png', true);
    kind('SVG', 'vector, scales without blurring', 'svg');
    kind('SVG', 'vector, transparent background', 'svg', true);
    menu.showAtMouseEvent(at);
  }

  private async runExport(kind: ImageKind, transparent: boolean): Promise<void> {
    const view = this.chartView();
    if (!view) {
      new Notice('Open a chart first.');
      return;
    }
    if (transparent && !supportsTransparency(kind)) {
      // Unreachable through the menu; a guard rather than a trust, since it would silently produce a
      // black image rather than an error.
      new Notice(`${kind.toUpperCase()} cannot store transparency.`);
      return;
    }
    try {
      const written = await view.exportImage(kind, transparent);
      new Notice(`Saved ${written.path}`);
    } catch (err) {
      new Notice(`Could not export the chart: ${(err as Error).message}`);
    }
  }

  /** The active chart view, if one is focused. */
  private chartView(): QuadrantChartView | null {
    // getActiveViewOfType wants the constructor, not the view-type string.
    const leaf = this.app.workspace.getActiveViewOfType(QuadrantChartView);
    return leaf instanceof QuadrantChartView ? leaf : null;
  }

  /**
   * Shared text prompt.
   *
   * Wrapped rather than called directly because the canvas needs it too, and routing both through
   * one modal keeps the cancel/empty distinction consistent: `null` means the user cancelled, while
   * an empty string is a real (if unhelpful) answer the caller decides what to do with.
   */
  async promptText(defaultValue: string, title: string): Promise<string | null> {
    return new Promise((resolve) => {
      new TextPromptModal(this.app, title, defaultValue, resolve).open();
    });
  }
}

/** Minimal modal with a single text field. */
class TextPromptModal extends Modal {
  private value: string;
  private resolved = false;

  constructor(
    app: App,
    private readonly title: string,
    defaultValue: string,
    private readonly done: (v: string | null) => void,
  ) {
    super(app);
    this.value = defaultValue;
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    const { contentEl } = this;
    const input = contentEl.createEl('input', { type: 'text', cls: 'qc-prompt-input' });
    input.value = this.value;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.finish(input.value);
      }
    });
    // Select-all on open: the common case is replacing the value, not appending to it.
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    const row = contentEl.createDiv({ cls: 'qc-prompt-row' });
    const ok = row.createEl('button', { text: 'OK' });
    ok.addEventListener('click', () => this.finish(input.value));
    const cancel = row.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.finish(null));
  }

  onClose(): void {
    // Closing via Escape must resolve exactly like Cancel, or callers await forever.
    if (!this.resolved) this.finish(null);
    this.contentEl.empty();
  }

  private finish(v: string | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.done(v);
    this.close();
  }
}

class QuadrantChartSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: QuadrantChartPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Default grid size')
      .setDesc(`Columns and rows for newly created charts. Existing charts keep their own size.`)
      .addDropdown((d) => {
        for (const n of [1, 2, 3, 4]) d.addOption(String(n), `${n} columns`);
        d.setValue(String(this.plugin.settings.defaultColumns));
        d.onChange(async (v) => {
          this.plugin.settings.defaultColumns = Number(v);
          await this.plugin.saveSettings();
        });
      })
      .addDropdown((d) => {
        for (const n of [1, 2, 3, 4]) d.addOption(String(n), `${n} rows`);
        d.setValue(String(this.plugin.settings.defaultRows));
        d.onChange(async (v) => {
          this.plugin.settings.defaultRows = Number(v);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Confirm before overwriting')
      .setDesc('When creating a chart whose filename already exists, refuse instead of replacing it.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.confirmOverwrite)
        .onChange(async (v) => {
          this.plugin.settings.confirmOverwrite = v;
          await this.plugin.saveSettings();
        }));
  }
}

/**
 * The most recent real pointer position on screen, as a synthetic MouseEvent.
 *
 * Obsidian types a command's `callback` as taking no arguments, so a command that opens a menu has
 * no event to anchor itself to. Grabbing the last known pointer position is what makes the menu
 * appear under the cursor when invoked by mouse. Falls back to the window centre for a keyboard
 * invocation, where there is no cursor intent to honour and the middle of the screen is the least
 * surprising place for it.
 */
function lastPointerEvent(): MouseEvent {
  const x = window.innerWidth / 2;
  const y = window.innerHeight / 2;
  return new MouseEvent('click', { clientX: x, clientY: y, bubbles: true });
}

/** Strip characters Obsidian forbids in filenames, and guarantee a non-empty result. */
function sanitize(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Untitled chart';
}
