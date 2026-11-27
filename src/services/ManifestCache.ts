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
  private hits = 0;
  private misses = 0;

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
      const t0 = Date.now();
      const raw = await this.deps.dropbox.downloadJson(snapshotIndexPath(this.deps.vaultPrefix));
      const t1 = Date.now();
      const parsed = parseSnapshotIndex(raw);
      this.indexCache = parsed;
      this.deps.logger.debug('snapshot_index_loaded', {
        snapshot_count: parsed.snapshots.length,
        blob_hash_count: parsed.snapshots.reduce((n, s) => n + s.blob_hashes.length, 0),
        download_ms: t1 - t0,
        parse_ms: Date.now() - t1,
      });
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
      this.hits += 1;
      this.deps.logger.debug('manifest_loaded', { id, cache: 'hit' });
      return cached;
    }

    this.misses += 1;
    await this.ensureIndexLoaded();
    const t0 = Date.now();
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
    this.deps.logger.debug('manifest_loaded', {
      id,
      cache: 'miss',
      type: parsed.type,
      file_count: Object.keys(parsed.files).length,
      ms: Date.now() - t0,
    });
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

  /**
   * Load the manifests of `ids` for a per-path history (File versions view,
   * Show history command). Order follows `ids`; a missing or corrupt
   * manifest is skipped so one bad snapshot does not hide the others.
   *
   * Logs one diagnostic summary so the cost of opening a long history is
   * measurable (#134): with more snapshots than the cache holds, every open
   * downloads most manifests again. Hit/miss counts are deltas of the shared
   * counters, so a concurrent load elsewhere can blur them slightly.
   */
  async loadManifestsForHistory(ids: readonly string[]): Promise<SnapshotManifest[]> {
    const t0 = Date.now();
    const hits0 = this.hits;
    const misses0 = this.misses;
    const settled = await Promise.allSettled(ids.map((id) => this.loadManifest(id)));
    const manifests: SnapshotManifest[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') manifests.push(result.value);
    }
    this.deps.logger.debug('history_manifests_loaded', {
      snapshot_count: ids.length,
      loaded: manifests.length,
      failed: ids.length - manifests.length,
      cache_hits: this.hits - hits0,
      cache_misses: this.misses - misses0,
      cache_max: MANIFEST_CACHE_MAX_ENTRIES,
      ms: Date.now() - t0,
    });
    return manifests;
  }

  /** Cache counters for the diagnostics command (#143). Counts since plugin load. */
  getStats(): { cached: number; max: number; hits: number; misses: number } {
    return {
      cached: this.manifestById.size,
      max: MANIFEST_CACHE_MAX_ENTRIES,
      hits: this.hits,
      misses: this.misses,
    };
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
