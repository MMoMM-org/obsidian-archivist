// T5.3 — BackupService.runFull(): 7-step crash-safe commit protocol.
//
// Test scenarios:
//   1. 100-file vault: 100 blobs uploaded, manifest written, snapshot_index appended, HEAD written, LocalIndex + queue advanced
//   2. Dedup: two calls on unchanged vault → 2 snapshots, 0 new blobs on 2nd call
//   3. Double-check (ROB-001): verifyNoConflict called twice; conflict on 2nd call aborts before manifest write
//   4. Adaptive chunk size (PERF-M2): <50 MB → 8 MB chunks, ≥50 MB → 150 MB chunks
//   5. Crash between blob upload and manifest write: orphan blobs on Dropbox, no manifest
//   6. Crash between manifest write and snapshot_index update: manifest on Dropbox, snapshot_index untouched
//   7. Crash between snapshot_index update and HEAD write: index updated, HEAD still at prior snapshot

import { describe, expect, it, vi } from 'vitest';
import { BackupService, type BackupServiceDeps } from '../../src/services/BackupService';
import { ConflictError } from '../../src/model/Errors';
import type { PluginSettings } from '../../src/model/Settings';
import { DEFAULT_SETTINGS } from '../../src/model/Settings';
import type { LocalIndex } from '../../src/model/Index';
import { emptyLocalIndex } from '../../src/model/Index';
import type { EventQueue } from '../../src/model/QueueEntry';
import { emptyEventQueue } from '../../src/model/QueueEntry';
import { headPath, snapshotIndexPath } from '../../src/util/paths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VAULT_PREFIX = 'test-vault';
const VAULT_NAME = 'TestVault';
const DEVICE_ID = '11111111-1111-4111-a111-111111111111';
const HEAD_PATH = headPath(VAULT_PREFIX);
const SNAPSHOT_INDEX_PATH = snapshotIndexPath(VAULT_PREFIX);

// ---------------------------------------------------------------------------
// Fake Dropbox
// ---------------------------------------------------------------------------

type UploadLargeOpts = { mode?: string; chunkBytes?: number };

function makeFakeDropbox() {
  const store = new Map<string, unknown>();
  const uploadLargeCalls: Array<{ path: string; size: number; chunkBytes: number }> = [];

  return {
    store,
    uploadLargeCalls,

    uploadBlob: vi.fn(async (path: string, bytes: Uint8Array) => {
      store.set(path, bytes);
    }),

    uploadJson: vi.fn(async (path: string, value: unknown) => {
      store.set(path, JSON.parse(JSON.stringify(value)));
    }),

    downloadJson: vi.fn(async (path: string) => {
      const { PathError } = await import('../../src/model/Errors');
      if (!store.has(path)) throw new PathError('PATH_NOT_FOUND', `not found: ${path}`, false);
      return store.get(path);
    }),

    uploadLarge: vi.fn(async (path: string, bytes: Uint8Array, opts?: UploadLargeOpts) => {
      const chunkBytes = opts?.chunkBytes ?? (8 * 1024 * 1024);
      uploadLargeCalls.push({ path, size: bytes.length, chunkBytes });
      store.set(path, bytes);
    }),
  };
}

type FakeDropbox = ReturnType<typeof makeFakeDropbox>;

// ---------------------------------------------------------------------------
// Fake Vault
// ---------------------------------------------------------------------------

