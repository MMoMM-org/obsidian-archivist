// RepairService — user-triggerable recovery actions for Dropbox corruption.
//
// Test scenarios cover:
//   1. rebuildSnapshotIndex: index has phantom IDs whose manifests are gone
//      → phantoms removed, valid IDs kept, rebuild called with valid set.
//   2. rebuildSnapshotIndex: idempotent on a healthy index (kept = all,
//      phantoms = []).
//   3. rebuildSnapshotIndex: missing snapshots/ folder → empty rebuild.
//   4. rebuildSnapshotIndex: corrupt existing index → treated as no IDs
//      known so the rebuild can still proceed.
//   5. rebuildSnapshotIndex: schema-invalid manifest in snapshots/ → kept
//      out of rebuild and reported as invalid.
//   6. rebuildSnapshotIndex: download error mid-list → reported as invalid,
//      other manifests still processed.
//   7. gcOrphanContent: delegates to GCService.sweep() and returns its result.

import { describe, expect, it, vi } from 'vitest';
import { RepairService } from '../../src/services/RepairService';
import type { SnapshotIndex } from '../../src/model/SnapshotIndex';
import type { SnapshotManifest } from '../../src/model/Manifest';
import { CorruptionError, NetworkError, PathError } from '../../src/model/Errors';
import { gcLockPath, snapshotsDir, snapshotPath, snapshotIndexPath } from '../../src/util/paths';

const VAULT_PREFIX = 'test-vault';
const SNAPSHOTS_DIR = snapshotsDir(VAULT_PREFIX);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeManifest(id: string, overrides?: Partial<SnapshotManifest>): SnapshotManifest {
  return {
    schema_version: '1.0',
    id,
    type: id.endsWith('full') ? 'full' : 'inc',
    parent_id: null,
    device_id: 'device-abc',
    created_at: '2026-04-10T10:00:00.000Z',
    vault_name: 'TestVault',
    vault_prefix: VAULT_PREFIX,
    files: {},
    deleted: [],
    renames: [],
    exclusions_applied: null,
    ...overrides,
  };
}

function makeIndex(ids: string[]): SnapshotIndex {
  return {
    schema_version: '1.0',
    last_updated_at: '2026-04-10T10:00:00.000Z',
    snapshots: ids.map((id) => ({
      id,
      type: id.endsWith('full') ? 'full' : 'inc',
      parent_id: null,
      created_at: '2026-04-10T10:00:00.000Z',
      device_id: 'device-abc',
      blob_hashes: [],
    })),
  };
}

// ---------------------------------------------------------------------------
// Fake Dropbox — mirrors retention-service.test.ts pattern
// ---------------------------------------------------------------------------

