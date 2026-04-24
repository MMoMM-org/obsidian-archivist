// T5.2a — SnapshotIndexStore: Dropbox-backed snapshot_index.json with serialized writes.
//
// Test coverage:
//   - append(entry) serializes writes via promise chain; updates last_updated_at; persists
//   - read() returns current index; returns null if file missing; throws CorruptionError on bad JSON
//   - remove(id) removes matching entry and persists; no-op if id absent
//   - rebuild(manifestList) iterates manifests, extracts metadata, writes fresh index
//   - Concurrent append calls serialize correctly (ROB-003)

import { describe, expect, it, vi } from 'vitest';
import { SnapshotIndexStore } from '../../src/services/SnapshotIndexStore';
import type { SnapshotIndexStoreOptions } from '../../src/services/SnapshotIndexStore';
import { CorruptionError, PathError } from '../../src/model/Errors';
import type { SnapshotIndexEntry } from '../../src/model/SnapshotIndex';
import type { SnapshotManifest } from '../../src/model/Manifest';

// ---------------------------------------------------------------------------
// Fake DropboxClient
// ---------------------------------------------------------------------------

type FakeDropbox = {
  store: Map<string, unknown>;
  uploadJson: (path: string, value: unknown) => Promise<void>;
  downloadJson: (path: string) => Promise<unknown>;
};

