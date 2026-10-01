/**
 * Plugin entry: registers the `.mdx` extension, the view, the commands, and the settings.
 *
 * The extension is registered as `mdx` deliberately, which is also React's component-file suffix.
 * That overlap is intentional here — the user asked for this format name — and it is harmless in
 * Obsidian, which has no MDX pipeline of its own. The one consequence worth knowing: if a vault
 * ever gains a real MDX toolchain, the two would compete for the same suffix.
 */

import { App, DataAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { Chart, DEFAULTS, LIMITS, createChart, clampInt } from './model';
import { chartToFileText, defaultBody } from './mdx';
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

    // Expose the adapter and plugin dir for the save-path diagnostics in mdx.ts, set before anything
    // else so even a startup failure is recorded.
    (globalThis as Record<string, unknown>)['__qcAdapter'] = (this.app.vault as unknown as { adapter?: DataAdapter }).adapter;
    (globalThis as Record<string, unknown>)['__qcPluginDir'] = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;

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
      id: 'create-quadrant-chart',
      name: 'Create quadrant chart',
      callback: () => void this.createChartCommand(),
    });

    this.addCommand({
      id: 'open-quadrant-chart',
      name: 'Open quadrant chart',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'mdx') return false;
        if (!checking) void this.openChart(file);
        return true;
      },
    });

    this.addSettingTab(new QuadrantChartSettingTab(this.app, this));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_QUADRANT);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

/** Strip characters Obsidian forbids in filenames, and guarantee a non-empty result. */
function sanitize(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Untitled chart';
}
