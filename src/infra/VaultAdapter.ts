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

import { TFile, TFolder } from 'obsidian';
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
   * Write `bytes` to `path`. Two code paths depending on whether the path
   * is already a tracked vault file:
   *
   *   1. Existing TFile (typical restore-in-place case): use
   *      `vault.modifyBinary(tfile, ab)`. This goes through Obsidian's
   *      high-level Vault API, which (a) atomically rewrites the file
   *      contents, (b) invalidates the metadata cache, and (c) refreshes
   *      open editor views. Bypassing this in favour of low-level
   *      adapter.write+rename is what made the previous restore-in-place
   *      "succeed" without actually updating the file on disk — the rename
   *      either no-op'd against Obsidian's vault tracker or the editor
   *      simply kept showing cached content with no disk update visible.
   *
   *   2. Path not (yet) a TFile (first-time restore-as-copy to a fresh
   *      target): tmp + rename for atomicity. We still pre-remove any
   *      adapter-level file at the destination — copy paths are unique by
   *      construction so this is defensive.
   *
   * `bytes.buffer` is sliced to the active byte range so callers passing a
   * subarray view (e.g. a chunked download) don't accidentally write the
   * whole backing ArrayBuffer.
   */
  async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    // Slice into a fresh, plain ArrayBuffer. Two reasons:
    //   1. bytes.buffer is `ArrayBuffer | SharedArrayBuffer`; the Obsidian
    //      writeBinary / modifyBinary signatures want plain ArrayBuffer.
    //   2. If `bytes` is a subarray view (offset > 0 OR length < buffer
    //      length), passing bytes.buffer would write the WHOLE backing
    //      buffer, not just the active range.
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.plugin.app.vault.modifyBinary(file, ab);
      return;
    }
    const tmp = `${path}.archivist-tmp`;
    const adapter = this.plugin.app.vault.adapter;
    try {
      await adapter.writeBinary(tmp, ab);
      if (await adapter.exists(path)) {
        await adapter.remove(path);
      }
      await adapter.rename(tmp, path);
    } catch (err) {
      try {
        await adapter.remove(tmp);
      } catch {
        // Tmp may never have been written, or remove may fail if the adapter
        // raced with a concurrent rename. Swallow — the outer throw carries
        // the real reason and the tmp is stale regardless.
      }
      throw err;
    }
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
