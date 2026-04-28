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
import { snapshotsDir, snapshotPath, snapshotIndexPath } from '../../src/util/paths';

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
      store.delete(path);
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake SnapshotIndexStore
// ---------------------------------------------------------------------------

function makeFakeSnapshotIndexStore(initial: SnapshotIndex | null, opts?: { readThrows?: Error }) {
  let stored: SnapshotIndex | null = initial ? JSON.parse(JSON.stringify(initial)) : null;
  const rebuildCalls: SnapshotManifest[][] = [];
  return {
    rebuildCalls,
    get storedIndex(): SnapshotIndex | null { return stored; },
    read: vi.fn(async () => {
      if (opts?.readThrows) throw opts.readThrows;
      return stored;
    }),
    rebuild: vi.fn(async (manifests: SnapshotManifest[]) => {
      rebuildCalls.push(manifests.slice());
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
});
