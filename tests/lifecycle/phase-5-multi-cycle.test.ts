// T5.6 — Phase 5 multi-cycle integration test.
//
// Scenario: fresh Dropbox → Full → 5 Incremental runs over simulated time.
// After all cycles the manifest chain is walked from HEAD back to the Full
// (using the materializeVaultStateAt algorithm documented verbatim in
//   docs/XDD/specs/001-archivist-plugin/solution.md:750-778)
// and the reconstructed vault state is compared against the ground-truth
// final vault state.
//
// Ground-truth final state after all cycles:
//   A   — modified content (Cycle 2)
//   B-renamed — renamed from B, original content (Cycle 3)
//   D   — modified content (Cycle 5)
//   E-new — renamed from E with new content (Cycle 6)
//   F   — new file (Cycle 5)
//   C   — deleted (Cycle 4)
//
// Expected paths: { A, B-renamed, D, E-new, F }   (C absent)

import { describe, expect, it } from 'vitest';
import { BackupService, type BackupServiceDeps } from '../../src/services/BackupService';
import type { PluginSettings } from '../../src/model/Settings';
import { DEFAULT_SETTINGS } from '../../src/model/Settings';
import type { LocalIndex } from '../../src/model/Index';
import { emptyLocalIndex } from '../../src/model/Index';
import type { EventQueue, QueueEntry } from '../../src/model/QueueEntry';
import { emptyEventQueue } from '../../src/model/QueueEntry';
import type { FileEntry, SnapshotManifest } from '../../src/model/Manifest';
import { headPath, snapshotIndexPath, snapshotsDir } from '../../src/util/paths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VAULT_PREFIX = 'test-vault';
const VAULT_NAME = 'TestVault';
const DEVICE_ID = '11111111-1111-4111-a111-111111111111';
const HEAD_PATH = headPath(VAULT_PREFIX);
const SNAPSHOT_INDEX_PATH = snapshotIndexPath(VAULT_PREFIX);
const SNAPSHOTS_PREFIX = snapshotsDir(VAULT_PREFIX);

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

    uploadBlob: async (path: string, bytes: Uint8Array) => {
      store.set(path, bytes);
    },

    uploadJson: async (path: string, value: unknown) => {
      store.set(path, JSON.parse(JSON.stringify(value)));
    },

    downloadJson: async (path: string) => {
      const { PathError } = await import('../../src/model/Errors');
      if (!store.has(path)) throw new PathError('PATH_NOT_FOUND', `not found: ${path}`, false);
      return store.get(path);
    },

    uploadLarge: async (path: string, bytes: Uint8Array, opts?: UploadLargeOpts) => {
      const chunkBytes = opts?.chunkBytes ?? (8 * 1024 * 1024);
      uploadLargeCalls.push({ path, size: bytes.length, chunkBytes });
      store.set(path, bytes);
    },
  };
}

type FakeDropbox = ReturnType<typeof makeFakeDropbox>;

// ---------------------------------------------------------------------------
// Fake Vault
// ---------------------------------------------------------------------------

function makeFakeVault(files: Map<string, Uint8Array>) {
  return {
    getFiles: () =>
      Array.from(files.entries()).map(([path, bytes]) => ({
        path,
        mtime: 1000,
        size: bytes.length,
      })),
    readBytes: async (path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`FakeVault: file not found: ${path}`);
      return bytes;
    },
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
// Fake DeviceCoordinator — never throws ConflictError in this test
// ---------------------------------------------------------------------------

function makeFakeDeviceCoordinator() {
  return {
    verifyNoConflict: async () => { /* always OK */ },
    getOrCreateDeviceId: async () => DEVICE_ID,
  };
}

// ---------------------------------------------------------------------------
// Fake PluginStore
// ---------------------------------------------------------------------------

function makeFakePluginStore(
  initialIndex?: Partial<LocalIndex>,
  settingsOverrides?: Partial<PluginSettings['advanced']>,
  initialQueue?: Partial<EventQueue>,
) {
  let index: LocalIndex = { ...emptyLocalIndex(), ...initialIndex };
  let queue: EventQueue = { ...emptyEventQueue(), ...initialQueue };
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
    setQueue: (q: EventQueue) => { queue = { ...q }; },
    loadIndex: async () => index,
    saveIndex: async (i: LocalIndex) => { index = { ...i }; },
    loadQueue: async () => queue,
    saveQueue: async (q: EventQueue) => { queue = { ...q }; },
    loadSettings: async () => settings,
  };
}

