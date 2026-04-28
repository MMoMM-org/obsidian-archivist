// T8.4 — ManifestCache: snapshot-index + per-id manifest memoisation.

import { describe, expect, it, vi } from 'vitest';
import { ManifestCache, type DropboxReader, type ManifestCacheDeps } from '../../src/services/ManifestCache';
import type { Logger } from '../../src/infra/Logger';
import type { SnapshotManifest } from '../../src/model/Manifest';
import type { SnapshotIndex } from '../../src/model/SnapshotIndex';
import { PathError } from '../../src/model/Errors';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeManifest(id: string, type: 'full' | 'inc' = 'inc'): SnapshotManifest {
  return {
    schema_version: '1.0',
    id,
    type,
    parent_id: null,
    device_id: 'd0',
    created_at: `2026-04-20T12:00:00.000Z`,
    vault_name: 'v',
    vault_prefix: 'v',
    files: {},
    deleted: [],
    renames: [],
    exclusions_applied: null,
  };
}

function makeIndex(entries: Array<{ id: string; type: 'full' | 'inc'; parent?: string | null; createdAt?: string }>): SnapshotIndex {
  return {
    schema_version: '1.0',
    last_updated_at: '2026-04-24T00:00:00.000Z',
    snapshots: entries.map((e) => ({
      id: e.id,
      type: e.type,
      parent_id: e.parent ?? null,
      created_at: e.createdAt ?? `2026-04-20T12:00:00.000Z`,
      device_id: 'd0',
      blob_hashes: [],
    })),
  };
}

interface Harness {
  cache: ManifestCache;
  dropbox: DropboxReader;
  downloadJson: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: {
  index?: SnapshotIndex;
  manifests?: Record<string, SnapshotManifest>;
  indexError?: Error;
} = {}): Harness {
  const index = opts.index ?? makeIndex([{ id: '2026-04-20T03-00-full', type: 'full' }]);
  const manifests = opts.manifests ?? {};

  const downloadJson = vi.fn(async (path: string): Promise<unknown> => {
    if (path.endsWith('snapshot_index.json')) {
      if (opts.indexError) throw opts.indexError;
      return index;
    }
    // snapshots/<id>.json
    const match = /snapshots\/(.+)\.json$/.exec(path);
    if (match) {
      const id = match[1];
      if (manifests[id]) return manifests[id];
      throw new Error(`fixture: unknown manifest ${id}`);
    }
    throw new Error(`fixture: unexpected path ${path}`);
  });

  const dropbox: DropboxReader = { downloadJson: downloadJson as DropboxReader['downloadJson'] };
  const deps: ManifestCacheDeps = {
    dropbox,
    vaultPrefix: 'test-vault',
    logger: makeLogger(),
  };

  return { cache: new ManifestCache(deps), dropbox, downloadJson };
}

// ---------------------------------------------------------------------------
// ensureIndexLoaded
// ---------------------------------------------------------------------------

