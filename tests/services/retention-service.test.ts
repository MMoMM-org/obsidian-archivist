// T6.3 — RetentionService: metadata-only orchestrator (ADR-17/20).
//
// Test scenarios:
//   1. Throttle: last_retention_at = now - 1h → state 'skipped_throttle', no Dropbox calls.
//   2. First run: last_retention_at = null → proceeds.
//   3. Due: last_retention_at = now - 25h → proceeds.
//   4. Fresh local index (null from pluginStore) → state 'no_op_fresh', no calls.
//   5. Metadata-only: 5 snapshot_index entries → ZERO downloadJson calls to snapshotPath.
//   6. Fallback rebuild: snapshotIndexStore.read throws CorruptionError → listFolder + rebuild.
//   7. Chain-integrity: F → A → B chain; B is tier-kept; F + A retained; other orphans pruned.
//   8. Per-manifest delete failure: first delete throws NetworkError; loop continues.
//   9. triggerGcSweep fire-and-forget: callback invoked once after prunes; never awaited.
//   10. last_retention_at persisted: saveIndex called with new timestamp.

import { describe, expect, it, vi } from 'vitest';
import { RetentionService, type RetentionServiceDeps } from '../../src/services/RetentionService';
import { CorruptionError, NetworkError } from '../../src/model/Errors';
import type { LocalIndex } from '../../src/model/Index';
import { emptyLocalIndex } from '../../src/model/Index';
import type { SnapshotIndex, SnapshotIndexEntry } from '../../src/model/SnapshotIndex';
import type { SnapshotManifest } from '../../src/model/Manifest';
import type { PluginSettings } from '../../src/model/Settings';
import { DEFAULT_SETTINGS } from '../../src/model/Settings';
import { snapshotsDir, snapshotPath } from '../../src/util/paths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VAULT_PREFIX = 'test-vault';
const SNAPSHOTS_DIR = snapshotsDir(VAULT_PREFIX);

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-24T12:00:00.000Z');
const ONE_HOUR_AGO = new Date(NOW.getTime() - 60 * 60 * 1000);
const TWENTY_FIVE_HOURS_AGO = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeLocalIndex(overrides?: Partial<LocalIndex>): LocalIndex {
  return {
    ...emptyLocalIndex(),
    ...overrides,
  };
}

function makeSettings(overrides?: Partial<PluginSettings['retention']>): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    retention: {
      ...DEFAULT_SETTINGS.retention,
      ...overrides,
    },
  };
}

function makeIndexEntry(
  id: string,
  created_at: string,
  overrides?: Partial<SnapshotIndexEntry>,
): SnapshotIndexEntry {
  return {
    id,
    type: 'full',
    parent_id: null,
    created_at,
    device_id: 'device-abc',
    blob_hashes: [],
    ...overrides,
  };
}

function makeSnapshotIndex(entries: SnapshotIndexEntry[]): SnapshotIndex {
  return {
    schema_version: '1.0',
    last_updated_at: NOW.toISOString(),
    snapshots: entries,
  };
}

function makeManifest(id: string, vaultPrefix = VAULT_PREFIX): SnapshotManifest {
  return {
    schema_version: '1.0',
    id,
    type: 'full',
    parent_id: null,
    device_id: 'device-abc',
    created_at: '2026-04-10T10:00:00.000Z',
    vault_name: 'TestVault',
    vault_prefix: vaultPrefix,
    files: {},
    deleted: [],
    renames: [],
    exclusions_applied: null,
  };
}

// ---------------------------------------------------------------------------
// Fake Dropbox
// ---------------------------------------------------------------------------