function makeFakeDropbox(): {
  store: Map<string, unknown>;
  failingPaths: Set<string>;
  uploadJson: ReturnType<typeof vi.fn>;
  downloadJson: ReturnType<typeof vi.fn>;
  listFolder: ReturnType<typeof vi.fn>;
  deleteV2: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, unknown>();
  const failingPaths = new Set<string>();
  return {
    store,
    failingPaths,
    uploadJson: vi.fn(async (path: string, value: unknown) => {
      store.set(path, JSON.parse(JSON.stringify(value)));
    }),
    downloadJson: vi.fn(async (path: string) => {
      if (failingPaths.has(path)) throw new NetworkError('NETWORK_TIMEOUT', `boom: ${path}`, true);
      if (!store.has(path)) throw new PathError('PATH_NOT_FOUND', `not found: ${path}`, false);
      return store.get(path);
    }),
    listFolder: vi.fn(async (path: string) => {
      if (failingPaths.has(path)) throw new PathError('PATH_NOT_FOUND', `not found: ${path}`, false);
      const prefix = path.endsWith('/') ? path : path + '/';
      const entries: Array<{ path: string; tag: 'file' }> = [];
      for (const key of store.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
          entries.push({ path: key, tag: 'file' });
        }
      }
      return entries;
    }),
    deleteV2: vi.fn(async (path: string) => {
      // Mirror Dropbox's behavior: deleting a non-existent path raises
      // PATH_NOT_FOUND. Tests rely on this for clearGcLock idempotency.
      if (!store.has(path)) {
        throw new PathError('PATH_NOT_FOUND', `not found: ${path}`, false);
      }
      store.delete(path);
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake SnapshotIndexStore
// ---------------------------------------------------------------------------

function makeFakeSnapshotIndexStore(initial: SnapshotIndex | null, opts?: { readThrows?: Error }) {
  let stored: SnapshotIndex | null = initial ? JSON.parse(JSON.stringify(initial)) : null;
  // RepairService now calls rebuildFromEntries (M9 — entries are extracted
  // batch-by-batch so the manifest's `files` map can be GCed). The legacy
  // `rebuild(manifests)` path is still exercised by other callers
  // (RetentionService, StartupRecovery) so the fake covers both.
  const rebuildCalls: Array<Array<{ id: string }>> = [];
  return {
    rebuildCalls,
    get storedIndex(): SnapshotIndex | null { return stored; },
    read: vi.fn(async () => {
      if (opts?.readThrows) throw opts.readThrows;
      return stored;
    }),
    rebuild: vi.fn(async (manifests: SnapshotManifest[]) => {
      rebuildCalls.push(manifests.map((m) => ({ id: m.id })));
      stored = {
        schema_version: '1.0',
        last_updated_at: '2026-04-10T11:00:00.000Z',
        snapshots: manifests.map((m) => ({
          id: m.id,
          type: m.type,
          parent_id: m.parent_id,
          created_at: m.created_at,
          device_id: m.device_id,
          blob_hashes: [],
        })),
      };
    }),
    rebuildFromEntries: vi.fn(async (entries: Array<{
      id: string; type: 'full' | 'inc'; parent_id: string | null;
      created_at: string; device_id: string; blob_hashes: string[];
    }>) => {
      rebuildCalls.push(entries.map((e) => ({ id: e.id })));
      stored = {
        schema_version: '1.0',
        last_updated_at: '2026-04-10T11:00:00.000Z',
        snapshots: entries.slice(),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake GCService — only sweep() needs implementing for repair tests.
// ---------------------------------------------------------------------------

function makeFakeGcService(result: {
  state: 'swept' | 'skipped_locked' | 'skipped_no_index';
  deleted?: string[];
  kept_count?: number;
  skipped_age_gate?: number;
  blocking_lock?: { started_at: string; age_ms: number };
}) {
  return {
    sweep: vi.fn(async () => ({
      state: result.state,
      deleted: result.deleted ?? [],
      kept_count: result.kept_count ?? 0,
      skipped_age_gate: result.skipped_age_gate ?? 0,
      blocking_lock: result.blocking_lock,
    })),
  };
}

// ---------------------------------------------------------------------------
// Logger stub
// ---------------------------------------------------------------------------

function makeLogger(): {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helper: seed a manifest into the fake Dropbox at the canonical path.
// ---------------------------------------------------------------------------

function seedManifest(
  store: Map<string, unknown>,
  manifest: SnapshotManifest,
): void {
  store.set(snapshotPath({ vault_prefix: VAULT_PREFIX, id: manifest.id }), manifest);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RepairService.rebuildSnapshotIndex', () => {
  it('removes phantom IDs whose manifests are gone, keeps valid IDs', async () => {
    const fakeDropbox = makeFakeDropbox();
    // Manifests on Dropbox: only 2 of the 3 IDs the index claims.
    seedManifest(fakeDropbox.store, makeManifest('2026-04-26T21-48-full'));
    seedManifest(fakeDropbox.store, makeManifest('2026-04-27T11-46-inc'));
    // Index claims a 3rd snapshot whose manifest no longer exists.
    fakeDropbox.store.set(
      snapshotIndexPath(VAULT_PREFIX),
      makeIndex([
        '2026-04-26T21-48-full',
        '2026-04-27T11-46-inc',
        '2026-04-27T16-09-inc', // phantom
      ]),
    );
    const indexStore = makeFakeSnapshotIndexStore(
      makeIndex([
        '2026-04-26T21-48-full',
        '2026-04-27T11-46-inc',
        '2026-04-27T16-09-inc',
      ]),
    );
    const gc = makeFakeGcService({ state: 'swept' });

    const repair = new RepairService({
      dropbox: fakeDropbox as never,
      snapshotIndexStore: indexStore as never,
      gcService: gc as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
    });

    const result = await repair.rebuildSnapshotIndex();

    expect(result.phantomsRemoved).toEqual(['2026-04-27T16-09-inc']);
    expect(result.kept.sort()).toEqual([
      '2026-04-26T21-48-full',
      '2026-04-27T11-46-inc',
    ]);
    expect(result.invalidManifests).toEqual([]);
    expect(indexStore.rebuildCalls).toHaveLength(1);
    expect(indexStore.rebuildCalls[0].map((m) => m.id).sort()).toEqual([
      '2026-04-26T21-48-full',
      '2026-04-27T11-46-inc',
    ]);
  });

  it('is idempotent on a healthy index — phantoms stays empty', async () => {
    const fakeDropbox = makeFakeDropbox();
    seedManifest(fakeDropbox.store, makeManifest('2026-04-26T21-48-full'));
    seedManifest(fakeDropbox.store, makeManifest('2026-04-27T11-46-inc'));
    const indexStore = makeFakeSnapshotIndexStore(makeIndex(['2026-04-26T21-48-full', '2026-04-27T11-46-inc']));

    const repair = new RepairService({
      dropbox: fakeDropbox as never,
      snapshotIndexStore: indexStore as never,
      gcService: makeFakeGcService({ state: 'swept' }) as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
    });

    const result = await repair.rebuildSnapshotIndex();
    expect(result.phantomsRemoved).toEqual([]);
    expect(result.kept.sort()).toEqual(['2026-04-26T21-48-full', '2026-04-27T11-46-inc']);
  });

  it('treats missing snapshots/ folder as empty (fresh-vault case)', async () => {
    const fakeDropbox = makeFakeDropbox();
    fakeDropbox.failingPaths.add(SNAPSHOTS_DIR);
    const indexStore = makeFakeSnapshotIndexStore(null);

    const repair = new RepairService({
      dropbox: fakeDropbox as never,
      snapshotIndexStore: indexStore as never,
      gcService: makeFakeGcService({ state: 'swept' }) as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
    });

    const result = await repair.rebuildSnapshotIndex();
    expect(result.kept).toEqual([]);
    expect(result.phantomsRemoved).toEqual([]);
    expect(indexStore.rebuildCalls).toHaveLength(1);
    expect(indexStore.rebuildCalls[0]).toEqual([]);
  });

  it('treats a corrupt existing index as "no IDs known" so rebuild can still proceed', async () => {
    const fakeDropbox = makeFakeDropbox();
    seedManifest(fakeDropbox.store, makeManifest('2026-04-26T21-48-full'));
    const indexStore = makeFakeSnapshotIndexStore(null, {
      readThrows: new CorruptionError('SNAPSHOT_INDEX_INVALID', 'bad', false),
    });

    const repair = new RepairService({
      dropbox: fakeDropbox as never,
      snapshotIndexStore: indexStore as never,
      gcService: makeFakeGcService({ state: 'swept' }) as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
    });

    const result = await repair.rebuildSnapshotIndex();
    // No prior IDs known → nothing to flag as phantom; valid manifest kept.
    expect(result.phantomsRemoved).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(indexStore.rebuildCalls[0].map((m) => m.id)).toEqual(['2026-04-26T21-48-full']);
  });

  it('reports schema-invalid manifests as invalid and omits them from rebuild', async () => {
    const fakeDropbox = makeFakeDropbox();
    seedManifest(fakeDropbox.store, makeManifest('2026-04-26T21-48-full'));
    // Manifest path exists but content fails schema validation.
    fakeDropbox.store.set(
      snapshotPath({ vault_prefix: VAULT_PREFIX, id: '2026-04-27T16-09-inc' }),
      { not: 'a manifest' },
    );
    const indexStore = makeFakeSnapshotIndexStore(makeIndex(['2026-04-26T21-48-full', '2026-04-27T16-09-inc']));

    const repair = new RepairService({
      dropbox: fakeDropbox as never,
      snapshotIndexStore: indexStore as never,
      gcService: makeFakeGcService({ state: 'swept' }) as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
    });

    const result = await repair.rebuildSnapshotIndex();
    expect(result.kept).toEqual(['2026-04-26T21-48-full']);
    expect(result.phantomsRemoved).toEqual(['2026-04-27T16-09-inc']);
    expect(result.invalidManifests).toHaveLength(1);
    // M12: pin the path content so a future change of the `invalidManifests`
    // shape (e.g. switching to ids) breaks loudly instead of leaking through.
    expect(result.invalidManifests[0]).toContain('2026-04-27T16-09-inc');
    expect(indexStore.rebuildCalls[0].map((m) => m.id)).toEqual(['2026-04-26T21-48-full']);
  });

  it('continues processing after a per-manifest download error', async () => {
    const fakeDropbox = makeFakeDropbox();
    seedManifest(fakeDropbox.store, makeManifest('2026-04-26T21-48-full'));
    seedManifest(fakeDropbox.store, makeManifest('2026-04-27T11-46-inc'));
    fakeDropbox.failingPaths.add(snapshotPath({ vault_prefix: VAULT_PREFIX, id: '2026-04-27T11-46-inc' }));
    const indexStore = makeFakeSnapshotIndexStore(makeIndex(['2026-04-26T21-48-full', '2026-04-27T11-46-inc']));

    const repair = new RepairService({
      dropbox: fakeDropbox as never,
      snapshotIndexStore: indexStore as never,
      gcService: makeFakeGcService({ state: 'swept' }) as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
    });

    const result = await repair.rebuildSnapshotIndex();
    expect(result.kept).toEqual(['2026-04-26T21-48-full']);
    expect(result.phantomsRemoved).toEqual(['2026-04-27T11-46-inc']);
    expect(result.invalidManifests).toHaveLength(1);
    // M12: same pin for the download-error path.
    expect(result.invalidManifests[0]).toContain('2026-04-27T11-46-inc');
  });

  // -------------------------------------------------------------------------
  // H6 + M9: parallel batched download with bounded in-flight set, results
  // reduced to index entries before the next batch starts.
  // -------------------------------------------------------------------------

  it('downloads manifests in parallel batches (H6)', async () => {
    const fakeDropbox = makeFakeDropbox();
    // 20 manifests — exceeds the batch size (8) so we observe at least three
    // batches (8 + 8 + 4).
    const ids = Array.from({ length: 20 }, (_, i) =>
      `2026-04-${String(10 + i).padStart(2, '0')}T10-00-full`,
    );
    for (const id of ids) seedManifest(fakeDropbox.store, makeManifest(id));
    const indexStore = makeFakeSnapshotIndexStore(makeIndex(ids));

    let inFlight = 0;
    let maxObservedInFlight = 0;
    const originalDownload = fakeDropbox.downloadJson as unknown as (path: string) => Promise<unknown>;
    fakeDropbox.downloadJson = vi.fn(async (path: string) => {
      inFlight += 1;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
      try {
        // Tiny await tick so concurrent fan-out can be observed.
        await Promise.resolve();
        return await originalDownload(path);
      } finally {
        inFlight -= 1;
      }
    });

    const repair = new RepairService({
      dropbox: fakeDropbox as never,
      snapshotIndexStore: indexStore as never,
      gcService: makeFakeGcService({ state: 'swept' }) as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
    });

    const result = await repair.rebuildSnapshotIndex();
    expect(result.kept).toHaveLength(20);
    // Bounded fan-out: at least 2 in flight (proves parallelism), and never
    // more than the documented batch size (8) in flight at once.
    expect(maxObservedInFlight).toBeGreaterThanOrEqual(2);
    expect(maxObservedInFlight).toBeLessThanOrEqual(8);
  });

  it('reduces manifests to index entries (no full files map retained, M9)', async () => {
    const fakeDropbox = makeFakeDropbox();
    // Big files map: makes a measurable difference in store content so the
    // assertion that we did NOT pass full manifests is verifiable.
    const bigFiles: Record<string, { hash: string; size: number; mtime: number }> = {};
    for (let i = 0; i < 50; i += 1) {
      bigFiles[`note-${i}.md`] = { hash: `h${i}`, size: 100, mtime: 0 };
    }
    seedManifest(
      fakeDropbox.store,
      makeManifest('2026-04-26T21-48-full', { files: bigFiles }),
    );
    const indexStore = makeFakeSnapshotIndexStore(makeIndex(['2026-04-26T21-48-full']));

    const repair = new RepairService({
      dropbox: fakeDropbox as never,
      snapshotIndexStore: indexStore as never,
      gcService: makeFakeGcService({ state: 'swept' }) as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
    });
    await repair.rebuildSnapshotIndex();

    // The store-fake records SnapshotIndexEntry-shaped objects on
    // rebuildFromEntries — assert the entry has only the index-row
    // fields (no `files` map leaked through).
    const stored = indexStore.storedIndex!;
    expect(stored.snapshots).toHaveLength(1);
    expect(stored.snapshots[0]).not.toHaveProperty('files');
    // blob_hashes are pre-computed from the manifest before discard.
    expect(stored.snapshots[0].blob_hashes).toEqual(
      Array.from(new Set(Object.values(bigFiles).map((f) => f.hash))),
    );
    // rebuild() (manifest variant) was NOT called — proves the new
    // entry path is used.
    expect(indexStore.rebuild).not.toHaveBeenCalled();
    expect(indexStore.rebuildFromEntries).toHaveBeenCalledOnce();
  });
});

describe('RepairService.gcOrphanContent', () => {
  it('delegates to GCService.sweep() and returns its result verbatim', async () => {
    const gc = makeFakeGcService({
      state: 'swept',
      deleted: ['blob-1', 'blob-2'],
      kept_count: 5,
      skipped_age_gate: 1,
    });
    const repair = new RepairService({
      dropbox: makeFakeDropbox() as never,
      snapshotIndexStore: makeFakeSnapshotIndexStore(null) as never,
      gcService: gc as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
    });

    const result = await repair.gcOrphanContent();
    expect(gc.sweep).toHaveBeenCalledOnce();
    expect(result.state).toBe('swept');
    expect(result.deleted).toEqual(['blob-1', 'blob-2']);
    expect(result.kept_count).toBe(5);
    expect(result.skipped_age_gate).toBe(1);
  });

  it('passes through skipped_locked and skipped_no_index states', async () => {
    const gcLocked = makeFakeGcService({
      state: 'skipped_locked',
      blocking_lock: { started_at: '2026-04-28T08:00:00Z', age_ms: 12 * 60 * 1000 },
    });
    const repair = new RepairService({
      dropbox: makeFakeDropbox() as never,
      snapshotIndexStore: makeFakeSnapshotIndexStore(null) as never,
      gcService: gcLocked as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
    });
    const r1 = await repair.gcOrphanContent();
    expect(r1.state).toBe('skipped_locked');
    expect(r1.blocking_lock?.age_ms).toBe(12 * 60 * 1000);
  });

  it('passes through skipped_no_index state (M13)', async () => {
    const gcNoIndex = makeFakeGcService({ state: 'skipped_no_index' });
    const repair = new RepairService({
      dropbox: makeFakeDropbox() as never,
      snapshotIndexStore: makeFakeSnapshotIndexStore(null) as never,
      gcService: gcNoIndex as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
    });
    const result = await repair.gcOrphanContent();
    expect(result.state).toBe('skipped_no_index');
    expect(result.deleted).toEqual([]);
    expect(result.kept_count).toBe(0);
  });
});

describe('RepairService.rebuildSnapshotIndex — cache invalidation', () => {
  it('calls invalidateManifestCache after a successful rebuild', async () => {
    const fakeDropbox = makeFakeDropbox();
    seedManifest(fakeDropbox.store, makeManifest('2026-04-26T21-48-full'));
    const indexStore = makeFakeSnapshotIndexStore(makeIndex(['2026-04-26T21-48-full']));
    const invalidate = vi.fn();

    const repair = new RepairService({
      dropbox: fakeDropbox as never,
      snapshotIndexStore: indexStore as never,
      gcService: makeFakeGcService({ state: 'swept' }) as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
      invalidateManifestCache: invalidate,
    });

    await repair.rebuildSnapshotIndex();
    expect(invalidate).toHaveBeenCalledOnce();
  });
});

describe('RepairService.clearGcLock', () => {
  it('deletes the gc_lock file when present and returns true', async () => {
    const fakeDropbox = makeFakeDropbox();
    fakeDropbox.store.set(gcLockPath(VAULT_PREFIX), { schema_version: '1.0', started_at: 'x' });
    const repair = new RepairService({
      dropbox: fakeDropbox as never,
      snapshotIndexStore: makeFakeSnapshotIndexStore(null) as never,
      gcService: makeFakeGcService({ state: 'swept' }) as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
    });

    const cleared = await repair.clearGcLock();
    expect(cleared).toBe(true);
    expect(fakeDropbox.store.has(gcLockPath(VAULT_PREFIX))).toBe(false);
  });

  it('returns false when no lock is present (idempotent)', async () => {
    const fakeDropbox = makeFakeDropbox();
    const repair = new RepairService({
      dropbox: fakeDropbox as never,
      snapshotIndexStore: makeFakeSnapshotIndexStore(null) as never,
      gcService: makeFakeGcService({ state: 'swept' }) as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
    });
    const cleared = await repair.clearGcLock();
    expect(cleared).toBe(false);
  });

  it('propagates non-PATH_NOT_FOUND errors from deleteV2 (L6)', async () => {
    const fakeDropbox = makeFakeDropbox();
    fakeDropbox.store.set(gcLockPath(VAULT_PREFIX), { schema_version: '1.0', started_at: 'x' });
    // Override deleteV2 to throw a non-path error (e.g. permissions
    // / network), which clearGcLock must NOT swallow.
    fakeDropbox.deleteV2 = vi.fn(async () => {
      throw new NetworkError('NETWORK_TIMEOUT', 'transient', true);
    });
    const repair = new RepairService({
      dropbox: fakeDropbox as never,
      snapshotIndexStore: makeFakeSnapshotIndexStore(null) as never,
      gcService: makeFakeGcService({ state: 'swept' }) as never,
      vaultPrefix: VAULT_PREFIX,
      logger: makeLogger() as never,
    });
    await expect(repair.clearGcLock()).rejects.toMatchObject({
      code: 'NETWORK_TIMEOUT',
    });
    // Lock is still in the store — we did NOT silently treat this as a
    // no-op the way the PATH_NOT_FOUND branch does.
    expect(fakeDropbox.store.has(gcLockPath(VAULT_PREFIX))).toBe(true);
  });
});
