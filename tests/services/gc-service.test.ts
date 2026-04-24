// T6.4 — GCService: orphan blob sweep with gc_lock + ordering + age-gate.
//
// Test cases:
//   1. happy path — 10 referenced, 15 total, 5 orphans → exactly 5 deletes
//   2. fresh lock (within threshold) → skipped_locked with blocking_lock payload
//   3. stale lock (past threshold) → sweeps; info log gc_lock_stale
//   4. corrupt lock (schema-invalid) → warn gc_lock_invalid; sweeps; new lock written
//   5. ordering (ROB-012) — snapshotIndex read strictly before content listFolder
//   6. age gate — orphan inside skew window → NOT deleted; skipped_age_gate === 1
//   7. scale — 5k blobs, 4k referenced → exactly 1k deleted
//   8. defensive abort on index read failure → skipped_no_index; lock removed; 0 deletes
//   9. exactly-threshold lock → strict > means NOT stale → skipped_locked
//  10. delete failure mid-loop — NetworkError on one delete → loop continues

import { describe, expect, it, vi } from 'vitest';
import { GCService, type GCServiceDeps } from '../../src/services/GCService';
import { PathError, NetworkError, CorruptionError } from '../../src/model/Errors';
import { gcLockPath, contentFolderPath } from '../../src/util/paths';
import type { ListFolderEntry } from '../../src/infra/DropboxClient';
import type { SnapshotIndex } from '../../src/model/SnapshotIndex';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VAULT_PREFIX = 'test-vault';
const DEVICE_ID = 'aaaa-bbbb-cccc-dddd';
const GC_LOCK = gcLockPath(VAULT_PREFIX);
const CONTENT_FOLDER = contentFolderPath(VAULT_PREFIX);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generates a deterministic 64-char lowercase hex hash from a seed string. */
function makeHash(seed: string): string {
  return seed.padStart(64, '0').slice(0, 64);
}

/** Produces a valid ListFolderEntry for a content blob. */
function makeContentEntry(hash: string, server_modified: string): ListFolderEntry {
  const bucket = hash.slice(0, 2);
  return {
    tag: 'file',
    path: `${CONTENT_FOLDER}/${bucket}/${hash}`,
    server_modified,
  };
}

/** Builds a SnapshotIndex with the given array of blob_hashes arrays. */
function makeSnapshotIndex(blobHashArrays: string[][]): SnapshotIndex {
  return {
    schema_version: '1.0',
    last_updated_at: '2026-04-24T10:00:00.000Z',
    snapshots: blobHashArrays.map((hashes, i) => ({
      id: `snap-${i}`,
      type: 'full' as const,
      parent_id: null,
      created_at: '2026-04-24T10:00:00.000Z',
      device_id: DEVICE_ID,
      blob_hashes: hashes,
    })),
  };
}

// ---------------------------------------------------------------------------
// Fake Dropbox — tracks call order for ordering test
// ---------------------------------------------------------------------------

interface FakeDropboxOptions {
  /** Pre-seeded gc_lock JSON value (or undefined for no lock) */
  gcLock?: unknown;
  /** Content blob entries returned by listFolder */
  contentEntries?: ListFolderEntry[];
  /** Which blob paths should fail on deleteV2 */
  deleteFailPaths?: Set<string>;
}