function makeFakeDropbox() {
  const store = new Map<string, unknown>();
  const deleteV2Calls: string[] = [];
  const downloadJsonCalls: string[] = [];

  return {
    store,
    deleteV2Calls,
    downloadJsonCalls,

    uploadJson: vi.fn(async (path: string, value: unknown) => {
      store.set(path, JSON.parse(JSON.stringify(value)));
    }),

    downloadJson: vi.fn(async (path: string) => {
      downloadJsonCalls.push(path);
      if (!store.has(path)) {
        const { PathError } = await import('../../src/model/Errors');
        throw new PathError('PATH_NOT_FOUND', `not found: ${path}`, false);
      }
      return store.get(path);
    }),

    listFolder: vi.fn(async (path: string) => {
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
      deleteV2Calls.push(path);
      store.delete(path);
    }),
  };
}

type FakeDropbox = ReturnType<typeof makeFakeDropbox>;

// ---------------------------------------------------------------------------
// Fake PluginStore
// ---------------------------------------------------------------------------

function makeFakePluginStore(localIndex: LocalIndex | null, settings: PluginSettings = makeSettings()) {
  let storedIndex = localIndex;
  const saveIndexCalls: LocalIndex[] = [];

  return {
    saveIndexCalls,
    get storedIndex() { return storedIndex; },

    loadIndex: vi.fn(async () => storedIndex),

    saveIndex: vi.fn(async (index: LocalIndex) => {
      saveIndexCalls.push(JSON.parse(JSON.stringify(index)) as LocalIndex);
      storedIndex = index;
    }),

    loadSettings: vi.fn(async () => settings),
  };
}

type FakePluginStore = ReturnType<typeof makeFakePluginStore>;

// ---------------------------------------------------------------------------
// Fake SnapshotIndexStore
// ---------------------------------------------------------------------------