function makeFakeDropbox(initialContent?: { path: string; value: unknown }): FakeDropbox {
  const store = new Map<string, unknown>();
  if (initialContent) {
    store.set(initialContent.path, initialContent.value);
  }
  return {
    store,
    uploadJson: vi.fn(async (path: string, value: unknown) => {
      store.set(path, JSON.parse(JSON.stringify(value)));
    }),
    downloadJson: vi.fn(async (path: string) => {
      if (!store.has(path)) {
        throw new PathError('PATH_NOT_FOUND', `path not found: ${path}`, false);
      }
      return store.get(path);
    }),
  };
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const VAULT_PREFIX = 'test-vault';
const SNAPSHOT_INDEX_PATH = `Apps/Archivist/${VAULT_PREFIX}/snapshot_index.json`;

function makeEntry(overrides?: Partial<SnapshotIndexEntry>): SnapshotIndexEntry {
  return {
    id: '2026-04-24T10-00-full',
    type: 'full',
    parent_id: null,
    created_at: '2026-04-24T10:00:00.000Z',
    device_id: 'device-abc-123',
    blob_hashes: ['aabbcc00'],
    ...overrides,
  };
}

function makeManifest(overrides?: Partial<SnapshotManifest>): SnapshotManifest {
  return {
    schema_version: '1.0',
    id: '2026-04-24T10-00-full',
    type: 'full',
    parent_id: null,
    device_id: 'device-abc-123',
    created_at: '2026-04-24T10:00:00.000Z',
    vault_name: 'TestVault',
    vault_prefix: VAULT_PREFIX,
    files: {
      'notes/a.md': { hash: 'aabbcc00', size: 100, mtime: 1000 },
    },
    deleted: [],
    renames: [],
    exclusions_applied: null,
    ...overrides,
  };
}

function makeStore(
  dropbox: FakeDropbox,
  opts?: Partial<SnapshotIndexStoreOptions>,
): SnapshotIndexStore {
  return new SnapshotIndexStore({
    dropbox: dropbox as never,
    vaultPrefix: VAULT_PREFIX,
    now: () => '2026-04-24T12:00:00.000Z',
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Tests: read()
// ---------------------------------------------------------------------------

describe('SnapshotIndexStore.read', () => {
  it('returns null when snapshot_index.json does not exist', async () => {
    const dropbox = makeFakeDropbox();
    const store = makeStore(dropbox);

    const result = await store.read();

    expect(result).toBeNull();
  });

  it('returns parsed index when file exists', async () => {
    const existingIndex = {
      schema_version: '1.0',
      last_updated_at: '2026-04-24T10:00:00.000Z',
      snapshots: [makeEntry()],
    };
    const dropbox = makeFakeDropbox({ path: SNAPSHOT_INDEX_PATH, value: existingIndex });
    const store = makeStore(dropbox);

    const result = await store.read();

    expect(result).not.toBeNull();
    expect(result!.schema_version).toBe('1.0');
    expect(result!.snapshots).toHaveLength(1);
    expect(result!.snapshots[0].id).toBe('2026-04-24T10-00-full');
  });

  it('throws CorruptionError with SNAPSHOT_INDEX_INVALID when parse fails', async () => {
    const dropbox = makeFakeDropbox();
    // Override downloadJson to return invalid data (not a valid SnapshotIndex)
    dropbox.downloadJson = vi.fn(async (_path: string) => {
      return { schema_version: '9.9', snapshots: 'not-an-array' };
    });
    const store = makeStore(dropbox);

    await expect(store.read()).rejects.toThrow(CorruptionError);

    let thrown: CorruptionError | null = null;
    try {
      await store.read();
    } catch (e) {
      thrown = e as CorruptionError;
    }
    expect(thrown!.code).toBe('SNAPSHOT_INDEX_INVALID');
  });

  it('propagates non-PathError errors from downloadJson', async () => {
    const dropbox = makeFakeDropbox();
    const networkErr = new Error('Network failure');
    dropbox.downloadJson = vi.fn(async () => {
      throw networkErr;
    });
    const store = makeStore(dropbox);

    await expect(store.read()).rejects.toThrow(networkErr);
  });
});

// ---------------------------------------------------------------------------
// Tests: append()
// ---------------------------------------------------------------------------

describe('SnapshotIndexStore.append', () => {
  it('creates a fresh index when none exists, writes to Dropbox', async () => {
    const dropbox = makeFakeDropbox();
    const store = makeStore(dropbox);
    const entry = makeEntry();

    await store.append(entry);

    const written = dropbox.store.get(SNAPSHOT_INDEX_PATH) as Record<string, unknown>;
    expect(written).not.toBeUndefined();
    expect(written.schema_version).toBe('1.0');
    const snapshots = written.snapshots as SnapshotIndexEntry[];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].id).toBe(entry.id);
  });

  it('appends to existing index without dropping existing entries', async () => {
    const existingEntry = makeEntry({ id: '2026-04-24T09-00-full', created_at: '2026-04-24T09:00:00.000Z' });
    const existingIndex = {
      schema_version: '1.0',
      last_updated_at: '2026-04-24T09:00:00.000Z',
      snapshots: [existingEntry],
    };
    const dropbox = makeFakeDropbox({ path: SNAPSHOT_INDEX_PATH, value: existingIndex });
    const store = makeStore(dropbox);
    const newEntry = makeEntry({ id: '2026-04-24T10-00-inc', type: 'inc', parent_id: '2026-04-24T09-00-full' });

    await store.append(newEntry);

    const written = dropbox.store.get(SNAPSHOT_INDEX_PATH) as { snapshots: SnapshotIndexEntry[] };
    expect(written.snapshots).toHaveLength(2);
    expect(written.snapshots[0].id).toBe(existingEntry.id);
    expect(written.snapshots[1].id).toBe(newEntry.id);
  });

  it('updates last_updated_at on append', async () => {
    const dropbox = makeFakeDropbox();
    const fixedNow = '2026-04-24T12:00:00.000Z';
    const store = makeStore(dropbox, { now: () => fixedNow });

    await store.append(makeEntry());

    const written = dropbox.store.get(SNAPSHOT_INDEX_PATH) as { last_updated_at: string };
    expect(written.last_updated_at).toBe(fixedNow);
  });

  it('calls uploadJson once per append', async () => {
    const dropbox = makeFakeDropbox();
    const store = makeStore(dropbox);

    await store.append(makeEntry());

    expect(dropbox.uploadJson).toHaveBeenCalledTimes(1);
    expect(dropbox.uploadJson).toHaveBeenCalledWith(SNAPSHOT_INDEX_PATH, expect.objectContaining({
      schema_version: '1.0',
    }));
  });
});

// ---------------------------------------------------------------------------
// Tests: remove()
// ---------------------------------------------------------------------------

describe('SnapshotIndexStore.remove', () => {
  it('removes the matching entry and persists', async () => {
    const entry1 = makeEntry({ id: '2026-04-24T09-00-full' });
    const entry2 = makeEntry({ id: '2026-04-24T10-00-inc', type: 'inc', parent_id: '2026-04-24T09-00-full' });
    const existingIndex = {
      schema_version: '1.0',
      last_updated_at: '2026-04-24T10:00:00.000Z',
      snapshots: [entry1, entry2],
    };
    const dropbox = makeFakeDropbox({ path: SNAPSHOT_INDEX_PATH, value: existingIndex });
    const store = makeStore(dropbox);

    await store.remove(entry1.id);

    const written = dropbox.store.get(SNAPSHOT_INDEX_PATH) as { snapshots: SnapshotIndexEntry[] };
    expect(written.snapshots).toHaveLength(1);
    expect(written.snapshots[0].id).toBe(entry2.id);
  });

  it('no-op when id not present — does not throw, does not persist', async () => {
    const existingIndex = {
      schema_version: '1.0',
      last_updated_at: '2026-04-24T10:00:00.000Z',
      snapshots: [makeEntry()],
    };
    const dropbox = makeFakeDropbox({ path: SNAPSHOT_INDEX_PATH, value: existingIndex });
    const uploadSpy = vi.spyOn(dropbox, 'uploadJson');
    const store = makeStore(dropbox);

    await expect(store.remove('nonexistent-id')).resolves.toBeUndefined();
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('no-op when index file does not exist', async () => {
    const dropbox = makeFakeDropbox();
    const uploadSpy = vi.spyOn(dropbox, 'uploadJson');
    const store = makeStore(dropbox);

    await expect(store.remove('any-id')).resolves.toBeUndefined();
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: rebuild()
// ---------------------------------------------------------------------------

describe('SnapshotIndexStore.rebuild', () => {
  it('writes a fresh index from a list of manifests', async () => {
    const dropbox = makeFakeDropbox();
    const store = makeStore(dropbox);
    const manifests = [
      makeManifest({ id: '2026-04-24T09-00-full', created_at: '2026-04-24T09:00:00.000Z' }),
      makeManifest({
        id: '2026-04-24T10-00-inc',
        type: 'inc',
        parent_id: '2026-04-24T09-00-full',
        created_at: '2026-04-24T10:00:00.000Z',
        files: { 'notes/b.md': { hash: 'bbcc1100', size: 200, mtime: 2000 } },
      }),
    ];

    await store.rebuild(manifests);

    const written = dropbox.store.get(SNAPSHOT_INDEX_PATH) as {
      schema_version: string;
      snapshots: SnapshotIndexEntry[];
    };
    expect(written.schema_version).toBe('1.0');
    expect(written.snapshots).toHaveLength(2);
    expect(written.snapshots[0].id).toBe('2026-04-24T09-00-full');
    expect(written.snapshots[1].id).toBe('2026-04-24T10-00-inc');
    expect(written.snapshots[0].type).toBe('full');
    expect(written.snapshots[1].parent_id).toBe('2026-04-24T09-00-full');
  });

  it('extracts blob_hashes from manifest files', async () => {
    const dropbox = makeFakeDropbox();
    const store = makeStore(dropbox);
    const manifest = makeManifest({
      files: {
        'a.md': { hash: 'hash001', size: 10, mtime: 1 },
        'b.md': { hash: 'hash002', size: 20, mtime: 2 },
        'c.md': { hash: 'hash001', size: 30, mtime: 3 }, // duplicate hash — should appear once
      },
    });

    await store.rebuild([manifest]);

    const written = dropbox.store.get(SNAPSHOT_INDEX_PATH) as { snapshots: SnapshotIndexEntry[] };
    const hashes = written.snapshots[0].blob_hashes;
    expect(hashes).toContain('hash001');
    expect(hashes).toContain('hash002');
    // Duplicate hashes deduplicated
    expect(hashes.filter((h: string) => h === 'hash001')).toHaveLength(1);
  });

  it('overwrites existing index on rebuild', async () => {
    const existingIndex = {
      schema_version: '1.0',
      last_updated_at: '2026-04-23T00:00:00.000Z',
      snapshots: [makeEntry({ id: 'stale-entry' })],
    };
    const dropbox = makeFakeDropbox({ path: SNAPSHOT_INDEX_PATH, value: existingIndex });
    const store = makeStore(dropbox);
    const freshManifest = makeManifest({ id: '2026-04-24T10-00-full' });

    await store.rebuild([freshManifest]);

    const written = dropbox.store.get(SNAPSHOT_INDEX_PATH) as { snapshots: SnapshotIndexEntry[] };
    expect(written.snapshots).toHaveLength(1);
    expect(written.snapshots[0].id).toBe('2026-04-24T10-00-full');
  });

  it('rebuild with empty list writes index with no snapshots', async () => {
    const dropbox = makeFakeDropbox();
    const store = makeStore(dropbox);

    await store.rebuild([]);

    const written = dropbox.store.get(SNAPSHOT_INDEX_PATH) as { snapshots: SnapshotIndexEntry[] };
    expect(written.snapshots).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: concurrent append serialization (ROB-003)
// ---------------------------------------------------------------------------

describe('SnapshotIndexStore concurrent append serialization', () => {
  it('two concurrent appends both land in the index (no lost write)', async () => {
    const dropbox = makeFakeDropbox();
    const store = makeStore(dropbox);

    const entry1 = makeEntry({ id: '2026-04-24T10-00-full' });
    const entry2 = makeEntry({ id: '2026-04-24T11-00-inc', type: 'inc', parent_id: '2026-04-24T10-00-full' });

    await Promise.all([store.append(entry1), store.append(entry2)]);

    const written = dropbox.store.get(SNAPSHOT_INDEX_PATH) as { snapshots: SnapshotIndexEntry[] };
    const ids = written.snapshots.map((s: SnapshotIndexEntry) => s.id);
    expect(ids).toContain(entry1.id);
    expect(ids).toContain(entry2.id);
    expect(written.snapshots).toHaveLength(2);
  });

  it('concurrent appends produce exactly two uploadJson calls', async () => {
    const dropbox = makeFakeDropbox();
    const store = makeStore(dropbox);

    const entry1 = makeEntry({ id: '2026-04-24T10-00-full' });
    const entry2 = makeEntry({ id: '2026-04-24T11-00-inc', type: 'inc', parent_id: '2026-04-24T10-00-full' });

    await Promise.all([store.append(entry1), store.append(entry2)]);

    expect(dropbox.uploadJson).toHaveBeenCalledTimes(2);
  });

  it('concurrent append + rebuild serializes correctly — rebuild wins as the last queued write (ROB-003)', async () => {
    const dropbox = makeFakeDropbox();
    const store = makeStore(dropbox);

    const appendEntry = makeEntry({ id: '2026-04-24T10-00-full' });
    const rebuildManifest = makeManifest({ id: '2026-04-24T11-00-inc', type: 'inc', parent_id: '2026-04-24T10-00-full' });

    // Fire append first, then rebuild immediately — both enqueued concurrently.
    // rebuild is queued second, so it must win and the final state reflects rebuild's intent.
    await Promise.all([store.append(appendEntry), store.rebuild([rebuildManifest])]);

    const written = dropbox.store.get(SNAPSHOT_INDEX_PATH) as { snapshots: SnapshotIndexEntry[] };
    // rebuild overwrites completely — only the rebuild manifest entry should remain
    expect(written.snapshots).toHaveLength(1);
    expect(written.snapshots[0].id).toBe(rebuildManifest.id);
  });
});
