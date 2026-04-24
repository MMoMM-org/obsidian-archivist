// T4.1 — VaultAdapter: Obsidian Vault API wrapper with typed events.
//
// Goals:
//   - getFiles() returns {path, mtime, size}[] from vault.getFiles()
//   - readBytes(path) returns Uint8Array of file contents
//   - writeAtomic() writes to <path>.archivist-tmp then renames; no temp on success
//   - writeAtomic() failure path: rename throws → original untouched (temp may exist)
//   - stat() / exists() / mkdirParents() contracts
//   - onVaultCreate/Modify/Delete/Rename register via plugin.registerEvent
//   - folder-rename dedup: folder rename + descendant renames → handler called once

import { describe, expect, it, vi } from 'vitest';

import { App, Plugin, TFile, TFolder } from '../fixtures/obsidian-mock';
import { VaultAdapter } from '../../src/infra/VaultAdapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest() {
  return { id: 'archivist', name: 'Archivist', version: '0.1.0' };
}

function makeSetup() {
  const app = new App();
  const plugin = new Plugin(app, makeManifest());
  const adapter = new VaultAdapter(plugin);
  return { app, plugin, adapter };
}

// ---------------------------------------------------------------------------
// getFiles()
// ---------------------------------------------------------------------------

describe('VaultAdapter.getFiles()', () => {
  it('returns the mapped shape for each TFile in the vault', () => {
    const { app, adapter } = makeSetup();

    app.vault._addFile('notes/hello.md', { mtime: 1000, size: 42 });

    const files = adapter.getFiles();

    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({ path: 'notes/hello.md', mtime: 1000, size: 42 });
  });

  it('returns empty array when vault has no files', () => {
    const { adapter } = makeSetup();
    expect(adapter.getFiles()).toEqual([]);
  });

  it('returns all files when multiple are present', () => {
    const { app, adapter } = makeSetup();

    app.vault._addFile('a.md', { mtime: 100, size: 10 });
    app.vault._addFile('b/c.md', { mtime: 200, size: 20 });

    const files = adapter.getFiles();
    expect(files).toHaveLength(2);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('a.md');
    expect(paths).toContain('b/c.md');
  });
});

// ---------------------------------------------------------------------------
// readBytes()
// ---------------------------------------------------------------------------

