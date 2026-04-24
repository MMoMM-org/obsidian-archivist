// VaultAdapter — the single point of contact with Obsidian's Vault API.
//
// All other services (ChangeDetector, PluginStore, RestoreService) go through
// this wrapper.  It never leaks Obsidian-internal types beyond this file.
//
// Design notes:
//   - Every event registration calls plugin.registerEvent() so Obsidian's Plugin
//     base tears them down automatically on disable.
//   - writeAtomic() writes to <path>.archivist-tmp then renames.  On success no
//     temp is left.  If rename throws, the original file is untouched and the
//     error propagates to the caller (temp may exist — tolerable).
//   - Folder-rename dedup (ROB-007 / SDD Implementation Gotchas): Obsidian fires
//     one rename event for the folder AND one for every descendant.  Each
//     onVaultRename registration owns its OWN microtask-scoped folder Set — no
//     cross-registration suppression is possible.  Relies on Obsidian firing
//     the folder event before its descendants (observed behavior; any descendant
//     arriving first falls through as a normal rename, which is the safe default
//     — consumers may observe a duplicate but never a silent drop).

import { TFolder } from 'obsidian';
import type { Plugin, TAbstractFile } from 'obsidian';

// ---------------------------------------------------------------------------
// Public surface types
// ---------------------------------------------------------------------------

export interface FileEntry {
  path: string;
  mtime: number;
  size: number;
}

// ---------------------------------------------------------------------------
// VaultAdapter
// ---------------------------------------------------------------------------

export class VaultAdapter {
  private readonly plugin: Plugin;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  // ---- File queries --------------------------------------------------------

  getFiles(): FileEntry[] {
    return this.plugin.app.vault.getFiles().map((f) => ({
      path: f.path,
      mtime: f.stat.mtime,
      size: f.stat.size,
    }));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const buf = await this.plugin.app.vault.adapter.readBinary(path);
    return new Uint8Array(buf);
  }

  async stat(path: string): Promise<{ mtime: number; size: number } | null> {
    const result = await this.plugin.app.vault.adapter.stat(path);
    if (result === null) return null;
    return { mtime: result.mtime, size: result.size };
  }

  async exists(path: string): Promise<boolean> {
    return this.plugin.app.vault.adapter.exists(path);
  }

  /**
   * Creates the parent directory of `path` (not `path` itself).
   * Idempotent — a pre-existing directory does not cause an error.
   */
  async mkdirParents(path: string): Promise<void> {
    const slash = path.lastIndexOf('/');
    if (slash <= 0) return;
    const parent = path.slice(0, slash);
    await this.plugin.app.vault.adapter.mkdir(parent);
  }

  // ---- Atomic write --------------------------------------------------------

  /**
   * Write `bytes` to `path` atomically: write to a temp file first, then
   * rename.  On rename failure the original file (if any) is untouched.
   */
  async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    const tmp = `${path}.archivist-tmp`;
    await this.plugin.app.vault.adapter.writeBinary(tmp, bytes.buffer as ArrayBuffer);
    await this.plugin.app.vault.adapter.rename(tmp, path);
  }

  // ---- Typed event methods (ROB-007) ---------------------------------------

  onVaultCreate(handler: (file: TAbstractFile) => void): void {
    const ref = this.plugin.app.vault.on('create', handler as (...args: unknown[]) => void);
    this.plugin.registerEvent(ref);
  }

  onVaultModify(handler: (file: TAbstractFile) => void): void {
    const ref = this.plugin.app.vault.on('modify', handler as (...args: unknown[]) => void);
    this.plugin.registerEvent(ref);
  }

  onVaultDelete(handler: (file: TAbstractFile) => void): void {
    const ref = this.plugin.app.vault.on('delete', handler as (...args: unknown[]) => void);
    this.plugin.registerEvent(ref);
  }

  onVaultRename(handler: (file: TAbstractFile, oldPath: string) => void): void {
    // Per-registration Set — isolates folder-rename dedup state so concurrent
    // consumers (e.g. ChangeDetector and RestoreService) can't suppress each
    // other's descendants through shared adapter instance state.
    const recentlyRenamedFolders = new Set<string>();
    const ref = this.plugin.app.vault.on('rename', (rawFile: unknown, rawOldPath: unknown) => {
      const file = rawFile as TAbstractFile;
      const oldPath = rawOldPath as string;

      for (const folder of recentlyRenamedFolders) {
        if (oldPath.startsWith(`${folder}/`)) return;
      }

      if (file instanceof TFolder) {
        if (recentlyRenamedFolders.size === 0) {
          queueMicrotask(() => recentlyRenamedFolders.clear());
        }
        recentlyRenamedFolders.add(oldPath);
      }

      handler(file, oldPath);
    });
    this.plugin.registerEvent(ref);
  }
}
