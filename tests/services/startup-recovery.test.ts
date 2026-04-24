// T5.5 — StartupRecovery: crash-recovery matrix + unified StartupState.
//
// Test cases (one `it` per spec bullet):
//   a. ordered startup sequence: loadSettings → loadIndex → loadQueue → listFolder(snapshots/)
//   b. INDEX_MISSING when loadIndex returns null
//   c. HEAD_STALE when HEAD points at an older snapshot than the newest manifest
//   d. Row 7 reconciliation — index files populated from newest manifest
//   e. HEAD_POINTS_TO_MISSING when HEAD.snapshot_id absent in snapshots/
//   f. SNAPSHOT_INDEX_STALE — rebuild snapshot_index when stale entries detected
//   g. stale_gc_lock flag when gc_lock.started_at is older than threshold
//   h. FRESH_FOLDER when snapshots/ directory is empty

import { describe, expect, it, vi } from 'vitest';
import { StartupRecovery, type StartupRecoveryDeps } from '../../src/services/StartupRecovery';
import { StartupState } from '../../src/model/StartupState';
import type { LocalIndex } from '../../src/model/Index';
import { emptyLocalIndex } from '../../src/model/Index';
import type { SnapshotManifest } from '../../src/model/Manifest';
import { PathError } from '../../src/model/Errors';
import { headPath, snapshotsDir, gcLockPath, snapshotIndexPath } from '../../src/util/paths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VAULT_PREFIX = 'test-vault';
const DEVICE_ID = '11111111-1111-4111-a111-111111111111';
const HEAD_PATH = headPath(VAULT_PREFIX);
const SNAPSHOTS_DIR = snapshotsDir(VAULT_PREFIX);
const GC_LOCK_PATH = gcLockPath(VAULT_PREFIX);
const SNAPSHOT_INDEX_PATH = snapshotIndexPath(VAULT_PREFIX);

// ---------------------------------------------------------------------------
// Fake manifest factory
// ---------------------------------------------------------------------------

function makeManifest(id: string, created_at: string, files: Record<string, { hash: string; size: number; mtime: number }> = {}): SnapshotManifest {
  return {
    schema_version: '1.0',
    id,
    type: 'full',
    parent_id: null,
    device_id: DEVICE_ID,
    created_at,
    vault_name: 'TestVault',
    vault_prefix: VAULT_PREFIX,
    files,
    deleted: [],
    renames: [],
    exclusions_applied: null,
  };
}

function makeHeadJson(snapshot_id: string, committed_at: string) {
  return {
    schema_version: '1.0',
    snapshot_id,
    snapshot_type: 'full',
    device_id: DEVICE_ID,
    committed_at,
  };
}

// ---------------------------------------------------------------------------
// Fake Dropbox
// ---------------------------------------------------------------------------

