// T4.4 — ChangeDetector: vault events + reconcile scan.
//
// Test coverage:
//   - Events before/after onLayoutReady
//   - Exclusion filtering in event handlers
//   - reconcileScan warm path (index matches — zero changes)
//   - reconcileScan: unchanged content with new mtime is NOT added (hash wins)
//   - reconcileScan: new files (not in index) are added
//   - reconcileScan: deleted files (in index, not in vault) are added
//   - reconcileScan: exclusion globs respected
//   - reconcileScan: yields every 500 files for 10k-file vault (≥ 20 yields)
//   - reconcileScan: large-file yield rule — ≥ 1 yield for a file ≥ 10 MB
//   - getChangedPaths: combines queue entries + reconcile result

import { describe, expect, it, vi } from 'vitest';
import { App, Plugin, Workspace } from '../fixtures/obsidian-mock';
import { VaultAdapter } from '../../src/infra/VaultAdapter';
import { PluginStore } from '../../src/infra/PluginStore';
import { EventQueue } from '../../src/infra/EventQueue';
import { ChangeDetector } from '../../src/services/ChangeDetector';
import type { LocalIndex } from '../../src/model/Index';
import type { Logger } from '../../src/infra/Logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest() {
  return { id: 'archivist', name: 'Archivist', version: '0.1.0' };
}

type FakeAdapter = {
  files: Map<string, string>;
  read: (p: string) => Promise<string>;
  write: (p: string, data: string) => Promise<void>;
  exists: (p: string) => Promise<boolean>;
  remove: (p: string) => Promise<void>;
};

function makeFakeAdapter(): FakeAdapter {
  const files = new Map<string, string>();
  return {
    files,
    read: async (p) => files.get(p) ?? '',
    write: async (p, data) => { files.set(p, data); },
    exists: async (p) => files.has(p),
    remove: async (p) => { files.delete(p); },
  };
}

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Drain the microtask queue so fire-and-forget enqueue promises resolve. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/**
 * Build a detector-ready test environment.
 * Returns plugin, vaultMock, vaultAdapter, queue, and helpers.
 */
async function makeSetup(opts?: {
  hashFn?: (bytes: Uint8Array | ArrayBuffer) => Promise<string>;
}) {
  const app = new App();
  const plugin = new Plugin(app, makeManifest());

  // Wire a fake PluginStore so EventQueue can persist
  const fakeStorageAdapter = makeFakeAdapter();
  const pluginForStore = {
    manifest: { id: 'archivist', dir: '.obsidian/plugins/archivist' },
    app: { vault: { adapter: fakeStorageAdapter, configDir: '.obsidian' } },
    _data: null as unknown,
    async loadData() { return this._data; },
    async saveData(d: unknown) { this._data = d; },
  };
  const store = new PluginStore(pluginForStore as never, makeLogger());
  const queue = new EventQueue(store);
  await queue.init();

  const vaultAdapter = new VaultAdapter(plugin);

  const yieldState = { count: 0 };
  const yieldFn = async () => { yieldState.count++; };

  const detector = new ChangeDetector({
    vault: vaultAdapter,
    queue,
    plugin,
    logger: makeLogger(),
    hash: opts?.hashFn,
    yieldFn,
  });

  return { app, plugin, vaultAdapter, queue, detector, yieldState };
}

function makeIndex(files: Record<string, { hash: string; mtime: number; size: number }>): LocalIndex {
  return {
    schema_version: '1.0',
    last_full_snapshot_id: null,
    last_inc_snapshot_id: null,
    last_full_commit_at: null,
    last_inc_commit_at: null,
    last_retention_at: null,
    index_missing_recovery_required: false,
    files,
  };
}

// ---------------------------------------------------------------------------
// Event handling — before/after onLayoutReady
// ---------------------------------------------------------------------------