describe('ManifestCache.ensureIndexLoaded', () => {
  it('downloads snapshot_index.json on first call', async () => {
    const h = makeHarness();
    const idx = await h.cache.ensureIndexLoaded();
    expect(idx.snapshots).toHaveLength(1);
    expect(h.downloadJson).toHaveBeenCalledTimes(1);
  });

  it('returns cached index on subsequent calls (zero extra downloads)', async () => {
    const h = makeHarness();
    await h.cache.ensureIndexLoaded();
    await h.cache.ensureIndexLoaded();
    await h.cache.ensureIndexLoaded();
    expect(h.downloadJson).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent ensureIndexLoaded calls to ONE download', async () => {
    const h = makeHarness();
    await Promise.all([
      h.cache.ensureIndexLoaded(),
      h.cache.ensureIndexLoaded(),
      h.cache.ensureIndexLoaded(),
    ]);
    expect(h.downloadJson).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed index download; next call retries', async () => {
    const h = makeHarness({ indexError: new Error('network') });
    await expect(h.cache.ensureIndexLoaded()).rejects.toThrow('network');
    await expect(h.cache.ensureIndexLoaded()).rejects.toThrow('network');
    expect(h.downloadJson).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// loadManifest
// ---------------------------------------------------------------------------

describe('ManifestCache.loadManifest', () => {
  it('downloads manifest on first call, caches on subsequent calls', async () => {
    const manifest = makeManifest('2026-04-20T03-00-full', 'full');
    const h = makeHarness({
      index: makeIndex([{ id: '2026-04-20T03-00-full', type: 'full' }]),
      manifests: { '2026-04-20T03-00-full': manifest },
    });

    const first = await h.cache.loadManifest('2026-04-20T03-00-full');
    const second = await h.cache.loadManifest('2026-04-20T03-00-full');
    expect(first).toEqual(manifest);
    expect(second).toEqual(manifest);
    // 1 call for index + 1 call for manifest; second load hits cache.
    expect(h.downloadJson).toHaveBeenCalledTimes(2);
  });

  it('wraps parse failures in PathError(MANIFEST_PARSE_FAILED)', async () => {
    const h = makeHarness({
      index: makeIndex([{ id: '2026-04-20T03-00-full', type: 'full' }]),
    });
    // Override downloadJson to return a bad manifest for this id.
    h.downloadJson.mockImplementation(async (path: string) => {
      if (path.endsWith('snapshot_index.json')) {
        return makeIndex([{ id: '2026-04-20T03-00-full', type: 'full' }]);
      }
      return { broken: true }; // fails parseSnapshotManifest
    });
    await expect(h.cache.loadManifest('2026-04-20T03-00-full')).rejects.toBeInstanceOf(PathError);
  });
});

// ---------------------------------------------------------------------------
// listSnapshotsNewestFirst
// ---------------------------------------------------------------------------

describe('ManifestCache.listSnapshotsNewestFirst', () => {
  it('returns entries sorted newest-first by created_at', async () => {
    const h = makeHarness({
      index: makeIndex([
        { id: '2026-04-10T03-00-full', type: 'full', createdAt: '2026-04-10T03:00:00.000Z' },
        { id: '2026-04-20T03-00-full', type: 'full', createdAt: '2026-04-20T03:00:00.000Z' },
        { id: '2026-04-15T03-00-inc', type: 'inc', createdAt: '2026-04-15T03:00:00.000Z' },
      ]),
    });
    const list = await h.cache.listSnapshotsNewestFirst();
    expect(list.map((s) => s.id)).toEqual([
      '2026-04-20T03-00-full',
      '2026-04-15T03-00-inc',
      '2026-04-10T03-00-full',
    ]);
  });
});

// ---------------------------------------------------------------------------
// invalidate
// ---------------------------------------------------------------------------

describe('ManifestCache.invalidate', () => {
  it('clears both caches; next ensureIndexLoaded re-downloads', async () => {
    const h = makeHarness();
    await h.cache.ensureIndexLoaded();
    expect(h.downloadJson).toHaveBeenCalledTimes(1);

    h.cache.invalidate();
    await h.cache.ensureIndexLoaded();
    expect(h.downloadJson).toHaveBeenCalledTimes(2);
  });

  it('clears cached manifests; next loadManifest re-downloads', async () => {
    const manifest = makeManifest('2026-04-20T03-00-full', 'full');
    const h = makeHarness({
      manifests: { '2026-04-20T03-00-full': manifest },
      index: makeIndex([{ id: '2026-04-20T03-00-full', type: 'full' }]),
    });
    await h.cache.loadManifest('2026-04-20T03-00-full');
    const callsBefore = h.downloadJson.mock.calls.length;

    h.cache.invalidate();
    await h.cache.loadManifest('2026-04-20T03-00-full');
    const callsAfter = h.downloadJson.mock.calls.length;
    // Invalidation forces both index + manifest re-download.
    expect(callsAfter - callsBefore).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// L4: per-id manifest cache is bounded — beyond MANIFEST_CACHE_MAX_ENTRIES
// the least-recently-used entry is evicted, with LRU-on-hit promotion so a
// frequently-accessed manifest survives an unrelated browse spree.
// ---------------------------------------------------------------------------

describe('ManifestCache LRU eviction (L4)', () => {
  function manyManifestsHarness(count: number): {
    h: Harness;
    ids: string[];
  } {
    const ids = Array.from({ length: count }, (_, i) =>
      `2026-04-${String(10 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}-00-inc`,
    );
    const manifests: Record<string, SnapshotManifest> = {};
    for (const id of ids) manifests[id] = makeManifest(id);
    const h = makeHarness({
      manifests,
      index: makeIndex(ids.map((id) => ({ id, type: 'inc' as const }))),
    });
    return { h, ids };
  }

  it('caches up to 50 distinct manifests without eviction', async () => {
    const { h, ids } = manyManifestsHarness(50);
    for (const id of ids) await h.cache.loadManifest(id);
    const callsAfterAllLoaded = h.downloadJson.mock.calls.length;
    // Re-fetch the first id — should still be cached, no extra download.
    await h.cache.loadManifest(ids[0]);
    expect(h.downloadJson.mock.calls.length).toBe(callsAfterAllLoaded);
  });

  it('evicts the oldest entry when the cap is exceeded', async () => {
    const { h, ids } = manyManifestsHarness(51);
    for (const id of ids) await h.cache.loadManifest(id);
    const callsAfterAllLoaded = h.downloadJson.mock.calls.length;
    // Most recent (last) is still cached — no extra download.
    await h.cache.loadManifest(ids[50]);
    expect(h.downloadJson.mock.calls.length).toBe(callsAfterAllLoaded);
    // Oldest (ids[0]) was evicted to make room for ids[50] — re-fetch
    // requires a new download.
    await h.cache.loadManifest(ids[0]);
    expect(h.downloadJson.mock.calls.length).toBe(callsAfterAllLoaded + 1);
  });

  it('LRU touch on hit prevents premature eviction of a hot id', async () => {
    const { h, ids } = manyManifestsHarness(50);
    // Load all 50 — fills the cache.
    for (const id of ids) await h.cache.loadManifest(id);
    // Promote ids[0] to most-recent by re-fetching.
    await h.cache.loadManifest(ids[0]);
    // Insert one more (id[50] would be the eviction trigger). Use a
    // manifest not already in the cache.
    const newId = '2026-05-01T00-00-inc';
    h.downloadJson.mockImplementationOnce(async () => makeManifest(newId));
    await h.cache.loadManifest(newId);
    const callsAfterPush = h.downloadJson.mock.calls.length;

    // ids[0] survived (was touched right before the push), so re-fetch
    // hits cache, no new download.
    await h.cache.loadManifest(ids[0]);
    expect(h.downloadJson.mock.calls.length).toBe(callsAfterPush);
    // ids[1] was the oldest after the touch — it should have been evicted.
    await h.cache.loadManifest(ids[1]);
    expect(h.downloadJson.mock.calls.length).toBe(callsAfterPush + 1);
  });
});