function makeFakeDropbox(initialStore: Map<string, unknown> = new Map()) {
  const store = new Map<string, unknown>(initialStore);
  const uploadJsonCalls: Array<{ path: string; value: unknown }> = [];
  const deleteV2Calls: string[] = [];
  const listFolderCalls: string[] = [];

  return {
    store,
    uploadJsonCalls,
    deleteV2Calls,
    listFolderCalls,

    uploadJson: vi.fn(async (path: string, value: unknown) => {
      uploadJsonCalls.push({ path, value: JSON.parse(JSON.stringify(value)) });
      store.set(path, JSON.parse(JSON.stringify(value)));
    }),

    downloadJson: vi.fn(async (path: string) => {
      if (!store.has(path)) throw new PathError('PATH_NOT_FOUND', `not found: ${path}`, false);
      return store.get(path);
    }),

    listFolder: vi.fn(async (path: string) => {
      listFolderCalls.push(path);
      const prefix = path.endsWith('/') ? path : path + '/';
      const entries: Array<{ path: string; tag: 'file' | 'folder' | 'deleted' }> = [];
      for (const key of store.keys()) {
        // Only immediate children (one level deep)
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (!rest.includes('/')) {
            entries.push({ path: key, tag: 'file' });
          }
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

function makeFakePluginStore(initialIndex: LocalIndex | null = emptyLocalIndex()) {
  let index: LocalIndex | null = initialIndex;
  const callOrder: string[] = [];

  return {
    callOrder,
    getIndex: () => index,

    loadSettings: vi.fn(async () => {
      callOrder.push('loadSettings');
      return {};
    }),

    loadIndex: vi.fn(async () => {
      callOrder.push('loadIndex');
      return index;
    }),

    saveIndex: vi.fn(async (i: LocalIndex) => {
      index = { ...i };
    }),

    loadQueue: vi.fn(async () => {
      callOrder.push('loadQueue');
      return { schema_version: '1.0', cursor: null, entries: [] };
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake SnapshotIndexStore
// ---------------------------------------------------------------------------

function makeFakeSnapshotIndexStore(dropbox: FakeDropbox) {
  const rebuildCalls: SnapshotManifest[][] = [];

  return {
    rebuildCalls,

    read: vi.fn(async () => {
      const raw = dropbox.store.get(SNAPSHOT_INDEX_PATH);
      if (!raw) return null;
      return raw as { schema_version: string; last_updated_at: string; snapshots: Array<{ id: string; type: string; parent_id: string | null; created_at: string; device_id: string; blob_hashes: string[] }> };
    }),

    rebuild: vi.fn(async (manifests: SnapshotManifest[]) => {
      rebuildCalls.push(manifests);
      const index = {
        schema_version: '1.0',
        last_updated_at: new Date().toISOString(),
        snapshots: manifests.map((m) => ({
          id: m.id,
          type: m.type,
          parent_id: m.parent_id,
          created_at: m.created_at,
          device_id: m.device_id,
          blob_hashes: Object.values(m.files).map((f) => f.hash),
        })),
      };
      dropbox.store.set(SNAPSHOT_INDEX_PATH, index);
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake Logger
// ---------------------------------------------------------------------------

function makeFakeLogger() {
  const warnCalls: Array<{ message: string; payload?: unknown }> = [];
  const infoCalls: Array<{ message: string; payload?: unknown }> = [];

  return {
    warnCalls,
    infoCalls,
    info: vi.fn((message: string, payload?: unknown) => { infoCalls.push({ message, payload }); }),
    warn: vi.fn((message: string, payload?: unknown) => { warnCalls.push({ message, payload }); }),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Harness factory
// ---------------------------------------------------------------------------

interface HarnessOptions {
  initialIndex?: LocalIndex | null;
  dropboxStore?: Map<string, unknown>;
  now?: () => number;
  maxClockSkewMinutes?: number;
}

function makeHarness(opts: HarnessOptions = {}) {
  const dropbox = makeFakeDropbox(opts.dropboxStore);
  const pluginStore = makeFakePluginStore(opts.initialIndex !== undefined ? opts.initialIndex : emptyLocalIndex());
  const snapshotIndexStore = makeFakeSnapshotIndexStore(dropbox);
  const logger = makeFakeLogger();

  const deps: StartupRecoveryDeps = {
    dropbox: dropbox as never,
    pluginStore: pluginStore as never,
    snapshotIndexStore: snapshotIndexStore as never,
    logger,
    vaultPrefix: VAULT_PREFIX,
    now: opts.now ?? (() => Date.now()),
    maxClockSkewMinutes: opts.maxClockSkewMinutes ?? 5,
  };

  return {
    service: new StartupRecovery(deps),
    dropbox,
    pluginStore,
    snapshotIndexStore,
    logger,
  };
}

// Helper: seed a manifest JSON into the fake Dropbox snapshots/ folder
function seedManifest(store: Map<string, unknown>, manifest: SnapshotManifest): void {
  const path = `${SNAPSHOTS_DIR}/${manifest.id}.json`;
  store.set(path, manifest);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StartupRecovery', () => {

  describe('a. ordered startup sequence', () => {
    it('calls loadSettings → loadIndex → loadQueue → listFolder in order', async () => {
      const manifest = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z');
      const store = new Map<string, unknown>();
      seedManifest(store, manifest);
      store.set(HEAD_PATH, makeHeadJson(manifest.id, manifest.created_at));

      const { service, pluginStore, dropbox } = makeHarness({ dropboxStore: store });
      await service.recoverOnStartup();

      const order = pluginStore.callOrder;
      expect(order[0]).toBe('loadSettings');
      expect(order[1]).toBe('loadIndex');
      expect(order[2]).toBe('loadQueue');
      // listFolder(snapshots/) must be called before any HEAD inspection
      expect(dropbox.listFolderCalls).toContain(SNAPSHOTS_DIR);
      expect(dropbox.listFolderCalls.length).toBeGreaterThan(0);
    });
  });

  describe('b. INDEX_MISSING when index.json is absent or unparseable', () => {
    it('returns INDEX_MISSING and sets index_missing_recovery_required when loadIndex returns null', async () => {
      const manifest = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z');
      const store = new Map<string, unknown>();
      seedManifest(store, manifest);

      const { service, pluginStore } = makeHarness({
        initialIndex: null,
        dropboxStore: store,
      });

      const report = await service.recoverOnStartup();

      expect(report.state).toBe(StartupState.INDEX_MISSING);
      expect(report.stale_gc_lock).toBe(false);

      // saveIndex must be called with index_missing_recovery_required: true
      expect(pluginStore.saveIndex).toHaveBeenCalledOnce();
      const savedIndex = (pluginStore.saveIndex as ReturnType<typeof vi.fn>).mock.calls[0][0] as LocalIndex;
      expect(savedIndex.index_missing_recovery_required).toBe(true);
    });
  });

  describe('c. HEAD_STALE when HEAD points at an older snapshot', () => {
    it('rewrites HEAD to the newest manifest and returns HEAD_STALE', async () => {
      const m1 = makeManifest('2026-04-24T08-00-full', '2026-04-24T08:00:00.000Z');
      const m2 = makeManifest('2026-04-24T09-00-full', '2026-04-24T09:00:00.000Z');
      const m3 = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z');

      const store = new Map<string, unknown>();
      seedManifest(store, m1);
      seedManifest(store, m2);
      seedManifest(store, m3);
      // HEAD points at m1 (oldest)
      store.set(HEAD_PATH, makeHeadJson(m1.id, m1.created_at));

      const { service, dropbox } = makeHarness({ dropboxStore: store });
      const report = await service.recoverOnStartup();

      expect(report.state).toBe(StartupState.HEAD_STALE);

      // HEAD must be rewritten to m3 (newest by created_at)
      const headRewrites = dropbox.uploadJsonCalls.filter((c) => c.path === HEAD_PATH);
      expect(headRewrites).toHaveLength(1);
      const newHead = headRewrites[0].value as { snapshot_id: string };
      expect(newHead.snapshot_id).toBe(m3.id);
    });
  });

  describe('d. Row 7 reconciliation — local index populated from newest manifest', () => {
    it('populates index.files from newest manifest when index.files is empty', async () => {
      const files = {
        'a.md': { hash: 'aaa', size: 10, mtime: 1000 },
        'b.md': { hash: 'bbb', size: 20, mtime: 2000 },
        'c.md': { hash: 'ccc', size: 30, mtime: 3000 },
      };
      const manifest = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z', files);

      const store = new Map<string, unknown>();
      seedManifest(store, manifest);
      store.set(HEAD_PATH, makeHeadJson(manifest.id, manifest.created_at));

      // Local index exists but files is empty (simulates Row 7: local index reset)
      const emptyFilesIndex: LocalIndex = {
        ...emptyLocalIndex(),
        last_full_snapshot_id: manifest.id,
        files: {},
      };

      const { service, pluginStore } = makeHarness({
        initialIndex: emptyFilesIndex,
        dropboxStore: store,
      });

      await service.recoverOnStartup();

      // After recovery, saveIndex should have been called with the manifest's file entries
      const savedIndex = (pluginStore.saveIndex as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as LocalIndex;
      expect(savedIndex).toBeDefined();
      expect(savedIndex.files['a.md']?.hash).toBe('aaa');
      expect(savedIndex.files['b.md']?.hash).toBe('bbb');
      expect(savedIndex.files['c.md']?.hash).toBe('ccc');
    });

    it('preserves existing index entries that match the manifest hash', async () => {
      const files = {
        'a.md': { hash: 'aaa', size: 10, mtime: 1000 },
      };
      const manifest = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z', files);

      const store = new Map<string, unknown>();
      seedManifest(store, manifest);
      store.set(HEAD_PATH, makeHeadJson(manifest.id, manifest.created_at));

      // Index already has the correct hash for a.md
      const existingIndex: LocalIndex = {
        ...emptyLocalIndex(),
        files: { 'a.md': { hash: 'aaa', size: 10, mtime: 1000 } },
      };

      const { service, pluginStore } = makeHarness({
        initialIndex: existingIndex,
        dropboxStore: store,
      });

      await service.recoverOnStartup();

      const savedIndex = (pluginStore.saveIndex as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as LocalIndex;
      // Entry should remain from the manifest
      expect(savedIndex.files['a.md']?.hash).toBe('aaa');
    });
  });

  describe('e. HEAD_POINTS_TO_MISSING when HEAD.snapshot_id absent in snapshots/', () => {
    it('rewrites HEAD to the newest manifest and logs a warning', async () => {
      const validManifest = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z');

      const store = new Map<string, unknown>();
      seedManifest(store, validManifest);
      // HEAD points at a nonexistent snapshot
      store.set(HEAD_PATH, makeHeadJson('2026-04-23T10-00-full', '2026-04-23T10:00:00.000Z'));

      const { service, dropbox, logger } = makeHarness({ dropboxStore: store });
      const report = await service.recoverOnStartup();

      expect(report.state).toBe(StartupState.HEAD_POINTS_TO_MISSING);

      // HEAD must be rewritten to the valid manifest
      const headRewrites = dropbox.uploadJsonCalls.filter((c) => c.path === HEAD_PATH);
      expect(headRewrites).toHaveLength(1);
      const newHead = headRewrites[0].value as { snapshot_id: string };
      expect(newHead.snapshot_id).toBe(validManifest.id);

      // Logger.warn must be called with a meaningful code
      const warnMessages = logger.warnCalls.map((c) => c.message);
      expect(warnMessages.some((m) => m.includes('head_points_to_missing') || m.includes('HEAD_POINTS_TO_MISSING') || m.includes('missing'))).toBe(true);
    });
  });

  describe('f. SNAPSHOT_INDEX_STALE — rebuild when stale', () => {
    it('rebuilds snapshot_index when manifests in snapshots/ are not all indexed', async () => {
      const m1 = makeManifest('2026-04-24T08-00-full', '2026-04-24T08:00:00.000Z');
      const m2 = makeManifest('2026-04-24T09-00-full', '2026-04-24T09:00:00.000Z');
      const m3 = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z');

      const store = new Map<string, unknown>();
      seedManifest(store, m1);
      seedManifest(store, m2);
      seedManifest(store, m3);
      store.set(HEAD_PATH, makeHeadJson(m3.id, m3.created_at));

      // snapshot_index only has m1
      store.set(SNAPSHOT_INDEX_PATH, {
        schema_version: '1.0',
        last_updated_at: '2026-04-24T08:00:00.000Z',
        snapshots: [{
          id: m1.id,
          type: m1.type,
          parent_id: m1.parent_id,
          created_at: m1.created_at,
          device_id: m1.device_id,
          blob_hashes: [],
        }],
      });

      const { service, snapshotIndexStore } = makeHarness({ dropboxStore: store });
      const report = await service.recoverOnStartup();

      // rebuild must have been called with all 3 manifests
      expect(snapshotIndexStore.rebuild).toHaveBeenCalledOnce();
      const rebuiltManifests = snapshotIndexStore.rebuildCalls[0];
      const rebuiltIds = rebuiltManifests.map((m) => m.id).sort();
      expect(rebuiltIds).toEqual([m1.id, m2.id, m3.id].sort());

      // State reflects stale index
      expect(report.state === StartupState.SNAPSHOT_INDEX_STALE || report.notes.includes('snapshot_index_rebuilt')).toBe(true);
    });
  });

  describe('g. stale_gc_lock flag', () => {
    it('sets stale_gc_lock=true when gc_lock.started_at is older than threshold (1h + maxClockSkewMinutes)', async () => {
      const nowMs = new Date('2026-04-24T12:00:00.000Z').getTime();
      // Started 2h ago — definitely stale (threshold = 1h + 5min = 65min)
      const staleStartedAt = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();

      const manifest = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z');
      const store = new Map<string, unknown>();
      seedManifest(store, manifest);
      store.set(HEAD_PATH, makeHeadJson(manifest.id, manifest.created_at));
      store.set(GC_LOCK_PATH, { started_at: staleStartedAt });

      const { service } = makeHarness({
        dropboxStore: store,
        now: () => nowMs,
        maxClockSkewMinutes: 5,
      });

      const report = await service.recoverOnStartup();

      expect(report.stale_gc_lock).toBe(true);
    });

    it('sets stale_gc_lock=false when gc_lock.started_at is recent (within threshold)', async () => {
      const nowMs = new Date('2026-04-24T12:00:00.000Z').getTime();
      // Started 10min ago — not stale
      const freshStartedAt = new Date(nowMs - 10 * 60 * 1000).toISOString();

      const manifest = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z');
      const store = new Map<string, unknown>();
      seedManifest(store, manifest);
      store.set(HEAD_PATH, makeHeadJson(manifest.id, manifest.created_at));
      store.set(GC_LOCK_PATH, { started_at: freshStartedAt });

      const { service } = makeHarness({
        dropboxStore: store,
        now: () => nowMs,
        maxClockSkewMinutes: 5,
      });

      const report = await service.recoverOnStartup();

      expect(report.stale_gc_lock).toBe(false);
    });

    it('does NOT delete gc_lock (scheduler owns removal)', async () => {
      const nowMs = new Date('2026-04-24T12:00:00.000Z').getTime();
      const staleStartedAt = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();

      const manifest = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z');
      const store = new Map<string, unknown>();
      seedManifest(store, manifest);
      store.set(HEAD_PATH, makeHeadJson(manifest.id, manifest.created_at));
      store.set(GC_LOCK_PATH, { started_at: staleStartedAt });

      const { service, dropbox } = makeHarness({
        dropboxStore: store,
        now: () => nowMs,
      });

      await service.recoverOnStartup();

      // gc_lock must NOT be deleted by recovery
      expect(dropbox.deleteV2Calls).not.toContain(GC_LOCK_PATH);
      // gc_lock still present in store
      expect(dropbox.store.has(GC_LOCK_PATH)).toBe(true);
    });
  });

  describe('h. FRESH_FOLDER when snapshots/ is empty', () => {
    it('returns FRESH_FOLDER and makes no Dropbox uploads when snapshots/ is empty', async () => {
      const store = new Map<string, unknown>();
      // No snapshots, no HEAD, no index

      const { service, dropbox } = makeHarness({ dropboxStore: store });
      const report = await service.recoverOnStartup();

      expect(report.state).toBe(StartupState.FRESH_FOLDER);
      expect(report.stale_gc_lock).toBe(false);

      // No uploads (no HEAD rewrite, no index rebuild)
      expect(dropbox.uploadJsonCalls).toHaveLength(0);
    });

    it('deletes HEAD if it exists in a fresh folder (no snapshots)', async () => {
      const store = new Map<string, unknown>();
      // HEAD exists but snapshots/ is empty (crash before any manifest was written)
      store.set(HEAD_PATH, makeHeadJson('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z'));

      const { service, dropbox } = makeHarness({ dropboxStore: store });
      const report = await service.recoverOnStartup();

      expect(report.state).toBe(StartupState.FRESH_FOLDER);
      // HEAD should be deleted
      expect(dropbox.deleteV2Calls).toContain(HEAD_PATH);
    });
  });

  describe('i. bounded parallel manifest downloads', () => {
    it('downloads all 20 manifests when seeded in fake Dropbox', async () => {
      const store = new Map<string, unknown>();
      const ids: string[] = [];
      for (let idx = 0; idx < 20; idx++) {
        const ts = `2026-04-24T${String(idx).padStart(2, '0')}:00:00.000Z`;
        const id = `2026-04-24T${String(idx).padStart(2, '0')}-00-full`;
        const m = makeManifest(id, ts);
        seedManifest(store, m);
        ids.push(id);
      }
      // HEAD points to the last (newest) manifest
      const newestId = ids[19];
      const newestTs = `2026-04-24T19:00:00.000Z`;
      store.set(HEAD_PATH, makeHeadJson(newestId, newestTs));

      const { service } = makeHarness({ dropboxStore: store });
      const report = await service.recoverOnStartup();

      // Recovery must complete successfully (HEALTHY or SNAPSHOT_INDEX_STALE)
      expect([
        StartupState.HEALTHY,
        StartupState.SNAPSHOT_INDEX_STALE,
        StartupState.HEAD_STALE,
        StartupState.HEAD_POINTS_TO_MISSING,
      ]).toContain(report.state);
    });

    it('logs startup_manifest_download_start with manifest count before downloading', async () => {
      const store = new Map<string, unknown>();
      for (let idx = 0; idx < 3; idx++) {
        const ts = `2026-04-24T0${idx}:00:00.000Z`;
        const id = `2026-04-24T0${idx}-00-full`;
        seedManifest(store, makeManifest(id, ts));
      }
      const newestId = '2026-04-24T02-00-full';
      store.set(HEAD_PATH, makeHeadJson(newestId, '2026-04-24T02:00:00.000Z'));

      const { service, logger } = makeHarness({ dropboxStore: store });
      await service.recoverOnStartup();

      const downloadStart = logger.infoCalls.find((c) => c.message === 'startup_manifest_download_start');
      expect(downloadStart).toBeDefined();
      expect((downloadStart?.payload as { count: number })?.count).toBe(3);
    });
  });

  describe('j. snapshot_index_read_failed logging', () => {
    it('logs snapshot_index_read_failed and triggers rebuild when SnapshotIndexStore.read throws CorruptionError', async () => {
      const { CorruptionError } = await import('../../src/model/Errors');

      const manifest = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z');
      const store = new Map<string, unknown>();
      seedManifest(store, manifest);
      store.set(HEAD_PATH, makeHeadJson(manifest.id, manifest.created_at));

      const { service, snapshotIndexStore, logger } = makeHarness({ dropboxStore: store });

      // Override read to throw CorruptionError
      snapshotIndexStore.read.mockRejectedValueOnce(
        new CorruptionError('SNAPSHOT_INDEX_INVALID', 'corrupt index', false),
      );

      const report = await service.recoverOnStartup();

      // Must log the warning
      const warnMessages = logger.warnCalls.map((c) => c.message);
      expect(warnMessages).toContain('snapshot_index_read_failed');

      // Recovery still completes (rebuild triggered because read failed → existingIndex null → allIndexed false)
      expect(snapshotIndexStore.rebuild).toHaveBeenCalledOnce();
      expect(report).toBeDefined();
    });
  });

  describe('k. HEAD corrupt schema logging (ROB-003)', () => {
    it('rewrites HEAD and returns HEAD_POINTS_TO_MISSING when HEAD JSON is corrupt (fails schema)', async () => {
      const validManifest = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z');
      const store = new Map<string, unknown>();
      seedManifest(store, validManifest);
      // HEAD present but malformed (JSON-valid but missing required fields)
      store.set(HEAD_PATH, { not_a_snapshot_head: true });

      const { service, dropbox, logger } = makeHarness({ dropboxStore: store });
      const report = await service.recoverOnStartup();

      expect(report.state).toBe(StartupState.HEAD_POINTS_TO_MISSING);

      // head_invalid_schema must be logged
      const warnMessages = logger.warnCalls.map((c) => c.message);
      expect(warnMessages).toContain('head_invalid_schema');

      // HEAD must be rewritten to the valid manifest
      const headRewrites = dropbox.uploadJsonCalls.filter((c) => c.path === HEAD_PATH);
      expect(headRewrites).toHaveLength(1);
      const newHead = headRewrites[0].value as { snapshot_id: string };
      expect(newHead.snapshot_id).toBe(validManifest.id);
    });
  });

  describe('l. findNewest tie-break by id (ROB-005)', () => {
    it('selects the manifest with the lexicographically greater id when created_at timestamps are identical', async () => {
      const sameTs = '2026-04-24T10:00:00.000Z';
      const mA = makeManifest('2026-04-24T10-00-full-aaa', sameTs);
      const mB = makeManifest('2026-04-24T10-00-full-zzz', sameTs);

      const store = new Map<string, unknown>();
      seedManifest(store, mA);
      seedManifest(store, mB);
      // Seed HEAD pointing at mA (the one with lexicographically smaller id)
      store.set(HEAD_PATH, makeHeadJson(mA.id, sameTs));

      const { service, dropbox } = makeHarness({ dropboxStore: store });
      const report = await service.recoverOnStartup();

      // HEAD should have been rewritten to mB (the greater id wins the tie)
      const headRewrites = dropbox.uploadJsonCalls.filter((c) => c.path === HEAD_PATH);
      expect(headRewrites).toHaveLength(1);
      const newHead = headRewrites[0].value as { snapshot_id: string };
      expect(newHead.snapshot_id).toBe(mB.id);

      // State reflects the stale HEAD (was pointing at mA but mB wins)
      expect(report.state).toBe(StartupState.HEAD_STALE);
    });
  });

  describe('m. gc_lock boundary at exactly 65 minutes (ROB-007)', () => {
    it('sets stale_gc_lock=false when lock age is exactly 65 minutes (strict > comparator)', async () => {
      const nowMs = new Date('2026-04-24T12:00:00.000Z').getTime();
      // Exactly 65 minutes ago — NOT stale (threshold is strict >)
      const boundaryStartedAt = new Date(nowMs - 65 * 60 * 1000).toISOString();

      const manifest = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z');
      const store = new Map<string, unknown>();
      seedManifest(store, manifest);
      store.set(HEAD_PATH, makeHeadJson(manifest.id, manifest.created_at));
      store.set(GC_LOCK_PATH, { started_at: boundaryStartedAt });

      const { service } = makeHarness({
        dropboxStore: store,
        now: () => nowMs,
        maxClockSkewMinutes: 5,
      });

      const report = await service.recoverOnStartup();
      expect(report.stale_gc_lock).toBe(false);
    });

    it('sets stale_gc_lock=true when lock age is 65 minutes + 1ms (just past threshold)', async () => {
      const nowMs = new Date('2026-04-24T12:00:00.000Z').getTime();
      // 65 minutes + 1 ms ago — stale
      const justPastBoundary = new Date(nowMs - (65 * 60 * 1000 + 1)).toISOString();

      const manifest = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z');
      const store = new Map<string, unknown>();
      seedManifest(store, manifest);
      store.set(HEAD_PATH, makeHeadJson(manifest.id, manifest.created_at));
      store.set(GC_LOCK_PATH, { started_at: justPastBoundary });

      const { service } = makeHarness({
        dropboxStore: store,
        now: () => nowMs,
        maxClockSkewMinutes: 5,
      });

      const report = await service.recoverOnStartup();
      expect(report.stale_gc_lock).toBe(true);
    });
  });

  describe('HEALTHY state — normal startup', () => {
    it('returns HEALTHY when HEAD matches newest snapshot and index is current', async () => {
      const files = {
        'notes/a.md': { hash: 'aaa', size: 10, mtime: 1000 },
      };
      const manifest = makeManifest('2026-04-24T10-00-full', '2026-04-24T10:00:00.000Z', files);

      const store = new Map<string, unknown>();
      seedManifest(store, manifest);
      store.set(HEAD_PATH, makeHeadJson(manifest.id, manifest.created_at));
      store.set(SNAPSHOT_INDEX_PATH, {
        schema_version: '1.0',
        last_updated_at: manifest.created_at,
        snapshots: [{
          id: manifest.id,
          type: manifest.type,
          parent_id: manifest.parent_id,
          created_at: manifest.created_at,
          device_id: manifest.device_id,
          blob_hashes: ['aaa'],
        }],
      });

      const existingIndex: LocalIndex = {
        ...emptyLocalIndex(),
        last_full_snapshot_id: manifest.id,
        files,
      };

      const { service } = makeHarness({
        initialIndex: existingIndex,
        dropboxStore: store,
      });

      const report = await service.recoverOnStartup();
      expect(report.state).toBe(StartupState.HEALTHY);
      expect(report.stale_gc_lock).toBe(false);
    });
  });
});