describe('event handling — before/after onLayoutReady', () => {
  it('ignores create event fired before onLayoutReady', async () => {
    const { app, plugin, queue, detector } = await makeSetup();
    detector.registerEventHandlers();

    // Fire event BEFORE layout ready
    const file = app.vault._addFile('notes/a.md', { mtime: 100, size: 10 });
    app.vault._fire('create', file);

    expect(queue.peekSince(null)).toHaveLength(0);
    // Avoid unused-var warning in this pattern
    void plugin;
  });

  it('enqueues create event fired after onLayoutReady', async () => {
    const { app, plugin, queue, detector } = await makeSetup();
    detector.registerEventHandlers();

    // Fire layout ready
    (plugin.app.workspace as unknown as Workspace & { _fireLayoutReady(): void })._fireLayoutReady();

    const file = app.vault._addFile('notes/a.md', { mtime: 100, size: 10 });
    app.vault._fire('create', file);
    await flushMicrotasks();

    const entries = queue.peekSince(null);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('create');
    expect(entries[0].path).toBe('notes/a.md');
    expect(entries[0].prev_path).toBeNull();
  });

  it('enqueues modify event after onLayoutReady', async () => {
    const { app, plugin, queue, detector } = await makeSetup();
    detector.registerEventHandlers();
    (plugin.app.workspace as unknown as Workspace & { _fireLayoutReady(): void })._fireLayoutReady();

    const file = app.vault._addFile('notes/b.md', { mtime: 200, size: 20 });
    app.vault._fire('modify', file);
    await flushMicrotasks();

    const entries = queue.peekSince(null);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('modify');
  });

  it('enqueues delete event after onLayoutReady', async () => {
    const { app, plugin, queue, detector } = await makeSetup();
    detector.registerEventHandlers();
    (plugin.app.workspace as unknown as Workspace & { _fireLayoutReady(): void })._fireLayoutReady();

    const file = app.vault._addFile('notes/c.md', { mtime: 300, size: 30 });
    app.vault._fire('delete', file);
    await flushMicrotasks();

    const entries = queue.peekSince(null);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('delete');
  });

  it('enqueues rename event with prev_path after onLayoutReady', async () => {
    const { app, plugin, queue, detector } = await makeSetup();
    detector.registerEventHandlers();
    (plugin.app.workspace as unknown as Workspace & { _fireLayoutReady(): void })._fireLayoutReady();

    const file = app.vault._addFile('notes/new.md', { mtime: 400, size: 40 });
    app.vault._fire('rename', file, 'notes/old.md');
    await flushMicrotasks();

    const entries = queue.peekSince(null);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('rename');
    expect(entries[0].path).toBe('notes/new.md');
    expect(entries[0].prev_path).toBe('notes/old.md');
  });

  it('ignores all four event types before onLayoutReady', async () => {
    const { app, queue, detector } = await makeSetup();
    detector.registerEventHandlers();

    const file = app.vault._addFile('notes/x.md', { mtime: 100, size: 10 });
    app.vault._fire('create', file);
    app.vault._fire('modify', file);
    app.vault._fire('delete', file);
    app.vault._fire('rename', file, 'notes/old.md');

    expect(queue.peekSince(null)).toHaveLength(0);
  });

  it('layoutReady transition: events before are dropped, events after enqueue (same instance)', async () => {
    // Proves the state-machine transition — a regression that returns false
    // unconditionally would make BOTH the before AND after cases look correct
    // only when tested in isolation. This single-instance test rules that out.
    const { app, plugin, queue, detector } = await makeSetup();
    detector.registerEventHandlers();

    const before = app.vault._addFile('notes/before.md', { mtime: 100, size: 10 });
    app.vault._fire('create', before); // should be dropped
    await flushMicrotasks();
    expect(queue.peekSince(null)).toHaveLength(0);

    (plugin.app.workspace as unknown as Workspace & { _fireLayoutReady(): void })._fireLayoutReady();

    const after = app.vault._addFile('notes/after.md', { mtime: 200, size: 20 });
    app.vault._fire('create', after); // should enqueue
    await flushMicrotasks();

    const entries = queue.peekSince(null);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('notes/after.md');
  });
});

// ---------------------------------------------------------------------------
// Event handling — onVaultActivity hook (FSM quiet-timer reset)
// ---------------------------------------------------------------------------