function makeFakeVault(files: Map<string, Uint8Array>) {
  return {
    getFiles: vi.fn(() =>
      Array.from(files.entries()).map(([path, bytes]) => ({
        path,
        mtime: 1000,
        size: bytes.length,
      })),
    ),
    readBytes: vi.fn(async (path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`FakeVault: file not found: ${path}`);
      return bytes;
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake Hasher
// ---------------------------------------------------------------------------

async function fakeHasher(bytes: Uint8Array): Promise<string> {
  const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    const h = view[i].toString(16);
    out += h.length === 1 ? '0' + h : h;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fake DeviceCoordinator
// ---------------------------------------------------------------------------

function makeFakeDeviceCoordinator(opts?: { conflictOnCall?: number }) {
  let callCount = 0;
  return {
    verifyNoConflict: vi.fn(async () => {
      callCount++;
      if (opts?.conflictOnCall !== undefined && callCount >= opts.conflictOnCall) {
        throw new ConflictError(
          'DEVICE_CONFLICT',
          `Another device committed (call ${callCount})`,
          false,
        );
      }
    }),
    getOrCreateDeviceId: vi.fn(async () => DEVICE_ID),
  };
}

// ---------------------------------------------------------------------------
// Fake PluginStore
// ---------------------------------------------------------------------------

function makeFakePluginStore(
  initialIndex?: Partial<LocalIndex>,
  settingsOverrides?: Partial<PluginSettings['advanced']>,
) {
  let index: LocalIndex = { ...emptyLocalIndex(), ...initialIndex };
  let queue: EventQueue = { ...emptyEventQueue() };
  const settings: PluginSettings = {
    ...DEFAULT_SETTINGS,
    advanced: {
      ...DEFAULT_SETTINGS.advanced,
      vault_prefix: VAULT_PREFIX,
      ...settingsOverrides,
    },
  };

  return {
    getIndex: () => index,
    getQueue: () => queue,
    loadIndex: vi.fn(async () => index),
    saveIndex: vi.fn(async (i: LocalIndex) => { index = { ...i }; }),
    loadQueue: vi.fn(async () => queue),
    saveQueue: vi.fn(async (q: EventQueue) => { queue = { ...q }; }),
    loadSettings: vi.fn(async () => settings),
  };
}

// ---------------------------------------------------------------------------
// Fake SnapshotIndexStore
// ---------------------------------------------------------------------------

function makeFakeSnapshotIndexStore(dropbox: FakeDropbox) {
  return {
    append: vi.fn(async (entry: unknown) => {
      const raw = dropbox.store.get(SNAPSHOT_INDEX_PATH) as
        | { schema_version: string; last_updated_at: string; snapshots: unknown[] }
        | undefined;
      const current = raw ?? {
        schema_version: '1.0',
        last_updated_at: new Date().toISOString(),
        snapshots: [],
      };
      current.snapshots.push(entry);
      current.last_updated_at = new Date().toISOString();
      dropbox.store.set(SNAPSHOT_INDEX_PATH, JSON.parse(JSON.stringify(current)));
    }),
  };
}

// ---------------------------------------------------------------------------
// Test harness factory
// ---------------------------------------------------------------------------

function makeHarness(
  vaultFiles: Map<string, Uint8Array>,
  opts: {
    dropbox?: FakeDropbox;
    conflictOnCall?: number;
    settingsOverrides?: Partial<PluginSettings['advanced']>;
    initialIndex?: Partial<LocalIndex>;
    now?: () => string;
    snapshotIndexStore?: ReturnType<typeof makeFakeSnapshotIndexStore>;
  } = {},
) {
  const dropbox = opts.dropbox ?? makeFakeDropbox();
  const vault = makeFakeVault(vaultFiles);
  const coordinator = makeFakeDeviceCoordinator({ conflictOnCall: opts.conflictOnCall });
  const pluginStore = makeFakePluginStore(opts.initialIndex, opts.settingsOverrides);
  const snapshotIndexStore = opts.snapshotIndexStore ?? makeFakeSnapshotIndexStore(dropbox);

  const deps: BackupServiceDeps = {
    dropbox: dropbox as never,
    vault: vault as never,
    hasher: fakeHasher,
    deviceCoordinator: coordinator as never,
    pluginStore: pluginStore as never,
    snapshotIndexStore: snapshotIndexStore as never,
    vaultPrefix: VAULT_PREFIX,
    vaultName: VAULT_NAME,
    now: opts.now ?? (() => '2026-04-24T10:00:00.000Z'),
  };

  return {
    service: new BackupService(deps),
    dropbox,
    vault,
    coordinator,
    pluginStore,
    snapshotIndexStore,
  };
}

function makeVaultFiles(n: number): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (let i = 0; i < n; i++) {
    map.set(`notes/file-${i}.md`, new TextEncoder().encode(`file-${i}`));
  }
  return map;
}

function getContentPaths(store: Map<string, unknown>): string[] {
  return Array.from(store.keys()).filter((p) => p.includes('/content/'));
}

function getManifestPaths(store: Map<string, unknown>): string[] {
  return Array.from(store.keys()).filter((p) => p.includes('/snapshots/'));
}

// ---------------------------------------------------------------------------
// Tests: 100-file full backup
// ---------------------------------------------------------------------------

describe('BackupService.runFull — 100-file vault', () => {
  it('uploads exactly 100 distinct blobs, writes manifest, appends snapshot_index, writes HEAD, advances LocalIndex and queue', async () => {
    const { service, dropbox, pluginStore } = makeHarness(makeVaultFiles(100));

    await service.runFull();

    // 100 unique hashes (all file content is distinct)
    const contentPaths = getContentPaths(dropbox.store);
    expect(contentPaths).toHaveLength(100);

    // Manifest written with type='full' and 100 files
    const manifestPaths = getManifestPaths(dropbox.store);
    expect(manifestPaths).toHaveLength(1);
    const manifest = dropbox.store.get(manifestPaths[0]) as Record<string, unknown>;
    expect(manifest.type).toBe('full');
    expect(Object.keys(manifest.files as object)).toHaveLength(100);

    // snapshot_index has one entry
    const idx = dropbox.store.get(SNAPSHOT_INDEX_PATH) as { snapshots: unknown[] } | undefined;
    expect(idx?.snapshots).toHaveLength(1);

    // HEAD written with correct fields
    const head = dropbox.store.get(HEAD_PATH) as Record<string, unknown> | undefined;
    expect(head?.schema_version).toBe('1.0');
    expect(head?.snapshot_type).toBe('full');
    expect(head?.device_id).toBe(DEVICE_ID);

    // LocalIndex updated
    const idx2 = pluginStore.getIndex();
    expect(idx2.last_full_snapshot_id).not.toBeNull();
    expect(idx2.last_full_commit_at).not.toBeNull();
    expect(Object.keys(idx2.files)).toHaveLength(100);

    // Queue cursor advanced
    expect(pluginStore.getQueue().committed_through).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: CAS dedup
// ---------------------------------------------------------------------------

describe('BackupService.runFull — CAS dedup', () => {
  it('second call on unchanged vault adds 0 new blob objects to content-addressed storage (CAS idempotent overwrite)', async () => {
    const vaultFiles = makeVaultFiles(5);
    let tick = 0;
    const timestamps = [
      '2026-04-24T10:00:00.000Z',
      '2026-04-24T11:00:00.000Z',
    ];
    const { service, dropbox } = makeHarness(vaultFiles, {
      now: () => timestamps[Math.min(tick++, 1)],
    });

    await service.runFull();
    tick = 1;
    const blobCountAfterFirst = getContentPaths(dropbox.store).length;

    await service.runFull();
    const blobCountAfterSecond = getContentPaths(dropbox.store).length;

    // Idempotent overwrite per ADR-3: the second run still issues uploadLarge calls,
    // but they land on the same content-hash paths, so the set of distinct blob objects
    // in storage does not grow. Test asserts the storage-level invariant, not the API
    // call count.
    expect(blobCountAfterSecond).toBe(blobCountAfterFirst);
    expect(blobCountAfterFirst).toBe(5);
    // The second run re-issues uploadLarge for all 5 blobs (idempotent overwrite at the
    // storage layer — dedup is at content-hash level per ADR-3, not at the API-call level).
    expect(dropbox.uploadLargeCalls.length).toBe(2 * 5);

    // Two distinct snapshots in index
    const idx = dropbox.store.get(SNAPSHOT_INDEX_PATH) as { snapshots: unknown[] };
    expect(idx.snapshots).toHaveLength(2);
  });

  it('two files with identical content produce exactly 1 blob', async () => {
    const sameContent = new TextEncoder().encode('identical content');
    const vaultFiles = new Map([
      ['notes/a.md', sameContent],
      ['notes/b.md', sameContent],
    ]);
    const { service, dropbox } = makeHarness(vaultFiles);

    await service.runFull();

    const contentPaths = getContentPaths(dropbox.store);
    expect(contentPaths).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: ROB-001 double-check
// ---------------------------------------------------------------------------

describe('BackupService.runFull — ROB-001 double-check', () => {
  it('calls verifyNoConflict exactly twice per runFull', async () => {
    const { service, coordinator } = makeHarness(makeVaultFiles(3));

    await service.runFull();

    expect(coordinator.verifyNoConflict).toHaveBeenCalledTimes(2);
  });

  it('conflict on second call aborts before manifest write — orphan blobs exist, HEAD absent', async () => {
    const { service, dropbox } = makeHarness(makeVaultFiles(3), { conflictOnCall: 2 });

    await expect(service.runFull()).rejects.toThrow(ConflictError);

    // Orphan blobs uploaded (step 1 completed)
    expect(getContentPaths(dropbox.store).length).toBeGreaterThan(0);

    // No manifest written
    expect(getManifestPaths(dropbox.store)).toHaveLength(0);

    // HEAD absent
    expect(dropbox.store.has(HEAD_PATH)).toBe(false);
  });

  it('conflict on first call aborts before any blobs are uploaded', async () => {
    const { service, dropbox } = makeHarness(makeVaultFiles(3), { conflictOnCall: 1 });

    await expect(service.runFull()).rejects.toThrow(ConflictError);

    expect(getContentPaths(dropbox.store)).toHaveLength(0);
    expect(getManifestPaths(dropbox.store)).toHaveLength(0);
    expect(dropbox.store.has(HEAD_PATH)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: PERF-M2 adaptive chunk size
// ---------------------------------------------------------------------------

describe('BackupService.runFull — PERF-M2 adaptive chunk size', () => {
  it('file < 50 MB → uploadLarge called with chunkBytes = 8 MB', async () => {
    const MB = 1024 * 1024;
    // 10 MB file: well below 50 MB threshold, uses 8 MB chunks
    const smallBigFile = new Uint8Array(10 * MB);
    const vaultFiles = new Map([['notes/medium.bin', smallBigFile]]);
    const { service, dropbox } = makeHarness(vaultFiles);

    await service.runFull();

    // Verify at least one uploadLarge call with 8 MB chunk
    const largeCalls = dropbox.uploadLargeCalls;
    expect(largeCalls.length).toBeGreaterThan(0);
    for (const call of largeCalls) {
      expect(call.chunkBytes).toBe(8 * MB);
    }
  });

  it('file >= 50 MB → uploadLarge called with chunkBytes = 150 MB', async () => {
    const MB = 1024 * 1024;
    // 200 MB file: at or above 50 MB threshold, uses 150 MB chunks
    const bigFile = new Uint8Array(200 * MB);
    const vaultFiles = new Map([['notes/large.bin', bigFile]]);
    const { service, dropbox } = makeHarness(vaultFiles);

    await service.runFull();

    const largeCalls = dropbox.uploadLargeCalls;
    expect(largeCalls.length).toBeGreaterThan(0);
    for (const call of largeCalls) {
      expect(call.chunkBytes).toBe(150 * MB);
    }
  });

  it('file exactly 50 MB → uploadLarge called with chunkBytes = 150 MB (boundary pins strict-less-than operator)', async () => {
    const MB = 1024 * 1024;
    // Exactly 50 MB: the threshold check is `< 50 MB` (strict less-than), so
    // exactly-50-MB must take the large-file branch → 150 MB chunks.
    const exactlyThresholdFile = new Uint8Array(50 * MB);
    const vaultFiles = new Map([['notes/exact-50mb.bin', exactlyThresholdFile]]);
    const { service, dropbox } = makeHarness(vaultFiles);

    await service.runFull();

    const largeCalls = dropbox.uploadLargeCalls;
    expect(largeCalls.length).toBeGreaterThan(0);
    for (const call of largeCalls) {
      expect(call.chunkBytes).toBe(150 * MB);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: crash simulation
// ---------------------------------------------------------------------------

describe('BackupService.runFull — crash simulation', () => {
  it('crash before manifest write: orphan blobs in content/, no manifest, no index, HEAD absent', async () => {
    const vaultFiles = makeVaultFiles(3);
    const dropbox = makeFakeDropbox();

    // Make uploadJson throw on the first call (which will be the manifest)
    let uploadJsonCallCount = 0;
    const origUploadJson = dropbox.uploadJson.getMockImplementation()!;
    dropbox.uploadJson = vi.fn(async (path: string, value: unknown) => {
      uploadJsonCallCount++;
      if (uploadJsonCallCount === 1) {
        throw new Error('simulated crash before manifest');
      }
      return origUploadJson(path, value);
    });

    const { service } = makeHarness(vaultFiles, { dropbox });

    await expect(service.runFull()).rejects.toThrow('simulated crash before manifest');

    // Orphan blobs exist (uploaded via uploadLarge before crash)
    expect(getContentPaths(dropbox.store).length).toBeGreaterThan(0);

    // No manifest
    expect(getManifestPaths(dropbox.store)).toHaveLength(0);

    // snapshot_index absent
    expect(dropbox.store.has(SNAPSHOT_INDEX_PATH)).toBe(false);

    // HEAD absent
    expect(dropbox.store.has(HEAD_PATH)).toBe(false);
  });

  it('crash at snapshot_index update: manifest on Dropbox, index absent, HEAD absent', async () => {
    const vaultFiles = makeVaultFiles(3);
    const dropbox = makeFakeDropbox();

    // snapshotIndexStore.append throws
    const snapshotIndexStore = {
      append: vi.fn(async () => {
        throw new Error('simulated crash at snapshot_index');
      }),
    };

    const { service } = makeHarness(vaultFiles, { dropbox, snapshotIndexStore });

    await expect(service.runFull()).rejects.toThrow('simulated crash at snapshot_index');

    // Manifest was written (step 3 completed)
    expect(getManifestPaths(dropbox.store)).toHaveLength(1);

    // snapshot_index absent (step 4 threw)
    expect(dropbox.store.has(SNAPSHOT_INDEX_PATH)).toBe(false);

    // HEAD absent (step 5 not reached)
    expect(dropbox.store.has(HEAD_PATH)).toBe(false);
  });

  it('crash at HEAD write: snapshot_index has new entry, HEAD absent', async () => {
    const vaultFiles = makeVaultFiles(3);
    const dropbox = makeFakeDropbox();

    // Override uploadJson to throw specifically when writing HEAD
    const origFn = dropbox.uploadJson.getMockImplementation()!;
    dropbox.uploadJson = vi.fn(async (path: string, value: unknown) => {
      if (path === HEAD_PATH) {
        throw new Error('simulated crash at HEAD write');
      }
      return origFn(path, value);
    });

    const snapshotIndexStore = makeFakeSnapshotIndexStore(dropbox);
    const { service } = makeHarness(vaultFiles, { dropbox, snapshotIndexStore });

    await expect(service.runFull()).rejects.toThrow('simulated crash at HEAD write');

    // snapshot_index has the new entry
    const idx = dropbox.store.get(SNAPSHOT_INDEX_PATH) as { snapshots: unknown[] } | undefined;
    expect(idx?.snapshots).toHaveLength(1);

    // HEAD absent (still prior state = absent)
    expect(dropbox.store.has(HEAD_PATH)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: upload_parallelism validation (ROB-001)
// ---------------------------------------------------------------------------

describe('BackupService.runFull — upload_parallelism validation', () => {
  it('parallelism=0 falls back to DEFAULT_UPLOAD_PARALLELISM — all blobs uploaded, no hang', async () => {
    const vaultFiles = makeVaultFiles(3);
    const { service, dropbox } = makeHarness(vaultFiles, {
      settingsOverrides: { upload_parallelism: 0 },
    });

    // Wrap in a Promise.race with a 2s timeout — if parallelism=0 causes an infinite
    // loop the timeout wins and the test fails with a clear error.
    const runWithTimeout = Promise.race([
      service.runFull(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('runFull timed out — possible infinite loop from parallelism=0')), 2000),
      ),
    ]);

    await expect(runWithTimeout).resolves.toBeUndefined();

    // All 3 blobs uploaded — fallback to DEFAULT_UPLOAD_PARALLELISM (4) was used
    expect(getContentPaths(dropbox.store)).toHaveLength(3);
  });

  it('parallelism=NaN falls back to DEFAULT_UPLOAD_PARALLELISM — all blobs uploaded', async () => {
    const vaultFiles = makeVaultFiles(3);
    const { service, dropbox } = makeHarness(vaultFiles, {
      settingsOverrides: { upload_parallelism: NaN },
    });

    await service.runFull();

    // All 3 blobs uploaded — fallback to DEFAULT_UPLOAD_PARALLELISM (4) was used
    expect(getContentPaths(dropbox.store)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: TOCTOU fix — single readBytes call per file (ROB-003)
// ---------------------------------------------------------------------------

describe('BackupService.runFull — TOCTOU single-read guarantee', () => {
  it('uses the same bytes for hashing and uploading even if vault changes between hypothetical reads', async () => {
    // Seed the fake vault so readBytes('a.md') returns DIFFERENT bytes on the
    // 1st vs 2nd call, simulating a file edit between two separate reads.
    // With the TOCTOU fix, readBytes is called exactly once per file — so the
    // hash in the manifest and the uploaded blob always match.
    let readCount = 0;
    const firstBytes = new TextEncoder().encode('version-one');
    const secondBytes = new TextEncoder().encode('version-two-different');

    const vaultFiles = new Map([['notes/a.md', firstBytes]]);

    // Build a custom vault that returns different bytes on the 2nd read of a.md
    const fakeVault = {
      getFiles: vi.fn(() => [{ path: 'notes/a.md', mtime: 1000, size: firstBytes.length }]),
      readBytes: vi.fn(async (path: string) => {
        if (path === 'notes/a.md') {
          readCount++;
          return readCount === 1 ? firstBytes : secondBytes;
        }
        throw new Error(`FakeVault: file not found: ${path}`);
      }),
    };

    const dropbox = makeFakeDropbox();
    const coordinator = makeFakeDeviceCoordinator();
    const pluginStore = makeFakePluginStore();
    const snapshotIndexStore = makeFakeSnapshotIndexStore(dropbox);

    const service = new BackupService({
      dropbox: dropbox as never,
      vault: fakeVault as never,
      hasher: fakeHasher,
      deviceCoordinator: coordinator as never,
      pluginStore: pluginStore as never,
      snapshotIndexStore: snapshotIndexStore as never,
      vaultPrefix: VAULT_PREFIX,
      vaultName: VAULT_NAME,
      now: () => '2026-04-24T10:00:00.000Z',
    });

    await service.runFull();

    // The manifest should record the hash of version-one (first and only read)
    const manifestPaths = getManifestPaths(dropbox.store);
    expect(manifestPaths).toHaveLength(1);
    const manifest = dropbox.store.get(manifestPaths[0]) as Record<string, unknown>;
    const files = manifest.files as Record<string, { hash: string }>;
    const recordedHash = files['notes/a.md']?.hash;
    expect(recordedHash).toBeDefined();

    // Compute what the hash of firstBytes should be
    const expectedHash = await fakeHasher(firstBytes);
    expect(recordedHash).toBe(expectedHash);

    // The uploaded blob for that CAS path must also match firstBytes
    const contentPaths = getContentPaths(dropbox.store);
    expect(contentPaths).toHaveLength(1);
    const uploadedBlob = dropbox.store.get(contentPaths[0]) as Uint8Array;
    expect(uploadedBlob).toEqual(firstBytes);

    // readBytes was called exactly once (the TOCTOU fix — one pass for both hash + bytes)
    expect(readCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: HEAD.committed_at === LocalIndex.last_full_commit_at (ROB-006)
// ---------------------------------------------------------------------------

describe('BackupService.runFull — committed_at consistency', () => {
  it('HEAD.committed_at and LocalIndex.last_full_commit_at are identical and strictly later than manifest.created_at', async () => {
    const vaultFiles = makeVaultFiles(2);

    // now() returns strictly incrementing timestamps per call
    let callIndex = 0;
    const timestamps = [
      '2026-04-24T10:00:00.000Z',  // call 0 → createdAt (manifest authoring time)
      '2026-04-24T10:05:00.000Z',  // call 1 → committedAt (after upload completes)
    ];
    const now = () => timestamps[Math.min(callIndex++, timestamps.length - 1)];

    const { service, dropbox, pluginStore } = makeHarness(vaultFiles, { now });

    await service.runFull();

    const head = dropbox.store.get(HEAD_PATH) as Record<string, string> | undefined;
    const localIndex = pluginStore.getIndex();

    // Both must be the committedAt timestamp (call 1), not the createdAt (call 0)
    expect(head?.committed_at).toBe('2026-04-24T10:05:00.000Z');
    expect(localIndex.last_full_commit_at).toBe('2026-04-24T10:05:00.000Z');

    // They must be identical to each other
    expect(head?.committed_at).toBe(localIndex.last_full_commit_at);

    // And strictly later than manifest.created_at
    const manifestPaths = getManifestPaths(dropbox.store);
    const manifest = dropbox.store.get(manifestPaths[0]) as Record<string, string>;
    expect(manifest.created_at).toBe('2026-04-24T10:00:00.000Z');
    expect(head!.committed_at > manifest.created_at).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: crash at steps 6 and 7 (ROB-007)
// ---------------------------------------------------------------------------

describe('BackupService.runFull — crash at step 6 and 7', () => {
  it('crash at step 6 (saveIndex throws after HEAD is written): HEAD exists, snapshot_index updated, LocalIndex unchanged', async () => {
    const vaultFiles = makeVaultFiles(3);
    const dropbox = makeFakeDropbox();
    const snapshotIndexStore = makeFakeSnapshotIndexStore(dropbox);

    // Capture pre-runFull LocalIndex state
    const pluginStore = makeFakePluginStore();
    const preRunIndex = { ...pluginStore.getIndex() };

    // Make saveIndex throw after HEAD is written
    const origSaveIndex = pluginStore.saveIndex.getMockImplementation()!;
    pluginStore.saveIndex = vi.fn(async (i: Parameters<typeof origSaveIndex>[0]) => {
      throw new Error('simulated crash at saveIndex (step 6)');
    });

    const service = new BackupService({
      dropbox: dropbox as never,
      vault: makeFakeVault(vaultFiles) as never,
      hasher: fakeHasher,
      deviceCoordinator: makeFakeDeviceCoordinator() as never,
      pluginStore: pluginStore as never,
      snapshotIndexStore: snapshotIndexStore as never,
      vaultPrefix: VAULT_PREFIX,
      vaultName: VAULT_NAME,
      now: () => '2026-04-24T10:00:00.000Z',
    });

    await expect(service.runFull()).rejects.toThrow('simulated crash at saveIndex (step 6)');

    // HEAD was written (step 5 completed before crash)
    expect(dropbox.store.has(HEAD_PATH)).toBe(true);

    // snapshot_index has the new entry (step 4 completed)
    const idx = dropbox.store.get(SNAPSHOT_INDEX_PATH) as { snapshots: unknown[] } | undefined;
    expect(idx?.snapshots).toHaveLength(1);

    // LocalIndex is unchanged from pre-runFull state (step 6 threw)
    expect(pluginStore.getIndex()).toEqual(preRunIndex);

    // Error propagates
  });

  it('crash at step 7 (saveQueue throws after saveIndex succeeds): HEAD + snapshot_index + LocalIndex all updated, queue cursor unchanged', async () => {
    const vaultFiles = makeVaultFiles(3);
    const dropbox = makeFakeDropbox();
    const snapshotIndexStore = makeFakeSnapshotIndexStore(dropbox);
    const pluginStore = makeFakePluginStore();
    const preRunQueue = { ...pluginStore.getQueue() };

    // Make saveQueue throw
    pluginStore.saveQueue = vi.fn(async () => {
      throw new Error('simulated crash at saveQueue (step 7)');
    });

    const service = new BackupService({
      dropbox: dropbox as never,
      vault: makeFakeVault(vaultFiles) as never,
      hasher: fakeHasher,
      deviceCoordinator: makeFakeDeviceCoordinator() as never,
      pluginStore: pluginStore as never,
      snapshotIndexStore: snapshotIndexStore as never,
      vaultPrefix: VAULT_PREFIX,
      vaultName: VAULT_NAME,
      now: () => '2026-04-24T10:00:00.000Z',
    });

    await expect(service.runFull()).rejects.toThrow('simulated crash at saveQueue (step 7)');

    // HEAD written (step 5 completed)
    expect(dropbox.store.has(HEAD_PATH)).toBe(true);

    // snapshot_index updated (step 4 completed)
    const idx = dropbox.store.get(SNAPSHOT_INDEX_PATH) as { snapshots: unknown[] } | undefined;
    expect(idx?.snapshots).toHaveLength(1);

    // LocalIndex updated (step 6 completed)
    const localIndex = pluginStore.getIndex();
    expect(localIndex.last_full_snapshot_id).not.toBeNull();

    // Queue cursor unchanged from pre-runFull state (step 7 threw before saveQueue persisted)
    expect(pluginStore.getQueue()).toEqual(preRunQueue);

    // Error propagates
  });
});
