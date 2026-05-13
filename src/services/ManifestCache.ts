// ManifestCache — in-memory cache over snapshot_index.json + per-id manifest
// downloads (T8.4 / PERF-C3).
//
// Invariants:
//   - First use downloads snapshot_index.json (1 request) and populates the
//     index cache.
//   - Per-id manifests are lazy — only downloaded on demand, then cached.
//   - invalidate() clears both caches. Called after a local commitSnapshot
//     so the next query sees the new manifest + index entry.
//   - The cache is process-local, not persisted. A plugin restart reloads.
//
// Satisfies the RestoreService.ManifestLoader contract so RestoreService can
// be wired either to a fixture loader (tests) or to a cache (production).

import { PathError } from '../model/Errors';
import type { SnapshotManifest } from '../model/Manifest';
import { parseSnapshotManifest } from '../model/Manifest';
import type { SnapshotIndex } from '../model/SnapshotIndex';
import { parseSnapshotIndex } from '../model/SnapshotIndex';
import type { Logger } from '../infra/Logger';
import { snapshotPath, snapshotIndexPath } from '../util/paths';
import type { ManifestLoader } from './RestoreService';

export interface DropboxReader {
  downloadJson<T>(path: string, opts?: { isManifestEndpoint?: boolean }): Promise<T>;
}

export interface ManifestCacheDeps {
  dropbox: DropboxReader;
  vaultPrefix: string;
  logger: Logger;
}

/**
 * Per-id manifest cache cap. A FULL manifest of a 10k-file vault is
 * around a megabyte of in-memory entries; without a cap, a power user
 * browsing many historical snapshots over a single Obsidian session
 * would accumulate all of them indefinitely. 50 covers comfortable
 * scrolling around a working set without unbounded growth.
 */
const MANIFEST_CACHE_MAX_ENTRIES = 50;

export class ManifestCache implements ManifestLoader {
  private indexCache: SnapshotIndex | null = null;
  /**
   * LRU keyed by snapshot id. Map preserves insertion order, so the
   * oldest entry is the first key — re-insertion on every hit promotes
   * to the most-recent end, and the cap eviction takes the head.
   */
  private readonly manifestById = new Map<string, SnapshotManifest>();

  constructor(private readonly deps: ManifestCacheDeps) {}

  /**
   * Ensure the snapshot-index is loaded. Idempotent — concurrent callers
   * share a single in-flight download via the promise latch pattern.
   */
  private indexPromise: Promise<SnapshotIndex> | null = null;

  async ensureIndexLoaded(): Promise<SnapshotIndex> {
    if (this.indexCache) return this.indexCache;
    if (this.indexPromise) return this.indexPromise;
    this.indexPromise = (async (): Promise<SnapshotIndex> => {
      const raw = await this.deps.dropbox.downloadJson(snapshotIndexPath(this.deps.vaultPrefix));
      const parsed = parseSnapshotIndex(raw);
      this.indexCache = parsed;
      return parsed;
    })();
    this.indexPromise.catch(() => {
      this.indexPromise = null;
    });
    try {
      return await this.indexPromise;
    } finally {
      // Success or failure, drop the latch so a later caller can retry.
      if (this.indexCache === null) this.indexPromise = null;
    }
  }

  /** Lazy manifest load with per-id LRU memoisation (cap MANIFEST_CACHE_MAX_ENTRIES). */
  async loadManifest(id: string): Promise<SnapshotManifest> {
    const cached = this.manifestById.get(id);
    if (cached) {
      // LRU touch: re-insert so this id is the most-recently-used.
      this.manifestById.delete(id);
      this.manifestById.set(id, cached);
      return cached;
    }

    await this.ensureIndexLoaded();
    const raw = await this.deps.dropbox.downloadJson(
      snapshotPath({ vault_prefix: this.deps.vaultPrefix, id }),
      { isManifestEndpoint: true },
    );
    let parsed: SnapshotManifest;
    try {
      parsed = parseSnapshotManifest(raw);
    } catch (err) {
      throw new PathError(
        'MANIFEST_PARSE_FAILED',
        `Failed to parse manifest ${id}: ${err instanceof Error ? err.message : String(err)}`,
        false,
        err,
      );
    }
    this.manifestById.set(id, parsed);
    if (this.manifestById.size > MANIFEST_CACHE_MAX_ENTRIES) {
      // Evict the oldest entry (Map iteration order is insertion order).
      for (const oldestKey of this.manifestById.keys()) {
        this.manifestById.delete(oldestKey);
        break;
      }
    }
    return parsed;
  }

  /** Return a newest-first copy of the cached index entries. */
  async listSnapshotsNewestFirst(): Promise<SnapshotIndex['snapshots']> {
    const idx = await this.ensureIndexLoaded();
    return idx.snapshots
      .slice()
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }

  /**
   * Clear both the index and the per-id manifest cache. Called after a
   * local commitSnapshot so the next query sees the new manifest + index.
   */
  invalidate(): void {
    this.indexCache = null;
    this.indexPromise = null;
    this.manifestById.clear();
    this.deps.logger.debug('manifest_cache_invalidated', {});
  }
}