describe('event handling — onVaultActivity callback', () => {
  it('fires after a successful enqueue', async () => {
    const { app, plugin, queue, detector } = await makeSetup();
    const onActivity = vi.fn();
    detector.setOnVaultActivity(onActivity);
    detector.registerEventHandlers();
    (plugin.app.workspace as unknown as Workspace & { _fireLayoutReady(): void })._fireLayoutReady();

    const file = app.vault._addFile('notes/a.md', { mtime: 100, size: 10 });
    app.vault._fire('create', file);
    // Drain the persistence chain — same approach as other dispatch tests but
    // budget for the full enqueue → saveQueue round trip.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(queue.peekSince(null)).toHaveLength(1);
    expect(onActivity).toHaveBeenCalledTimes(1);
  });

  it('does not fire for events dropped before onLayoutReady', async () => {
    const { app, detector } = await makeSetup();
    const onActivity = vi.fn();
    detector.setOnVaultActivity(onActivity);
    detector.registerEventHandlers();

    const file = app.vault._addFile('notes/early.md', { mtime: 1, size: 1 });
    app.vault._fire('create', file);
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(onActivity).not.toHaveBeenCalled();
  });

  it('does not fire for excluded paths', async () => {
    const { app, plugin, detector } = await makeSetup();
    const onActivity = vi.fn();
    detector.setOnVaultActivity(onActivity);
    detector.registerEventHandlers(['**/.obsidian/**']);
    (plugin.app.workspace as unknown as Workspace & { _fireLayoutReady(): void })._fireLayoutReady();

    const file = app.vault._addFile('.obsidian/cache.json', { mtime: 1, size: 1 });
    app.vault._fire('modify', file);
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(onActivity).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Event handling — exclusions drop events
// ---------------------------------------------------------------------------

describe('event handling — exclusions drop events', () => {
  it('does not enqueue an event for an excluded path', async () => {
    const { app, plugin, queue, detector } = await makeSetup();
    detector.registerEventHandlers(['**/.obsidian/**']);
    (plugin.app.workspace as unknown as Workspace & { _fireLayoutReady(): void })._fireLayoutReady();

    const file = app.vault._addFile('.obsidian/workspace.json', { mtime: 100, size: 10 });
    app.vault._fire('create', file);
    await flushMicrotasks();

    expect(queue.peekSince(null)).toHaveLength(0);
  });

  it('enqueues events for non-excluded paths when exclusions are set', async () => {
    const { app, plugin, queue, detector } = await makeSetup();
    detector.registerEventHandlers(['**/.obsidian/**']);
    (plugin.app.workspace as unknown as Workspace & { _fireLayoutReady(): void })._fireLayoutReady();

    const obsFile = app.vault._addFile('.obsidian/workspace.json', { mtime: 100, size: 10 });
    const noteFile = app.vault._addFile('notes/a.md', { mtime: 200, size: 20 });
    app.vault._fire('create', obsFile);
    app.vault._fire('create', noteFile);
    await flushMicrotasks();

    const entries = queue.peekSince(null);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('notes/a.md');
  });
});

// ---------------------------------------------------------------------------
// reconcileScan — warm path
// ---------------------------------------------------------------------------

describe('reconcileScan — warm path (no changes)', () => {
  it('returns empty set when vault matches index exactly', async () => {
    const { app, detector } = await makeSetup({
      hashFn: async () => 'abc123',
    });

    app.vault._addFile('a.md', { mtime: 100, size: 10 });
    app.vault._addFile('b.md', { mtime: 200, size: 20 });

    const index = makeIndex({
      'a.md': { hash: 'abc123', mtime: 100, size: 10 },
      'b.md': { hash: 'abc123', mtime: 200, size: 20 },
    });

    const changed = await detector.reconcileScan(index, []);
    expect(changed.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reconcileScan — unchanged content with new mtime is NOT added
// ---------------------------------------------------------------------------

describe('reconcileScan — unchanged content with new mtime is NOT added', () => {
  it('skips a file whose hash matches even if mtime changed', async () => {
    const { app, detector } = await makeSetup({
      hashFn: async () => 'same-hash',
    });

    app.vault._addFile('notes/a.md', { mtime: 9999, size: 10 });

    const index = makeIndex({
      'notes/a.md': { hash: 'same-hash', mtime: 1000, size: 10 },
    });

    const changed = await detector.reconcileScan(index, []);
    expect(changed.has('notes/a.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconcileScan — new files
// ---------------------------------------------------------------------------

describe('reconcileScan — new files are added', () => {
  it('adds a file that is in vault but not in index', async () => {
    const { app, detector } = await makeSetup({
      hashFn: async () => 'any-hash',
    });

    app.vault._addFile('new.md', { mtime: 500, size: 50 });

    const index = makeIndex({});

    const changed = await detector.reconcileScan(index, []);
    expect(changed.has('new.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reconcileScan — deleted files
// ---------------------------------------------------------------------------

describe('reconcileScan — deleted files are added', () => {
  it('adds a file that is in index but not in vault', async () => {
    const { detector } = await makeSetup({
      hashFn: async () => 'any-hash',
    });

    // Vault is empty — no _addFile calls
    const index = makeIndex({
      'deleted.md': { hash: 'old-hash', mtime: 100, size: 10 },
    });

    const changed = await detector.reconcileScan(index, []);
    expect(changed.has('deleted.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reconcileScan — exclusions
// ---------------------------------------------------------------------------

describe('reconcileScan — exclusions are respected', () => {
  it('does not add excluded paths even if they differ from index', async () => {
    const { app, detector } = await makeSetup({
      hashFn: async () => 'new-hash',
    });

    app.vault._addFile('.obsidian/workspace.json', { mtime: 999, size: 99 });

    const index = makeIndex({
      '.obsidian/workspace.json': { hash: 'old-hash', mtime: 100, size: 10 },
    });

    const changed = await detector.reconcileScan(index, ['**/.obsidian/**']);
    expect(changed.has('.obsidian/workspace.json')).toBe(false);
  });

  it('does not add an excluded new file', async () => {
    const { app, detector } = await makeSetup({
      hashFn: async () => 'any-hash',
    });

    app.vault._addFile('.obsidian/plugins/foo/data.json', { mtime: 100, size: 10 });

    const index = makeIndex({});

    const changed = await detector.reconcileScan(index, ['**/.obsidian/**']);
    expect(changed.has('.obsidian/plugins/foo/data.json')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconcileScan — hash changed (content actually different)
// ---------------------------------------------------------------------------

describe('reconcileScan — file with changed hash IS added', () => {
  it('adds a file whose hash has changed', async () => {
    const { app, detector } = await makeSetup({
      hashFn: async () => 'new-hash',
    });

    app.vault._addFile('notes/a.md', { mtime: 9999, size: 10 });

    const index = makeIndex({
      'notes/a.md': { hash: 'old-hash', mtime: 1000, size: 10 },
    });

    const changed = await detector.reconcileScan(index, []);
    expect(changed.has('notes/a.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reconcileScan — yields every 500 files (10k vault)
// ---------------------------------------------------------------------------

describe('reconcileScan — yields every 500 files (10k vault)', () => {
  it('yields ≥ 20 times for 10k matching files AND never calls hash (warm path)', async () => {
    // Warm-path contract: when mtime+size match the index, the dirty-bit miss
    // branch is never entered — so readBytes / hash must never be called.
    // Using a vi.fn() spy is the only way to prove this; a plain async arrow
    // would let the test pass even if the implementation regresses and hashes
    // every file (because the returned value happens to match the index).
    const hashSpy = vi.fn(async () => 'consistent-hash');
    const { app, detector, yieldState } = await makeSetup({ hashFn: hashSpy });

    const indexFiles: Record<string, { hash: string; mtime: number; size: number }> = {};
    for (let i = 0; i < 10000; i++) {
      const path = `notes/file-${i}.md`;
      app.vault._addFile(path, { mtime: 1000, size: 100 });
      indexFiles[path] = { hash: 'consistent-hash', mtime: 1000, size: 100 };
    }

    const index = makeIndex(indexFiles);
    const changed = await detector.reconcileScan(index, []);

    expect(changed.size).toBe(0);
    expect(yieldState.count).toBeGreaterThanOrEqual(20); // 10000 / 500
    expect(hashSpy).not.toHaveBeenCalled(); // warm path — zero I/O
  });
});

// ---------------------------------------------------------------------------
// reconcileScan — large-file yield rule
// Note: PERF-H2 streaming-chunked hash is deferred (WebCrypto has no incremental
// API). The yield is emitted at the file boundary for files ≥ 10 MB.
// A single 50 MB file yields at least once (before + after hash boundary).
// ---------------------------------------------------------------------------

describe('reconcileScan — large-file yield rule (deferred streaming-chunk hash)', () => {
  it('yields at least once when processing a file ≥ 10 MB', async () => {
    const { app, detector, yieldState } = await makeSetup({
      hashFn: async () => 'new-hash',
    });

    const TEN_MB = 10 * 1024 * 1024;
    // File has different mtime/size from index so hash will be called
    app.vault._addFile('large.md', { mtime: 9999, size: TEN_MB + 1 });

    const index = makeIndex({
      'large.md': { hash: 'old-hash', mtime: 1000, size: TEN_MB },
    });

    await detector.reconcileScan(index, []);
    expect(yieldState.count).toBeGreaterThanOrEqual(1);
  });

  it('single large file yields exactly once — pre-hash yield resets byte accumulator', async () => {
    // Regression guard: an earlier version incremented bytesSinceYield by
    // f.size AFTER the pre-hash yield without resetting it. The loop-bottom
    // check then fired a second (redundant) yield for the same file. Pin
    // one-yield-per-large-file so the accumulator-reset stays.
    const { app, detector, yieldState } = await makeSetup({
      hashFn: async () => 'new-hash',
    });

    const TEN_MB = 10 * 1024 * 1024;
    app.vault._addFile('solo-large.md', { mtime: 9999, size: TEN_MB + 1 });
    const index = makeIndex({
      'solo-large.md': { hash: 'old-hash', mtime: 1000, size: TEN_MB },
    });

    await detector.reconcileScan(index, []);
    expect(yieldState.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// setExclusions — runtime exclusion updates
// ---------------------------------------------------------------------------

describe('setExclusions — runtime exclusion updates', () => {
  it('a newly-excluded path is dropped by subsequent events without re-registering handlers', async () => {
    // Phase 5 scheduler will call setExclusions when the user changes
    // exclusion_globs in settings. Proving the hot-swap here prevents a
    // future regression where setExclusions is added but never consulted.
    const { app, plugin, queue, detector } = await makeSetup();
    detector.registerEventHandlers([]);
    (plugin.app.workspace as unknown as Workspace & { _fireLayoutReady(): void })._fireLayoutReady();

    // Pre-swap: events land
    const before = app.vault._addFile('ignored/before.md', { mtime: 100, size: 10 });
    app.vault._fire('create', before);
    await flushMicrotasks();
    expect(queue.peekSince(null)).toHaveLength(1);

    // Hot-swap — add a glob that covers the ignored/ prefix
    detector.setExclusions(['ignored/**']);

    const after = app.vault._addFile('ignored/after.md', { mtime: 200, size: 20 });
    app.vault._fire('create', after);
    await flushMicrotasks();

    // The after-swap event must NOT have been enqueued
    expect(queue.peekSince(null)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getChangedPaths — combines queue + reconcile
// ---------------------------------------------------------------------------

describe('getChangedPaths — combines queue + reconcile', () => {
  it('returns queued paths when reconcile=false', async () => {
    const { app, plugin, queue, detector } = await makeSetup({
      hashFn: async () => 'any-hash',
    });

    detector.registerEventHandlers();
    (plugin.app.workspace as unknown as Workspace & { _fireLayoutReady(): void })._fireLayoutReady();

    const file = app.vault._addFile('notes/queued.md', { mtime: 100, size: 10 });
    app.vault._fire('create', file);

    // Drain microtask queue so enqueue promise resolves
    await Promise.resolve();
    await Promise.resolve();

    const index = makeIndex({});
    const changed = await detector.getChangedPaths(index, [], { reconcile: false });

    expect(changed.has('notes/queued.md')).toBe(true);
  });

  it('includes reconcile results when reconcile=true', async () => {
    const { app, detector } = await makeSetup({
      hashFn: async () => 'any-hash',
    });

    app.vault._addFile('untracked.md', { mtime: 100, size: 10 });
    const index = makeIndex({});

    const changed = await detector.getChangedPaths(index, [], { reconcile: true });
    expect(changed.has('untracked.md')).toBe(true);
  });

  it('filters excluded paths from queue results', async () => {
    const { app, plugin, queue, detector } = await makeSetup({
      hashFn: async () => 'any-hash',
    });

    // Register WITHOUT exclusions so the event IS enqueued
    detector.registerEventHandlers();
    (plugin.app.workspace as unknown as Workspace & { _fireLayoutReady(): void })._fireLayoutReady();

    const file = app.vault._addFile('.obsidian/workspace.json', { mtime: 100, size: 10 });
    app.vault._fire('create', file);

    await Promise.resolve();
    await Promise.resolve();

    // getChangedPaths applies exclusion filter belt-and-braces
    const index = makeIndex({});
    const changed = await detector.getChangedPaths(index, ['**/.obsidian/**'], { reconcile: false });

    // Even if the entry made it into the queue, getChangedPaths filters it out
    expect(changed.has('.obsidian/workspace.json')).toBe(false);
    void queue;
  });
});