describe('VaultAdapter.readBytes()', () => {
  it('returns a Uint8Array with the correct contents', async () => {
    const { app, adapter } = makeSetup();
    const content = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
    app.vault._setFileBytes('file.md', content);

    const result = await adapter.readBytes('file.md');

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(content);
  });

  it('rejects with an error when the file does not exist', async () => {
    const { adapter } = makeSetup();
    await expect(adapter.readBytes('missing.md')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// writeAtomic()
// ---------------------------------------------------------------------------

describe('VaultAdapter.writeAtomic()', () => {
  it('success path: renames tmp to final path, no temp left on disk', async () => {
    const { app, adapter } = makeSetup();
    const bytes = new Uint8Array([1, 2, 3]);

    await adapter.writeAtomic('notes/out.md', bytes);

    // Final file present
    expect(app.vault._hasFile('notes/out.md')).toBe(true);
    // No temp file remaining
    expect(app.vault._hasFile('notes/out.md.archivist-tmp')).toBe(false);
    // Contents correct
    expect(app.vault._getFileBytes('notes/out.md')).toEqual(bytes);
  });

  it('failure path: rename throws → original file untouched, temp was written', async () => {
    const { app, adapter } = makeSetup();

    // Pre-existing original file
    const original = new Uint8Array([9, 8, 7]);
    app.vault._setFileBytes('notes/existing.md', original);

    // Make rename fail — writeBinary still runs successfully first.
    app.vault.adapter.rename = vi.fn().mockRejectedValueOnce(new Error('rename failed'));

    await expect(adapter.writeAtomic('notes/existing.md', new Uint8Array([1]))).rejects.toThrow();

    // Original must be untouched — this distinguishes "rename failed after a
    // successful temp write" from "writeBinary itself failed before touching
    // anything". If the implementation ever swapped the write/rename order
    // this test would still pass on the original assertion alone, so we also
    // assert the temp file IS present to pin the write-then-rename sequence.
    expect(app.vault._getFileBytes('notes/existing.md')).toEqual(original);
    expect(app.vault._hasFile('notes/existing.md.archivist-tmp')).toBe(true);
  });

  it('failure path: rename throws → error is propagated to caller', async () => {
    const { app, adapter } = makeSetup();
    app.vault.adapter.rename = vi.fn().mockRejectedValueOnce(new Error('disk full'));

    await expect(adapter.writeAtomic('notes/new.md', new Uint8Array([1]))).rejects.toThrow(
      'disk full',
    );
  });
});

// ---------------------------------------------------------------------------
// stat() / exists() / mkdirParents()
// ---------------------------------------------------------------------------

describe('VaultAdapter.stat()', () => {
  it('returns {mtime, size} for an existing file', async () => {
    const { app, adapter } = makeSetup();
    app.vault.adapter._setStat('notes/hello.md', { mtime: 1234, size: 56, type: 'file' });

    const result = await adapter.stat('notes/hello.md');

    expect(result).toEqual({ mtime: 1234, size: 56 });
  });

  it('returns null when path does not exist', async () => {
    const { adapter } = makeSetup();
    const result = await adapter.stat('missing.md');
    expect(result).toBeNull();
  });
});

describe('VaultAdapter.exists()', () => {
  it('returns true when path exists', async () => {
    const { app, adapter } = makeSetup();
    app.vault.adapter.exists = vi.fn().mockResolvedValueOnce(true);

    expect(await adapter.exists('notes/hello.md')).toBe(true);
  });

  it('returns false when path does not exist', async () => {
    const { app, adapter } = makeSetup();
    app.vault.adapter.exists = vi.fn().mockResolvedValueOnce(false);

    expect(await adapter.exists('missing.md')).toBe(false);
  });
});

describe('VaultAdapter.mkdirParents()', () => {
  it('creates the parent directory of the given path', async () => {
    const { app, adapter } = makeSetup();
    const mkdirSpy = vi.spyOn(app.vault.adapter, 'mkdir');

    await adapter.mkdirParents('notes/sub/file.md');

    expect(mkdirSpy).toHaveBeenCalledWith('notes/sub');
  });

  it('is a no-op for top-level paths (no parent to create)', async () => {
    const { app, adapter } = makeSetup();
    const mkdirSpy = vi.spyOn(app.vault.adapter, 'mkdir');

    await adapter.mkdirParents('file.md');

    // No slash in path → parent is '' or '.'; mkdir should not be called with empty string
    expect(mkdirSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Event registration — goes through plugin.registerEvent
// ---------------------------------------------------------------------------

describe('VaultAdapter event registration', () => {
  it('onVaultCreate registers an event through plugin.registerEvent', () => {
    const { plugin, adapter } = makeSetup();
    const handler = vi.fn();

    adapter.onVaultCreate(handler);

    expect(plugin._registeredEvents).toHaveLength(1);
  });

  it('onVaultModify registers an event through plugin.registerEvent', () => {
    const { plugin, adapter } = makeSetup();

    adapter.onVaultModify(vi.fn());

    expect(plugin._registeredEvents).toHaveLength(1);
  });

  it('onVaultDelete registers an event through plugin.registerEvent', () => {
    const { plugin, adapter } = makeSetup();

    adapter.onVaultDelete(vi.fn());

    expect(plugin._registeredEvents).toHaveLength(1);
  });

  it('onVaultRename registers an event through plugin.registerEvent', () => {
    const { plugin, adapter } = makeSetup();

    adapter.onVaultRename(vi.fn());

    expect(plugin._registeredEvents).toHaveLength(1);
  });

  it('multiple registrations each produce one EventRef', () => {
    const { plugin, adapter } = makeSetup();

    adapter.onVaultCreate(vi.fn());
    adapter.onVaultModify(vi.fn());
    adapter.onVaultDelete(vi.fn());
    adapter.onVaultRename(vi.fn());

    expect(plugin._registeredEvents).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Event firing — onVaultCreate/Modify/Delete deliver file to handler
// ---------------------------------------------------------------------------

describe('VaultAdapter event delivery', () => {
  it('onVaultCreate handler receives the created file', () => {
    const { app, adapter } = makeSetup();
    const handler = vi.fn();
    adapter.onVaultCreate(handler);

    const file = new TFile('notes/new.md');
    app.vault._fire('create', file);

    expect(handler).toHaveBeenCalledWith(file);
  });

  it('onVaultModify handler receives the modified file', () => {
    const { app, adapter } = makeSetup();
    const handler = vi.fn();
    adapter.onVaultModify(handler);

    const file = new TFile('notes/mod.md');
    app.vault._fire('modify', file);

    expect(handler).toHaveBeenCalledWith(file);
  });

  it('onVaultDelete handler receives the deleted file', () => {
    const { app, adapter } = makeSetup();
    const handler = vi.fn();
    adapter.onVaultDelete(handler);

    const file = new TFile('notes/del.md');
    app.vault._fire('delete', file);

    expect(handler).toHaveBeenCalledWith(file);
  });

  it('onVaultRename handler receives (file, oldPath)', () => {
    const { app, adapter } = makeSetup();
    const handler = vi.fn();
    adapter.onVaultRename(handler);

    const file = new TFile('notes/renamed.md');
    app.vault._fire('rename', file, 'notes/original.md');

    expect(handler).toHaveBeenCalledWith(file, 'notes/original.md');
  });
});

// ---------------------------------------------------------------------------
// Folder-rename dedup (ROB-007 / SDD Implementation Gotchas)
// Obsidian fires rename for folder + every descendant. VaultAdapter must
// suppress descendant events fired in the same microtask batch.
// ---------------------------------------------------------------------------

describe('VaultAdapter folder-rename dedup', () => {
  it('folder rename + descendant rename in same tick → handler called once (for folder)', async () => {
    const { app, adapter } = makeSetup();
    const handler = vi.fn();
    adapter.onVaultRename(handler);

    const folder = new TFolder('notes/new-folder');
    const descendant = new TFile('notes/new-folder/child.md');

    // Simulate Obsidian firing both in the same synchronous tick
    app.vault._fire('rename', folder, 'notes/old-folder');
    app.vault._fire('rename', descendant, 'notes/old-folder/child.md');

    // Dedup is microtask-scoped; flush pending microtasks before asserting
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(folder, 'notes/old-folder');
  });

  it('two independent renames in same tick → handler called twice', async () => {
    const { app, adapter } = makeSetup();
    const handler = vi.fn();
    adapter.onVaultRename(handler);

    const fileA = new TFile('a/new-name.md');
    const fileB = new TFile('b/new-name.md');

    app.vault._fire('rename', fileA, 'a/old-name.md');
    app.vault._fire('rename', fileB, 'b/old-name.md');

    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('folder rename with multiple descendants → handler called once', async () => {
    const { app, adapter } = makeSetup();
    const handler = vi.fn();
    adapter.onVaultRename(handler);

    const folder = new TFolder('docs/new');
    const child1 = new TFile('docs/new/a.md');
    const child2 = new TFile('docs/new/b.md');
    const child3 = new TFile('docs/new/sub/c.md');

    app.vault._fire('rename', folder, 'docs/old');
    app.vault._fire('rename', child1, 'docs/old/a.md');
    app.vault._fire('rename', child2, 'docs/old/b.md');
    app.vault._fire('rename', child3, 'docs/old/sub/c.md');

    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(folder, 'docs/old');
  });

  it('after microtask clears, subsequent renames fire normally', async () => {
    const { app, adapter } = makeSetup();
    const handler = vi.fn();
    adapter.onVaultRename(handler);

    // First rename batch
    const folder = new TFolder('notes/new');
    const child = new TFile('notes/new/child.md');
    app.vault._fire('rename', folder, 'notes/old');
    app.vault._fire('rename', child, 'notes/old/child.md');

    // Flush microtasks — dedup set cleared
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);

    // Second rename — unrelated, fires after the dedup window closes
    const file2 = new TFile('other/new.md');
    app.vault._fire('rename', file2, 'other/old.md');

    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('per-registration isolation: handler A folder rename does NOT suppress handler B descendant', async () => {
    // Two callers each register their own rename handler. Handler A sees a
    // folder rename; handler B's unrelated descendant that shares the prefix
    // must still fire. This would regress if folder dedup state were shared
    // across registrations on the same adapter instance.
    const { app, adapter } = makeSetup();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    adapter.onVaultRename(handlerA);
    adapter.onVaultRename(handlerB);

    const folder = new TFolder('notes/new');
    const descendant = new TFile('notes/new/child.md');

    // Same synchronous tick — both handlers see both events.
    app.vault._fire('rename', folder, 'notes/old');
    app.vault._fire('rename', descendant, 'notes/old/child.md');

    await Promise.resolve();

    // Each handler sees the folder once (its own dedup suppresses its own
    // descendant). B's dedup is independent of A's — neither handler saw the
    // descendant fire twice, and neither was silently starved.
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerA).toHaveBeenCalledWith(folder, 'notes/old');
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledWith(folder, 'notes/old');
  });

  it('descendant event arriving BEFORE folder event falls through as a normal rename', async () => {
    // Documents the ordering assumption: folder-first dedup only activates if
    // Obsidian fires the folder rename before its descendants. If that
    // ordering is ever violated, consumers see a duplicate rather than a
    // silent drop — the safe failure mode.
    const { app, adapter } = makeSetup();
    const handler = vi.fn();
    adapter.onVaultRename(handler);

    const folder = new TFolder('notes/new');
    const descendant = new TFile('notes/new/child.md');

    app.vault._fire('rename', descendant, 'notes/old/child.md'); // out of order
    app.vault._fire('rename', folder, 'notes/old');

    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(2);
  });
});