// ---------------------------------------------------------------------------
// Fake SnapshotIndexStore
// ---------------------------------------------------------------------------

function makeFakeSnapshotIndexStore(dropbox: FakeDropbox) {
  return {
    append: async (entry: unknown) => {
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
    },
  };
}

// ---------------------------------------------------------------------------
// Harness factory
// ---------------------------------------------------------------------------

function makeMultiCycleHarness(
  vaultFiles: Map<string, Uint8Array>,
  nowFn: () => string,
) {
  const dropbox = makeFakeDropbox();
  const vault = makeFakeVault(vaultFiles);
  const coordinator = makeFakeDeviceCoordinator();
  const pluginStore = makeFakePluginStore();
  const snapshotIndexStore = makeFakeSnapshotIndexStore(dropbox);

  const deps: BackupServiceDeps = {
    dropbox: dropbox as never,
    vault: vault as never,
    hasher: fakeHasher,
    deviceCoordinator: coordinator as never,
    pluginStore: pluginStore as never,
    snapshotIndexStore: snapshotIndexStore as never,
    vaultPrefix: VAULT_PREFIX,
    vaultName: VAULT_NAME,
    now: nowFn,
  };

  return {
    service: new BackupService(deps),
    dropbox,
    pluginStore,
  };
}

// ---------------------------------------------------------------------------
// Queue entry helpers
// ---------------------------------------------------------------------------

function makeEntry(
  overrides: Partial<QueueEntry> & Pick<QueueEntry, 'type' | 'path' | 'observed_at'>,
): QueueEntry {
  return {
    id: crypto.randomUUID(),
    prev_path: null,
    ...overrides,
  };
}

function makeRenameEntry(from: string, to: string, observedAt: string): QueueEntry {
  return makeEntry({ type: 'rename', path: to, prev_path: from, observed_at: observedAt });
}

// ---------------------------------------------------------------------------
// materializeVaultStateAt — local test helper
// Algorithm verbatim from solution.md:750-778 (RestoreService not yet implemented;
// copied here per T5.6 spec so this test has no Phase 8 dependency).
// ---------------------------------------------------------------------------