function makeFakeDropbox(opts: FakeDropboxOptions = {}) {
  const store = new Map<string, unknown>();
  if (opts.gcLock !== undefined) store.set(GC_LOCK, opts.gcLock);

  const callOrder: string[] = [];
  const uploadJsonCalls: Array<{ path: string; value: unknown }> = [];
  const deleteV2Calls: string[] = [];
  const contentEntries = opts.contentEntries ?? [];
  const deleteFailPaths = opts.deleteFailPaths ?? new Set<string>();

  return {
    store,
    callOrder,
    uploadJsonCalls,
    deleteV2Calls,

    uploadJson: vi.fn(async (path: string, value: unknown) => {
      callOrder.push(`uploadJson:${path}`);
      uploadJsonCalls.push({ path, value: JSON.parse(JSON.stringify(value)) });
      store.set(path, JSON.parse(JSON.stringify(value)));
    }),

    downloadJson: vi.fn(async (path: string) => {
      callOrder.push(`downloadJson:${path}`);
      if (!store.has(path)) throw new PathError('PATH_NOT_FOUND', `not found: ${path}`, false);
      return store.get(path);
    }),

    listFolder: vi.fn(async (path: string) => {
      callOrder.push(`listFolder:${path}`);
      if (path === CONTENT_FOLDER || path.startsWith(CONTENT_FOLDER)) {
        return contentEntries;
      }
      return [];
    }),

    deleteV2: vi.fn(async (path: string) => {
      callOrder.push(`deleteV2:${path}`);
      if (deleteFailPaths.has(path)) {
        throw new NetworkError('NETWORK_ERROR', `delete failed: ${path}`, true);
      }
      deleteV2Calls.push(path);
      store.delete(path);
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake SnapshotIndexStore
// ---------------------------------------------------------------------------

function makeFakeSnapshotIndexStore(index: SnapshotIndex | null | 'throw') {
  return {
    read: vi.fn(async (): Promise<SnapshotIndex | null> => {
      if (index === 'throw') {
        throw new CorruptionError('SNAPSHOT_INDEX_INVALID', 'corrupt index', false);
      }
      return index;
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake Logger
// ---------------------------------------------------------------------------

function makeFakeLogger() {
  const warnCalls: Array<{ message: string; payload?: unknown }> = [];
  const infoCalls: Array<{ message: string; payload?: unknown }> = [];
  const errorCalls: Array<{ message: string; payload?: unknown }> = [];

  return {
    warnCalls,
    infoCalls,
    errorCalls,
    info: vi.fn((message: string, payload?: unknown) => { infoCalls.push({ message, payload }); }),
    warn: vi.fn((message: string, payload?: unknown) => { warnCalls.push({ message, payload }); }),
    error: vi.fn((message: string, payload?: unknown) => { errorCalls.push({ message, payload }); }),
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  gcLock?: unknown;
  contentEntries?: ListFolderEntry[];
  snapshotIndex?: SnapshotIndex | null | 'throw';
  deleteFailPaths?: Set<string>;
  nowDate?: Date;
  maxClockSkewMinutes?: number;
}

function makeHarness(opts: HarnessOptions = {}) {
  const nowDate = opts.nowDate ?? new Date('2026-04-24T12:00:00.000Z');
  const dropbox = makeFakeDropbox({
    gcLock: opts.gcLock,
    contentEntries: opts.contentEntries,
    deleteFailPaths: opts.deleteFailPaths,
  });
  const snapshotIndexStore = makeFakeSnapshotIndexStore(opts.snapshotIndex ?? null);
  const logger = makeFakeLogger();

  const deps: GCServiceDeps = {
    dropbox: dropbox as never,
    snapshotIndexStore: snapshotIndexStore as never,
    logger,
    vaultPrefix: VAULT_PREFIX,
    deviceId: DEVICE_ID,
    now: () => nowDate,
    maxClockSkewMinutes: opts.maxClockSkewMinutes ?? 5,
  };

  return {
    service: new GCService(deps),
    dropbox,
    snapshotIndexStore,
    logger,
    nowDate,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GCService', () => {

  describe('1. happy path — 10 referenced, 15 total, 5 orphans → exactly 5 deletes', () => {
    it('deletes exactly the unreferenced blobs and removes gc_lock', async () => {
      const referencedHashes = Array.from({ length: 10 }, (_, i) => makeHash(`ref${i}`));
      const orphanHashes = Array.from({ length: 5 }, (_, i) => makeHash(`orphan${i}`));
      const allHashes = [...referencedHashes, ...orphanHashes];

      const nowDate = new Date('2026-04-24T12:00:00.000Z');
      const oldModified = new Date(nowDate.getTime() - 60 * 60 * 1000).toISOString(); // 1h before now

      const contentEntries = allHashes.map((h) => makeContentEntry(h, oldModified));
      const snapshotIndex = makeSnapshotIndex([referencedHashes.slice(0, 5), referencedHashes.slice(5)]);

      const { service, dropbox } = makeHarness({
        contentEntries,
        snapshotIndex,
        nowDate,
      });

      const result = await service.sweep();

      expect(result.state).toBe('swept');
      expect(result.deleted).toHaveLength(5);
      expect(result.kept_count).toBe(10);
      expect(result.skipped_age_gate).toBe(0);

      // Verify exactly the orphan paths were deleted
      const deletedPaths = new Set(result.deleted);
      for (const h of orphanHashes) {
        const entry = makeContentEntry(h, oldModified);
        expect(deletedPaths.has(entry.path)).toBe(true);
      }
      for (const h of referencedHashes) {
        const entry = makeContentEntry(h, oldModified);
        expect(deletedPaths.has(entry.path)).toBe(false);
      }

      // gc_lock written then removed
      const lockWrites = dropbox.uploadJsonCalls.filter((c) => c.path === GC_LOCK);
      expect(lockWrites).toHaveLength(1);
      expect(dropbox.deleteV2Calls).toContain(GC_LOCK);
      expect(dropbox.store.has(GC_LOCK)).toBe(false);
    });
  });

  describe('2. fresh lock (within threshold) → skipped_locked', () => {
    it('returns skipped_locked with blocking_lock payload; no new lock written; no deletes', async () => {
      const nowDate = new Date('2026-04-24T12:00:00.000Z');
      // 10 minutes ago — well within 65min threshold
      const freshStartedAt = new Date(nowDate.getTime() - 10 * 60 * 1000).toISOString();
      const existingLock = { schema_version: '1.0', started_at: freshStartedAt, device_id: 'other-device' };

      const { service, dropbox, snapshotIndexStore } = makeHarness({
        gcLock: existingLock,
        nowDate,
      });

      const result = await service.sweep();

      expect(result.state).toBe('skipped_locked');
      expect(result.deleted).toHaveLength(0);
      expect(result.kept_count).toBe(0);
      expect(result.skipped_age_gate).toBe(0);
      expect(result.blocking_lock).toBeDefined();
      expect(result.blocking_lock!.started_at).toBe(freshStartedAt);
      expect(result.blocking_lock!.device_id).toBe('other-device');
      expect(result.blocking_lock!.age_ms).toBeGreaterThan(0);

      // snapshot_index must NOT be read
      expect(snapshotIndexStore.read).not.toHaveBeenCalled();

      // No new lock written
      const lockWrites = dropbox.uploadJsonCalls.filter((c) => c.path === GC_LOCK);
      expect(lockWrites).toHaveLength(0);

      // No deletes at all
      expect(dropbox.deleteV2Calls).toHaveLength(0);
    });
  });

  describe('3. stale lock (past threshold) → sweep proceeds', () => {
    it('logs gc_lock_stale, overwrites lock, and sweeps', async () => {
      const nowDate = new Date('2026-04-24T12:00:00.000Z');
      // 2 hours ago — past 65min threshold
      const staleStartedAt = new Date(nowDate.getTime() - 2 * 60 * 60 * 1000).toISOString();
      const existingLock = { schema_version: '1.0', started_at: staleStartedAt, device_id: 'other-device' };

      const { service, dropbox, logger } = makeHarness({
        gcLock: existingLock,
        snapshotIndex: makeSnapshotIndex([]),
        nowDate,
      });

      const result = await service.sweep();

      expect(result.state).toBe('swept');

      // gc_lock_stale must be logged
      const infoMessages = logger.infoCalls.map((c) => c.message);
      expect(infoMessages).toContain('gc_lock_stale');

      // New lock must be written (overwrites old)
      const lockWrites = dropbox.uploadJsonCalls.filter((c) => c.path === GC_LOCK);
      expect(lockWrites).toHaveLength(1);
    });
  });

  describe('4. corrupt lock (schema-invalid) → warn gc_lock_invalid; sweeps', () => {
    it('logs gc_lock_invalid, overwrites lock, and sweeps', async () => {
      const existingLock = { not_a_lock: true };

      const { service, dropbox, logger } = makeHarness({
        gcLock: existingLock,
        snapshotIndex: makeSnapshotIndex([]),
      });

      const result = await service.sweep();

      expect(result.state).toBe('swept');

      // gc_lock_invalid must be warned
      const warnMessages = logger.warnCalls.map((c) => c.message);
      expect(warnMessages).toContain('gc_lock_invalid');

      // New lock written
      const lockWrites = dropbox.uploadJsonCalls.filter((c) => c.path === GC_LOCK);
      expect(lockWrites).toHaveLength(1);
    });
  });

  describe('5. ordering (ROB-012) — index read strictly before content listFolder', () => {
    it('reads snapshot_index BEFORE listing content/', async () => {
      const sharedCallOrder: string[] = [];

      const nowDate = new Date('2026-04-24T12:00:00.000Z');
      const dropbox = makeFakeDropbox({ contentEntries: [] });
      // Wrap listFolder to record order in the shared log
      const origListFolder = dropbox.listFolder;
      dropbox.listFolder = vi.fn(async (path: string) => {
        sharedCallOrder.push(`listFolder:${path}`);
        return origListFolder(path);
      });

      const snapshotIndex = makeSnapshotIndex([]);
      const snapshotIndexStore = {
        read: vi.fn(async () => {
          sharedCallOrder.push('snapshotIndexStore.read');
          return snapshotIndex;
        }),
      };
      const logger = makeFakeLogger();

      const deps: GCServiceDeps = {
        dropbox: dropbox as never,
        snapshotIndexStore: snapshotIndexStore as never,
        logger,
        vaultPrefix: VAULT_PREFIX,
        deviceId: DEVICE_ID,
        now: () => nowDate,
        maxClockSkewMinutes: 5,
      };

      const service = new GCService(deps);
      await service.sweep();

      const indexPos = sharedCallOrder.indexOf('snapshotIndexStore.read');
      const listPos = sharedCallOrder.findIndex((e) => e.startsWith('listFolder:'));

      expect(indexPos).toBeGreaterThanOrEqual(0);
      expect(listPos).toBeGreaterThanOrEqual(0);
      expect(indexPos).toBeLessThan(listPos);
    });
  });

  describe('6. age gate — orphan inside skew window → NOT deleted', () => {
    it('skips a blob whose server_modified is within maxClockSkewMinutes of started_at', async () => {
      const nowDate = new Date('2026-04-24T12:00:00.000Z');
      // server_modified is started_at + 1 second (well inside 5min default skew)
      const ageGatedModified = new Date(nowDate.getTime() + 1000).toISOString();
      const orphanHash = makeHash('age-gated-orphan');
      const contentEntries = [makeContentEntry(orphanHash, ageGatedModified)];

      // No referenced hashes — orphan would be deleted if not for age gate
      const { service, dropbox } = makeHarness({
        contentEntries,
        snapshotIndex: makeSnapshotIndex([]),
        nowDate,
      });

      const result = await service.sweep();

      expect(result.state).toBe('swept');
      expect(result.deleted).toHaveLength(0);
      expect(result.skipped_age_gate).toBe(1);

      // The orphan blob must NOT be deleted
      expect(dropbox.deleteV2Calls).not.toContain(makeContentEntry(orphanHash, ageGatedModified).path);
    });
  });

  describe('7. scale — 5k blobs, 4k referenced → exactly 1k deleted', () => {
    it('deletes exactly 1k orphans from 5k total blobs', async () => {
      const nowDate = new Date('2026-04-24T12:00:00.000Z');
      const oldModified = new Date(nowDate.getTime() - 60 * 60 * 1000).toISOString();

      const referencedHashes = Array.from({ length: 4000 }, (_, i) =>
        makeHash(`ref${String(i).padStart(6, '0')}`),
      );
      const orphanHashes = Array.from({ length: 1000 }, (_, i) =>
        makeHash(`orp${String(i).padStart(6, '0')}`),
      );

      const contentEntries = [...referencedHashes, ...orphanHashes].map((h) =>
        makeContentEntry(h, oldModified),
      );
      const snapshotIndex = makeSnapshotIndex([referencedHashes]);

      const { service } = makeHarness({
        contentEntries,
        snapshotIndex,
        nowDate,
      });

      const result = await service.sweep();

      expect(result.state).toBe('swept');
      expect(result.deleted).toHaveLength(1000);
      expect(result.kept_count).toBe(4000);
      expect(result.skipped_age_gate).toBe(0);
    });
  });

  describe('8. defensive abort on index read failure → skipped_no_index', () => {
    it('aborts sweep, removes lock, logs gc_aborted_no_index, and returns 0 deletes', async () => {
      const { service, dropbox, logger } = makeHarness({
        snapshotIndex: 'throw',
      });

      const result = await service.sweep();

      expect(result.state).toBe('skipped_no_index');
      expect(result.deleted).toHaveLength(0);

      // Lock written then removed
      const lockWrites = dropbox.uploadJsonCalls.filter((c) => c.path === GC_LOCK);
      expect(lockWrites).toHaveLength(1);
      expect(dropbox.deleteV2Calls).toContain(GC_LOCK);

      // Warning logged
      const warnMessages = logger.warnCalls.map((c) => c.message);
      expect(warnMessages).toContain('gc_aborted_no_index');

      // No content blobs deleted
      const contentDeletes = dropbox.deleteV2Calls.filter((p) => p.startsWith(CONTENT_FOLDER));
      expect(contentDeletes).toHaveLength(0);
    });
  });

  describe('9. exactly-threshold lock → strict > boundary → skipped_locked', () => {
    it('returns skipped_locked when lock age equals exactly (60 + maxClockSkewMinutes) * 60 * 1000 ms', async () => {
      const maxClockSkewMinutes = 5;
      const nowDate = new Date('2026-04-24T12:00:00.000Z');
      // Exactly at threshold boundary
      const thresholdMs = (60 + maxClockSkewMinutes) * 60 * 1000;
      const exactBoundaryStartedAt = new Date(nowDate.getTime() - thresholdMs).toISOString();
      const existingLock = { schema_version: '1.0', started_at: exactBoundaryStartedAt, device_id: 'other-device' };

      const { service } = makeHarness({
        gcLock: existingLock,
        nowDate,
        maxClockSkewMinutes,
      });

      const result = await service.sweep();

      // Strict > means exactly-threshold is NOT stale → skipped_locked
      expect(result.state).toBe('skipped_locked');
    });
  });

  describe('10. delete failure mid-loop → loop continues', () => {
    it('continues deleting remaining orphans when one deleteV2 throws NetworkError', async () => {
      const nowDate = new Date('2026-04-24T12:00:00.000Z');
      const oldModified = new Date(nowDate.getTime() - 60 * 60 * 1000).toISOString();

      const orphan1 = makeHash('orphan-fail-0000000000000000000000000000000000000000000000000000000000');
      const orphan2 = makeHash('orphan-ok-00000000000000000000000000000000000000000000000000000000000');
      const orphan3 = makeHash('orphan-ok2-0000000000000000000000000000000000000000000000000000000000');

      const contentEntries = [
        makeContentEntry(orphan1, oldModified),
        makeContentEntry(orphan2, oldModified),
        makeContentEntry(orphan3, oldModified),
      ];

      const failPath = makeContentEntry(orphan1, oldModified).path;
      const deleteFailPaths = new Set([failPath]);

      const { service } = makeHarness({
        contentEntries,
        snapshotIndex: makeSnapshotIndex([]), // no referenced hashes
        deleteFailPaths,
        nowDate,
      });

      const result = await service.sweep();

      expect(result.state).toBe('swept');
      // orphan1 fails → NOT in deleted
      expect(result.deleted).not.toContain(failPath);
      // orphan2 and orphan3 should be deleted
      expect(result.deleted).toHaveLength(2);
    });
  });

});