function makeFakeSnapshotIndexStore(index: SnapshotIndex | null = null) {
  let storedIndex = index ? JSON.parse(JSON.stringify(index)) as SnapshotIndex : null;
  const removeCalls: string[] = [];
  const rebuildCalls: SnapshotManifest[][] = [];

  return {
    removeCalls,
    rebuildCalls,
    get storedIndex() { return storedIndex; },

    read: vi.fn(async () => storedIndex),

    remove: vi.fn(async (id: string) => {
      removeCalls.push(id);
      if (storedIndex) {
        storedIndex = {
          ...storedIndex,
          snapshots: storedIndex.snapshots.filter((s) => s.id !== id),
        };
      }
    }),

    rebuild: vi.fn(async (manifests: SnapshotManifest[]) => {
      rebuildCalls.push(manifests);
      // After rebuild, simulate the index being rebuilt
      storedIndex = {
        schema_version: '1.0',
        last_updated_at: NOW.toISOString(),
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

type FakeSnapshotIndexStore = ReturnType<typeof makeFakeSnapshotIndexStore>;

// ---------------------------------------------------------------------------
// Fake Logger
// ---------------------------------------------------------------------------

function makeFakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

function makeService(opts: {
  dropbox?: FakeDropbox;
  pluginStore?: FakePluginStore;
  snapshotIndexStore?: FakeSnapshotIndexStore;
  triggerGcSweep?: () => void;
}): RetentionService {
  const dropbox = opts.dropbox ?? makeFakeDropbox();
  const pluginStore = opts.pluginStore ?? makeFakePluginStore(makeLocalIndex());
  const snapshotIndexStore = opts.snapshotIndexStore ?? makeFakeSnapshotIndexStore();

  const deps: RetentionServiceDeps = {
    dropbox: dropbox as unknown as RetentionServiceDeps['dropbox'],
    pluginStore: pluginStore as unknown as RetentionServiceDeps['pluginStore'],
    snapshotIndexStore: snapshotIndexStore as unknown as RetentionServiceDeps['snapshotIndexStore'],
    logger: makeFakeLogger(),
    vaultPrefix: VAULT_PREFIX,
    triggerGcSweep: opts.triggerGcSweep,
    now: () => NOW,
  };

  return new RetentionService(deps);
}

// ---------------------------------------------------------------------------
// Test snapshot IDs — valid format: YYYY-MM-DDThh-mm-<type>
// ---------------------------------------------------------------------------

const IDS = {
  F1: '2026-03-01T10-00-full',
  F2: '2026-03-15T10-00-full',
  F3: '2026-04-01T10-00-full',
  A1: '2026-04-10T10-00-inc',
  B1: '2026-04-11T10-00-inc',
  B2: '2026-04-12T10-00-inc',
  RECENT1: '2026-04-24T11-00-full', // 1h before NOW
  RECENT2: '2026-04-24T10-00-full', // 2h before NOW
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RetentionService', () => {
  describe('throttle check', () => {
    it('returns skipped_throttle when last_retention_at is only 1h ago', async () => {
      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: ONE_HOUR_AGO.toISOString() }),
      );
      const dropbox = makeFakeDropbox();
      const snapshotIndexStore = makeFakeSnapshotIndexStore();

      const svc = makeService({ pluginStore, dropbox, snapshotIndexStore });
      const result = await svc.runIfDue(NOW);

      expect(result.ran).toBe(false);
      expect(result.state).toBe('skipped_throttle');
      expect(dropbox.downloadJson).not.toHaveBeenCalled();
      expect(dropbox.listFolder).not.toHaveBeenCalled();
      expect(dropbox.deleteV2).not.toHaveBeenCalled();
    });

    it('proceeds when last_retention_at is null (first run)', async () => {
      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: null }),
        makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex([]));

      const svc = makeService({ pluginStore, snapshotIndexStore });
      const result = await svc.runIfDue(NOW);

      expect(result.ran).toBe(true);
    });

    it('proceeds when last_retention_at is 25h ago', async () => {
      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: TWENTY_FIVE_HOURS_AGO.toISOString() }),
        makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex([]));

      const svc = makeService({ pluginStore, snapshotIndexStore });
      const result = await svc.runIfDue(NOW);

      expect(result.ran).toBe(true);
    });
  });

  describe('fresh local index', () => {
    it('returns no_op_fresh when pluginStore.loadIndex returns null', async () => {
      const pluginStore = makeFakePluginStore(null);
      const dropbox = makeFakeDropbox();
      const snapshotIndexStore = makeFakeSnapshotIndexStore();

      const svc = makeService({ pluginStore, dropbox, snapshotIndexStore });
      const result = await svc.runIfDue(NOW);

      expect(result.ran).toBe(false);
      expect(result.state).toBe('no_op_fresh');
      expect(dropbox.downloadJson).not.toHaveBeenCalled();
      expect(dropbox.listFolder).not.toHaveBeenCalled();
    });
  });

  describe('metadata-only (PERF-C1)', () => {
    it('does not call downloadJson for snapshotPath during happy-path retention', async () => {
      // Seed 5 entries in snapshot_index; all are old enough to prune under zero-retention settings
      const entries = [IDS.F1, IDS.F2, IDS.F3, IDS.A1, IDS.B1].map((id, i) =>
        makeIndexEntry(id, `2026-01-0${i + 1}T10:00:00.000Z`),
      );
      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: null }),
        makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const dropbox = makeFakeDropbox();
      // Only the snapshotIndexStore.read is used — not downloadJson
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex(entries));

      const svc = makeService({ pluginStore, dropbox, snapshotIndexStore });
      await svc.runIfDue(NOW);

      // No downloadJson should be called for snapshot paths
      const snapshotPathCalls = dropbox.downloadJsonCalls.filter((p) =>
        p.startsWith(SNAPSHOTS_DIR),
      );
      expect(snapshotPathCalls).toHaveLength(0);
    });
  });

  describe('fallback rebuild', () => {
    it('rebuilds index when snapshotIndexStore.read throws CorruptionError', async () => {
      const manifests = [
        makeManifest(IDS.F1),
        makeManifest(IDS.F2),
        makeManifest(IDS.F3),
      ];

      // Pre-seed dropbox with manifests so downloadJson finds them
      const dropbox = makeFakeDropbox();
      for (const m of manifests) {
        const p = snapshotPath({ vault_prefix: VAULT_PREFIX, id: m.id });
        dropbox.store.set(p, m);
      }
      // listFolder returns the 3 files
      dropbox.listFolder = vi.fn(async () =>
        manifests.map((m) => ({
          path: snapshotPath({ vault_prefix: VAULT_PREFIX, id: m.id }),
          tag: 'file' as const,
        })),
      );

      const corruptStore = makeFakeSnapshotIndexStore();
      // Throw on first read (corrupt); subsequent reads (after rebuild) return normally.
      corruptStore.read = vi.fn()
        .mockRejectedValueOnce(new CorruptionError('SNAPSHOT_INDEX_INVALID', 'bad data', false))
        .mockImplementation(async () => corruptStore.storedIndex);

      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: null }),
        makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );

      const svc = makeService({ dropbox, pluginStore, snapshotIndexStore: corruptStore });
      await svc.runIfDue(NOW);

      expect(corruptStore.rebuildCalls).toHaveLength(1);
      const rebuiltManifests = corruptStore.rebuildCalls[0];
      expect(rebuiltManifests).toHaveLength(3);
      expect(rebuiltManifests.map((m) => m.id).sort()).toEqual(
        [IDS.F1, IDS.F2, IDS.F3].sort(),
      );
    });

    it('skips manifest entries that fail isSnapshotManifest validation during fallback', async () => {
      const validManifest = makeManifest(IDS.F1);
      const invalidManifest = { schema_version: '1.0', id: 'bad-id' }; // missing required fields

      const dropbox = makeFakeDropbox();
      dropbox.listFolder = vi.fn(async () => [
        { path: snapshotPath({ vault_prefix: VAULT_PREFIX, id: IDS.F1 }), tag: 'file' as const },
        { path: `${SNAPSHOTS_DIR}/bad.json`, tag: 'file' as const },
      ]);
      dropbox.downloadJson = vi.fn(async (path: string) => {
        if (path.includes(IDS.F1)) return validManifest;
        return invalidManifest;
      });

      const corruptStore = makeFakeSnapshotIndexStore();
      // Throw on first read (corrupt); subsequent reads (after rebuild) return normally.
      corruptStore.read = vi.fn()
        .mockRejectedValueOnce(new CorruptionError('SNAPSHOT_INDEX_INVALID', 'bad data', false))
        .mockImplementation(async () => corruptStore.storedIndex);

      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: null }),
        makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );

      const svc = makeService({ dropbox, pluginStore, snapshotIndexStore: corruptStore });
      await svc.runIfDue(NOW);

      expect(corruptStore.rebuildCalls).toHaveLength(1);
      expect(corruptStore.rebuildCalls[0]).toHaveLength(1);
      expect(corruptStore.rebuildCalls[0][0].id).toBe(IDS.F1);
    });
  });

  describe('tier + chain-integrity pruning', () => {
    it('retains ancestor chain: F → A → B where B is tier-kept; prunes other orphans', async () => {
      // Chain: F1(full) → A1(inc, parent=F1) → B1(inc, parent=A1)
      // B1 is recent (within never_prune_window_days=1); F1 and A1 kept by chain-integrity
      // Other entries (F2, F3, B2) are old and should be pruned
      const entries: SnapshotIndexEntry[] = [
        makeIndexEntry(IDS.F1, '2026-01-01T10:00:00.000Z', { type: 'full' }),
        makeIndexEntry(IDS.A1, '2026-04-10T10:00:00.000Z', { type: 'inc', parent_id: IDS.F1 }),
        makeIndexEntry(IDS.B1, '2026-04-24T11:00:00.000Z', { type: 'inc', parent_id: IDS.A1 }),
        makeIndexEntry(IDS.F2, '2026-02-01T10:00:00.000Z', { type: 'full' }),
        makeIndexEntry(IDS.F3, '2026-03-01T10:00:00.000Z', { type: 'full' }),
      ];

      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: null }),
        // never_prune_window_days=1 keeps snapshots within 1 day of NOW → B1 (1h before NOW)
        makeSettings({ never_prune_window_days: 1, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const dropbox = makeFakeDropbox();
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex(entries));

      const svc = makeService({ pluginStore, dropbox, snapshotIndexStore });
      const result = await svc.runIfDue(NOW);

      // B1 kept by never_prune; F1 + A1 kept by chain-integrity
      expect(result.pruned_ids).not.toContain(IDS.B1);
      expect(result.pruned_ids).not.toContain(IDS.A1);
      expect(result.pruned_ids).not.toContain(IDS.F1);

      // F2 and F3 should be pruned (old, no descendants in kept set)
      expect(result.pruned_ids).toContain(IDS.F2);
      expect(result.pruned_ids).toContain(IDS.F3);
    });
  });

  describe('delete failure handling', () => {
    it('continues loop and records failed delete; state is pruned; failed id stays in index', async () => {
      const FAIL_ID = IDS.F1;
      const OK_ID = IDS.F2;

      const entries: SnapshotIndexEntry[] = [
        makeIndexEntry(FAIL_ID, '2026-01-01T10:00:00.000Z'),
        makeIndexEntry(OK_ID, '2026-01-02T10:00:00.000Z'),
      ];

      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: null }),
        makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const dropbox = makeFakeDropbox();
      dropbox.deleteV2 = vi.fn(async (path: string) => {
        if (path.includes(FAIL_ID)) {
          throw new NetworkError('NETWORK_ERROR', 'timeout', true);
        }
        dropbox.deleteV2Calls.push(path);
      });

      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex(entries));

      const svc = makeService({ pluginStore, dropbox, snapshotIndexStore });
      const result = await svc.runIfDue(NOW);

      expect(result.state).toBe('pruned');
      expect(result.failed_deletes).toContain(FAIL_ID);
      expect(result.pruned_ids).toContain(OK_ID);
      expect(result.pruned_ids).not.toContain(FAIL_ID);

      // Failed id should still be in the index (remove not called for it)
      const idsInIndex = snapshotIndexStore.storedIndex?.snapshots.map((s) => s.id) ?? [];
      expect(idsInIndex).toContain(FAIL_ID);
    });
  });

  describe('triggerGcSweep', () => {
    it('does not propagate a synchronous throw from triggerGcSweep — logs warn instead', async () => {
      const entries: SnapshotIndexEntry[] = [
        makeIndexEntry(IDS.F1, '2026-01-01T10:00:00.000Z'),
      ];

      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: null }),
        makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex(entries));
      const logger = makeFakeLogger();

      const throwingGcSweep = vi.fn(() => {
        throw new Error('boom from gc');
      });

      const deps = {
        dropbox: makeFakeDropbox() as unknown as RetentionServiceDeps['dropbox'],
        pluginStore: pluginStore as unknown as RetentionServiceDeps['pluginStore'],
        snapshotIndexStore: snapshotIndexStore as unknown as RetentionServiceDeps['snapshotIndexStore'],
        logger,
        vaultPrefix: VAULT_PREFIX,
        triggerGcSweep: throwingGcSweep,
        now: () => NOW,
      };
      const svc = new RetentionService(deps);

      // Must not throw despite the callback throwing synchronously
      const result = await svc.runIfDue(NOW);

      expect(result.ran).toBe(true);
      const warnCall = logger.warn.mock.calls.find(
        (args: unknown[]) => args[0] === 'gc_sweep_trigger_failed',
      );
      expect(warnCall).toBeDefined();
      expect((warnCall as unknown[])[1]).toMatchObject({ error: 'boom from gc' });
    });

    it('fires triggerGcSweep once after prunes without awaiting', async () => {
      const entries: SnapshotIndexEntry[] = [
        makeIndexEntry(IDS.F1, '2026-01-01T10:00:00.000Z'),
      ];

      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: null }),
        makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex(entries));

      let sweepCallCount = 0;
      // Never-resolving callback — runIfDue must not await it
      const triggerGcSweep = vi.fn(() => {
        sweepCallCount++;
        return new Promise<void>(() => {}); // never resolves
      });

      const svc = makeService({ pluginStore, snapshotIndexStore, triggerGcSweep });

      // Should complete even though callback never resolves
      const result = await svc.runIfDue(NOW);

      expect(result.ran).toBe(true);
      expect(sweepCallCount).toBe(1);
    });

    it('does not fire triggerGcSweep when nothing was pruned (no_op_all_kept)', async () => {
      const recentEntry = makeIndexEntry(IDS.RECENT1, '2026-04-24T11:00:00.000Z');

      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: null }),
        // never_prune_window_days=1 keeps this recent entry
        makeSettings({ never_prune_window_days: 1, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex([recentEntry]));
      const triggerGcSweep = vi.fn();

      const svc = makeService({ pluginStore, snapshotIndexStore, triggerGcSweep });
      const result = await svc.runIfDue(NOW);

      expect(result.state).toBe('no_op_all_kept');
      expect(triggerGcSweep).not.toHaveBeenCalled();
    });
  });

  describe('last_retention_at persistence', () => {
    it('persists last_retention_at after a successful pass', async () => {
      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: null }),
        makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex([]));

      const svc = makeService({ pluginStore, snapshotIndexStore });
      await svc.runIfDue(NOW);

      expect(pluginStore.saveIndexCalls).toHaveLength(1);
      const saved = pluginStore.saveIndexCalls[0];
      expect(saved.last_retention_at).toBe(NOW.toISOString());
    });
  });

  describe('return states', () => {
    it('returns no_op_all_kept when all snapshots pass tier rules', async () => {
      const recentEntry = makeIndexEntry(IDS.RECENT1, '2026-04-24T11:00:00.000Z');

      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: null }),
        makeSettings({ never_prune_window_days: 1, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex([recentEntry]));

      const svc = makeService({ pluginStore, snapshotIndexStore });
      const result = await svc.runIfDue(NOW);

      expect(result.ran).toBe(true);
      expect(result.state).toBe('no_op_all_kept');
      expect(result.pruned_ids).toHaveLength(0);
      expect(result.failed_deletes).toHaveLength(0);
    });

    it('returns pruned state with pruned_ids when some snapshots are removed', async () => {
      const entries: SnapshotIndexEntry[] = [
        makeIndexEntry(IDS.F1, '2026-01-01T10:00:00.000Z'),
        makeIndexEntry(IDS.F2, '2026-01-02T10:00:00.000Z'),
      ];

      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: null }),
        makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex(entries));

      const svc = makeService({ pluginStore, snapshotIndexStore });
      const result = await svc.runIfDue(NOW);

      expect(result.ran).toBe(true);
      expect(result.state).toBe('pruned');
      expect(result.pruned_ids).toHaveLength(2);
      expect(result.pruned_ids.sort()).toEqual([IDS.F1, IDS.F2].sort());
    });

    it('returns all_deletes_failed when every attempted delete fails (pruned_ids is empty)', async () => {
      const entries: SnapshotIndexEntry[] = [
        makeIndexEntry(IDS.F1, '2026-01-01T10:00:00.000Z'),
        makeIndexEntry(IDS.F2, '2026-01-02T10:00:00.000Z'),
      ];

      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: null }),
        makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const dropbox = makeFakeDropbox();
      // All deletes fail
      dropbox.deleteV2 = vi.fn(async () => {
        throw new NetworkError('NETWORK_ERROR', 'timeout', true);
      });

      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex(entries));

      const svc = makeService({ pluginStore, dropbox, snapshotIndexStore });
      const result = await svc.runIfDue(NOW);

      expect(result.ran).toBe(true);
      expect(result.state).toBe('all_deletes_failed');
      expect(result.pruned_ids).toHaveLength(0);
      expect(result.failed_deletes).toHaveLength(2);
      expect(result.failed_deletes.sort()).toEqual([IDS.F1, IDS.F2].sort());
    });
  });

  describe('dryRun', () => {
    it('returns no_op_fresh when local index is missing', async () => {
      const pluginStore = makeFakePluginStore(null);
      const svc = makeService({ pluginStore });

      const result = await svc.dryRun(NOW);

      expect(result.state).toBe('no_op_fresh');
      expect(result.total_snapshots).toBe(0);
      expect(result.would_prune).toEqual([]);
      expect(result.would_keep).toEqual([]);
    });

    it('returns no_op_fresh when the snapshot index has no snapshots', async () => {
      const pluginStore = makeFakePluginStore(makeLocalIndex());
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex([]));
      const svc = makeService({ pluginStore, snapshotIndexStore });

      const result = await svc.dryRun(NOW);

      expect(result.state).toBe('no_op_fresh');
    });

    it('returns no_op_all_kept when retention policy keeps every snapshot', async () => {
      const entries = [
        makeIndexEntry(IDS.RECENT1, '2026-04-24T11:00:00.000Z'),
        makeIndexEntry(IDS.RECENT2, '2026-04-24T10:00:00.000Z'),
      ];
      const pluginStore = makeFakePluginStore(
        makeLocalIndex(),
        // 14-day never-prune window keeps both recent snapshots.
        makeSettings({ never_prune_window_days: 14, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex(entries));
      const svc = makeService({ pluginStore, snapshotIndexStore });

      const result = await svc.dryRun(NOW);

      expect(result.state).toBe('no_op_all_kept');
      expect(result.total_snapshots).toBe(2);
      expect(result.would_prune).toEqual([]);
      expect(result.would_keep.map((r) => r.id).sort()).toEqual([IDS.RECENT1, IDS.RECENT2].sort());
    });

    it('returns evaluated with the would-be-pruned snapshots when policy excludes some', async () => {
      const entries = [
        makeIndexEntry(IDS.F1, '2026-01-01T10:00:00.000Z'),
        makeIndexEntry(IDS.F2, '2026-01-02T10:00:00.000Z'),
        makeIndexEntry(IDS.RECENT1, '2026-04-24T11:00:00.000Z'),
      ];
      const pluginStore = makeFakePluginStore(
        makeLocalIndex(),
        // Disable every tier so only the chain-integrity ancestors survive
        // (F2 is no one's parent, F1 isn't either — both would be pruned).
        makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex(entries));
      const svc = makeService({ pluginStore, snapshotIndexStore });

      const result = await svc.dryRun(NOW);

      expect(result.state).toBe('evaluated');
      expect(result.total_snapshots).toBe(3);
      expect(result.would_prune.length).toBeGreaterThan(0);
      expect(result.would_prune.length + result.would_keep.length).toBe(3);
      // Each row carries id / type / created_at / tier so the UI can format
      // an informative summary without re-reading the snapshot index.
      for (const row of [...result.would_prune, ...result.would_keep]) {
        expect(row.id).toMatch(/^2026-/);
        expect(row.type).toBe('full');
        expect(typeof row.created_at).toBe('string');
        expect(row.tier === null || ['never_prune', 'daily', 'monthly'].includes(row.tier as string)).toBe(true);
      }
    });

    it('does not delete anything from Dropbox even with prune candidates', async () => {
      const entries = [
        makeIndexEntry(IDS.F1, '2026-01-01T10:00:00.000Z'),
        makeIndexEntry(IDS.F2, '2026-01-02T10:00:00.000Z'),
      ];
      const pluginStore = makeFakePluginStore(
        makeLocalIndex(),
        makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex(entries));
      const dropbox = makeFakeDropbox();
      const svc = makeService({ pluginStore, snapshotIndexStore, dropbox });

      await svc.dryRun(NOW);

      expect(dropbox.deleteV2).not.toHaveBeenCalled();
      expect(snapshotIndexStore.removeCalls).toEqual([]);
    });

    it('bypasses the 24h throttle and does not update last_retention_at', async () => {
      const entries = [makeIndexEntry(IDS.RECENT1, '2026-04-24T11:00:00.000Z')];
      // Last retention only 1h ago — runIfDue would skip here, dryRun must not.
      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: ONE_HOUR_AGO.toISOString() }),
        makeSettings({ never_prune_window_days: 14, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex(entries));
      const svc = makeService({ pluginStore, snapshotIndexStore });

      const result = await svc.dryRun(NOW);

      expect(result.state).toBe('no_op_all_kept');
      // last_retention_at must remain untouched so the next scheduled
      // runIfDue is unaffected by a manual dry-run preview.
      expect(pluginStore.saveIndexCalls).toEqual([]);
    });
  });

  describe('runNow', () => {
    it('bypasses the 24h throttle and actually deletes snapshots', async () => {
      const entries = [
        makeIndexEntry(IDS.F1, '2026-01-01T10:00:00.000Z'),
        makeIndexEntry(IDS.F2, '2026-01-02T10:00:00.000Z'),
      ];
      // Last retention only 1h ago — runIfDue would skip, runNow must not.
      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: ONE_HOUR_AGO.toISOString() }),
        makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex(entries));
      const dropbox = makeFakeDropbox();
      const svc = makeService({ pluginStore, snapshotIndexStore, dropbox });

      const result = await svc.runNow(NOW);

      expect(result.ran).toBe(true);
      expect(result.state).toBe('pruned');
      expect(result.pruned_ids.sort()).toEqual([IDS.F1, IDS.F2].sort());
      // Actually deleted on Dropbox — runNow is destructive.
      expect(dropbox.deleteV2).toHaveBeenCalledTimes(2);
      expect(snapshotIndexStore.removeCalls.sort()).toEqual([IDS.F1, IDS.F2].sort());
    });

    it('updates last_retention_at like the regular run', async () => {
      const entries = [makeIndexEntry(IDS.RECENT1, '2026-04-24T11:00:00.000Z')];
      const pluginStore = makeFakePluginStore(
        makeLocalIndex({ last_retention_at: ONE_HOUR_AGO.toISOString() }),
        makeSettings({ never_prune_window_days: 14, recent_hours: 0, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex(entries));
      const svc = makeService({ pluginStore, snapshotIndexStore });

      await svc.runNow(NOW);

      // last_retention_at must be advanced so a subsequent scheduled run is
      // once again throttled (no surprise back-to-back runs).
      expect(pluginStore.saveIndexCalls).toHaveLength(1);
      expect(pluginStore.saveIndexCalls[0].last_retention_at).toBe(NOW.toISOString());
    });

    it('triggers the GC sweep when at least one snapshot was pruned', async () => {
      const entries = [
        makeIndexEntry(IDS.F1, '2026-01-01T10:00:00.000Z'),
        makeIndexEntry(IDS.RECENT1, '2026-04-24T11:00:00.000Z'),
      ];
      const pluginStore = makeFakePluginStore(
        makeLocalIndex(),
        // Recent kept by recent_hours, F1 pruned.
        makeSettings({ never_prune_window_days: 0, recent_hours: 2, daily_days: 0, monthly_years: 0 }),
      );
      const snapshotIndexStore = makeFakeSnapshotIndexStore(makeSnapshotIndex(entries));
      const triggerGcSweep = vi.fn();
      const svc = makeService({ pluginStore, snapshotIndexStore, triggerGcSweep });

      await svc.runNow(NOW);

      expect(triggerGcSweep).toHaveBeenCalledTimes(1);
    });

    it('returns no_op_fresh and does not delete when local index is missing', async () => {
      const pluginStore = makeFakePluginStore(null);
      const dropbox = makeFakeDropbox();
      const svc = makeService({ pluginStore, dropbox });

      const result = await svc.runNow(NOW);

      expect(result.ran).toBe(false);
      expect(result.state).toBe('no_op_fresh');
      expect(dropbox.deleteV2).not.toHaveBeenCalled();
    });
  });
});