async function materializeVaultStateAt(
  targetSnapshotId: string,
  dropbox: FakeDropbox,
): Promise<Record<string, FileEntry>> {
  const chain: SnapshotManifest[] = [];
  let cursor: string | null = targetSnapshotId;

  while (cursor) {
    const manifestPath = `${SNAPSHOTS_PREFIX}/${cursor}.json`;
    const raw = dropbox.store.get(manifestPath);
    if (!raw) {
      throw new Error(`materializeVaultStateAt: manifest not found for id=${cursor}`);
    }
    const m = raw as SnapshotManifest;
    chain.push(m);
    if (m.type === 'full') break;
    cursor = m.parent_id;
  }

  if (chain[chain.length - 1].type !== 'full') {
    throw new Error('materializeVaultStateAt: no Full ancestor found for snapshot ' + targetSnapshotId);
  }

  // chain is [targetSnapshot, ..., Full] — newest to oldest; replay oldest-to-newest
  chain.reverse();

  const state: Record<string, FileEntry> = { ...chain[0].files }; // start from Full

  for (let i = 1; i < chain.length; i++) {
    const m = chain[i];
    // Renames first (logically: path's prior identity changes)
    for (const { from, to } of m.renames) {
      if (state[from] && !state[to]) { state[to] = state[from]; delete state[from]; }
    }
    // Adds/modifies overwrite
    for (const [p, entry] of Object.entries(m.files)) { state[p] = entry as FileEntry; }
    // Explicit tombstones
    for (const p of m.deleted) { delete state[p]; }
  }

  return state;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getManifestPaths(store: Map<string, unknown>): string[] {
  return Array.from(store.keys()).filter((p) => p.includes('/snapshots/'));
}

// ---------------------------------------------------------------------------
// Multi-cycle integration test
// ---------------------------------------------------------------------------

describe('Phase 5 multi-cycle integration (T5.6)', () => {
  it('full → 5 inc cycles: materializeVaultStateAt(HEAD) matches ground-truth final vault state', async () => {
    // ---------------------------------------------------------------------------
    // Initial vault state (5 files: A, B, C, D, E)
    // ---------------------------------------------------------------------------
    const enc = (s: string) => new TextEncoder().encode(s);

    const vaultFiles = new Map<string, Uint8Array>([
      ['notes/A.md', enc('A-original')],
      ['notes/B.md', enc('B-original')],
      ['notes/C.md', enc('C-original')],
      ['notes/D.md', enc('D-original')],
      ['notes/E.md', enc('E-original')],
    ]);

    // Timestamp generator — each call returns the next timestamp in sequence.
    // Full needs 2 calls (createdAt + committedAt); each Inc also needs 2.
    // Total: 1 full + 5 inc = 6 snapshots × 2 = 12 timestamps.
    const timestamps = [
      '2026-04-24T08:00:00.000Z', // Full: created_at
      '2026-04-24T08:01:00.000Z', // Full: committed_at
      '2026-04-24T09:00:00.000Z', // Inc1: created_at
      '2026-04-24T09:01:00.000Z', // Inc1: committed_at
      '2026-04-24T10:00:00.000Z', // Inc2: created_at
      '2026-04-24T10:01:00.000Z', // Inc2: committed_at
      '2026-04-24T11:00:00.000Z', // Inc3: created_at
      '2026-04-24T11:01:00.000Z', // Inc3: committed_at
      '2026-04-24T12:00:00.000Z', // Inc4: created_at
      '2026-04-24T12:01:00.000Z', // Inc4: committed_at
      '2026-04-24T13:00:00.000Z', // Inc5: created_at
      '2026-04-24T13:01:00.000Z', // Inc5: committed_at
    ];
    let nowTick = 0;
    const { service, dropbox, pluginStore } = makeMultiCycleHarness(
      vaultFiles,
      () => timestamps[Math.min(nowTick++, timestamps.length - 1)],
    );

    // ---------------------------------------------------------------------------
    // Cycle 1: seed vault with A, B, C, D, E; run Full
    // ---------------------------------------------------------------------------
    await service.runFull();

    // Reset queue after Full (mirrors the convention from backup-service tests)
    pluginStore.setQueue(emptyEventQueue());

    // Verify: 1 manifest (full), HEAD set, snapshot_index has 1 entry
    expect(getManifestPaths(dropbox.store)).toHaveLength(1);
    const headAfterFull = dropbox.store.get(HEAD_PATH) as Record<string, unknown>;
    expect(headAfterFull.snapshot_type).toBe('full');

    // ---------------------------------------------------------------------------
    // Cycle 2: modify A
    // ---------------------------------------------------------------------------
    const aV2 = enc('A-modified-v2');
    vaultFiles.set('notes/A.md', aV2);

    pluginStore.setQueue({
      ...emptyEventQueue(),
      entries: [
        makeEntry({ type: 'modify', path: 'notes/A.md', observed_at: '2026-04-24T08:30:00.000Z' }),
      ],
    });

    await service.runIncremental();
    pluginStore.setQueue(emptyEventQueue());

    // ---------------------------------------------------------------------------
    // Cycle 3: rename B → B-renamed (pure rename, content unchanged)
    // ---------------------------------------------------------------------------
    const bBytes = vaultFiles.get('notes/B.md')!; // preserve original bytes
    vaultFiles.delete('notes/B.md');
    vaultFiles.set('notes/B-renamed.md', bBytes);

    pluginStore.setQueue({
      ...emptyEventQueue(),
      entries: [
        makeRenameEntry('notes/B.md', 'notes/B-renamed.md', '2026-04-24T09:30:00.000Z'),
      ],
    });

    await service.runIncremental();
    pluginStore.setQueue(emptyEventQueue());

    // ---------------------------------------------------------------------------
    // Cycle 4: delete C
    // ---------------------------------------------------------------------------
    vaultFiles.delete('notes/C.md');

    pluginStore.setQueue({
      ...emptyEventQueue(),
      entries: [
        makeEntry({ type: 'delete', path: 'notes/C.md', observed_at: '2026-04-24T10:30:00.000Z' }),
      ],
    });

    await service.runIncremental();
    pluginStore.setQueue(emptyEventQueue());

    // ---------------------------------------------------------------------------
    // Cycle 5: create F, modify D
    // ---------------------------------------------------------------------------
    const fBytes = enc('F-new-content');
    const dV2 = enc('D-modified-v2');
    vaultFiles.set('notes/F.md', fBytes);
    vaultFiles.set('notes/D.md', dV2);

    pluginStore.setQueue({
      ...emptyEventQueue(),
      entries: [
        makeEntry({ type: 'create', path: 'notes/F.md', observed_at: '2026-04-24T11:20:00.000Z' }),
        makeEntry({ type: 'modify', path: 'notes/D.md', observed_at: '2026-04-24T11:30:00.000Z' }),
      ],
    });

    await service.runIncremental();
    pluginStore.setQueue(emptyEventQueue());

    // ---------------------------------------------------------------------------
    // Cycle 6: rename E → E-new AND modify its content
    // ---------------------------------------------------------------------------
    const eNew = enc('E-new-content-after-rename');
    vaultFiles.delete('notes/E.md');
    vaultFiles.set('notes/E-new.md', eNew);

    pluginStore.setQueue({
      ...emptyEventQueue(),
      entries: [
        makeRenameEntry('notes/E.md', 'notes/E-new.md', '2026-04-24T12:20:00.000Z'),
        makeEntry({ type: 'modify', path: 'notes/E-new.md', observed_at: '2026-04-24T12:30:00.000Z' }),
      ],
    });

    await service.runIncremental();
    pluginStore.setQueue(emptyEventQueue());

    // ---------------------------------------------------------------------------
    // Verify: 6 manifests total (1 full + 5 inc)
    // ---------------------------------------------------------------------------
    const manifestPaths = getManifestPaths(dropbox.store);
    expect(manifestPaths).toHaveLength(6);

    // Verify: HEAD points to the last Inc
    const head = dropbox.store.get(HEAD_PATH) as Record<string, unknown>;
    expect(head.snapshot_type).toBe('inc');
    const headSnapshotId = head.snapshot_id as string;

    // ---------------------------------------------------------------------------
    // Walk the manifest chain from HEAD back to Full (materializeVaultStateAt)
    // ---------------------------------------------------------------------------
    const reconstructed = await materializeVaultStateAt(headSnapshotId, dropbox);

    // ---------------------------------------------------------------------------
    // Ground-truth final vault state
    // ---------------------------------------------------------------------------
    const groundTruthPaths = new Set(['notes/A.md', 'notes/B-renamed.md', 'notes/D.md', 'notes/E-new.md', 'notes/F.md']);

    // Assert: reconstructed path set matches ground truth
    expect(new Set(Object.keys(reconstructed))).toEqual(groundTruthPaths);

    // Assert: C is absent
    expect(reconstructed['notes/C.md']).toBeUndefined();

    // Assert: A has the modified (v2) hash
    const expectedHashA = await fakeHasher(aV2);
    expect(reconstructed['notes/A.md']?.hash).toBe(expectedHashA);

    // Assert: B-renamed has the original B hash (pure rename — content unchanged)
    const expectedHashB = await fakeHasher(bBytes);
    expect(reconstructed['notes/B-renamed.md']?.hash).toBe(expectedHashB);

    // Assert: D has the modified (v2) hash
    const expectedHashD = await fakeHasher(dV2);
    expect(reconstructed['notes/D.md']?.hash).toBe(expectedHashD);

    // Assert: E-new has the new content hash (rename + content change)
    const expectedHashENew = await fakeHasher(eNew);
    expect(reconstructed['notes/E-new.md']?.hash).toBe(expectedHashENew);

    // Assert: F has the new file hash
    const expectedHashF = await fakeHasher(fBytes);
    expect(reconstructed['notes/F.md']?.hash).toBe(expectedHashF);

    // ---------------------------------------------------------------------------
    // LocalIndex invariant (T5.4): LocalIndex.files must also match ground truth
    // ---------------------------------------------------------------------------
    const localIndex = pluginStore.getIndex();
    const localPaths = new Set(Object.keys(localIndex.files));

    expect(localPaths).toEqual(groundTruthPaths);
    expect(localIndex.files['notes/C.md']).toBeUndefined();
    expect(localIndex.files['notes/A.md']?.hash).toBe(expectedHashA);
    expect(localIndex.files['notes/B-renamed.md']?.hash).toBe(expectedHashB);
    expect(localIndex.files['notes/D.md']?.hash).toBe(expectedHashD);
    expect(localIndex.files['notes/E-new.md']?.hash).toBe(expectedHashENew);
    expect(localIndex.files['notes/F.md']?.hash).toBe(expectedHashF);

    // Assert materialized state hash-for-hash matches the local index (belt-and-braces)
    for (const path of groundTruthPaths) {
      expect(reconstructed[path]?.hash).toBe(localIndex.files[path]?.hash);
    }
  });
});
