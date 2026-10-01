/**
 * Append-only diagnostics for the save path.
 *
 * This exists because saving failed several times in ways that were completely invisible from inside
 * the app: no error, no notice, no file change. Three separate causes looked identical from the
 * outside — a silent early return, a discarded callback value, and a null file reference — so the
 * only way to tell them apart was to make the app write down what it actually did.
 *
 * Two rules, both learned the hard way:
 *
 *  1. It must never fail silently. An earlier version checked a global for the adapter and returned
 *     quietly when it was missing, which produced "no log at all" — indistinguishable from "the code
 *     never ran". The app is passed in explicitly instead of being stashed somewhere.
 *  2. It must never be able to break the thing it is diagnosing. Every failure is swallowed, and the
 *     fallback is console output, which the developer console always shows.
 */

import { App, normalizePath } from 'obsidian';

const MAX_LINES = 300;

/** Resolve the log path from the app each call, so it cannot be stale or missing. */
function logPath(app: App): string {
  return normalizePath(`${app.vault.configDir}/plugins/quadrant-chart/save-debug.log`);
}

/**
 * Write one line. Never rejects.
 *
 * Uses the vault's DataAdapter rather than the Vault API: this must work before, during and after a
 * file operation, including for the failure cases where the vault itself is the thing complaining.
 */
export async function diag(app: App | null | undefined, line: string): Promise<void> {
  const text = `${new Date().toISOString()} ${line}`;
  // Always to the console first: it is the channel that cannot be broken by a bad path or a missing
  // adapter, and it is what a developer console will show even if the file write below fails.
  console.error(`[quadrant-chart] ${line}`);
  if (!app) return;
  try {
    const adapter = (app.vault as unknown as { adapter?: { exists(p: string): Promise<boolean>; read(p: string): Promise<string>; write(p: string, d: string): Promise<void>; append?(p: string, d: string): Promise<void> } }).adapter;
    if (!adapter) {
      console.error('[quadrant-chart] diag: no adapter available');
      return;
    }
    const path = logPath(app);
    let existing = '';
    if (await adapter.exists(path)) {
      try { existing = await adapter.read(path); } catch { existing = ''; }
    }
    const lines = existing.split('\n').filter((l) => l.trim() !== '');
    lines.push(text);
    await adapter.write(path, lines.slice(-MAX_LINES).join('\n') + '\n');
  } catch (err) {
    console.error(`[quadrant-chart] diag write failed: ${(err as Error).message}`);
  }
}
