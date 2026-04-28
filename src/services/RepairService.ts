// RepairService — user-triggerable recovery actions for Dropbox-side
// corruption that the automated paths can't always self-heal.
//
// Two operations are exposed today:
//
//   - rebuildSnapshotIndex(): re-derives `snapshot_index.json` from the
//     actual manifests under `<prefix>/snapshots/`. This removes phantom
//     entries — index rows whose manifest the user already deleted (or
//     that never existed). The reverse direction (manifest exists but
//     index doesn't have it) is handled by StartupRecovery; this service
//     covers the case StartupRecovery deliberately ignores.
//
//   - gcOrphanContent(): triggers GCService.sweep() outside the retention
//     schedule. Useful right after a manual cleanup to free the content
//     blobs the deleted manifest pointed at, instead of waiting up to 24 h
//     for the next retention pass to fire it implicitly.
//
// Both operations are designed to be safe to invoke at any time: the GC
// has its own gc_lock, and snapshot_index rebuild uses the same write
// queue that the regular append/remove flow uses (ROB-003).

import { CorruptionError, PathError } from '../model/Errors';
import type { DropboxClient } from '../infra/DropboxClient';
import type { Logger } from '../infra/Logger';
import { isSnapshotManifest } from '../model/Manifest';
import type { SnapshotIndexEntry } from '../model/SnapshotIndex';
import { gcLockPath, snapshotsDir } from '../util/paths';
import type { SnapshotIndexStore } from './SnapshotIndexStore';
import { manifestToIndexEntry } from './SnapshotIndexStore';
import type { GCService, GCResult } from './GCService';

/**
 * Manifest-download fan-out width. 8 in-flight requests is well below
 * Dropbox's 200-req/min user-rate budget for a manual repair op while
 * giving an order-of-magnitude speedup over the previous serial loop on
 * vaults with hundreds of snapshots.
 */
const MANIFEST_DOWNLOAD_BATCH_SIZE = 8;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RepairServiceDeps {
  dropbox: DropboxClient;
  snapshotIndexStore: SnapshotIndexStore;
  gcService: GCService;
  vaultPrefix: string;
  logger: Logger;
  /**
   * Optional manifest-cache invalidator. The cache is process-local;
   * after rebuilding the index on Dropbox, callers (e.g. the Backup
   * Browser) would otherwise still see the stale list until plugin
   * reload. A repair always invalidates downstream caches.
   */
  invalidateManifestCache?: () => void;
}

export interface RebuildResult {
  /** IDs the index claimed but no valid manifest existed for — now removed. */
  phantomsRemoved: string[];
  /** IDs that were both in the index and had a valid manifest. */
  kept: string[];
  /** Manifest paths that failed to download or parse — kept out of the rebuilt index. */
  invalidManifests: string[];
}

// ---------------------------------------------------------------------------
// RepairService
// ---------------------------------------------------------------------------

export class RepairService {
  constructor(private readonly deps: RepairServiceDeps) {}

  /**
   * Rebuild `snapshot_index.json` from the real list of manifests on
   * Dropbox. After this returns, the index contains exactly the snapshots
   * for which a manifest file currently exists and parses validly. Any
   * pre-existing index entries pointing at missing or corrupt manifests
   * are dropped.
   *
   * Idempotent: a second call against a healthy index produces the same
   * index byte-for-byte (modulo the `last_updated_at` timestamp).
   */
  async rebuildSnapshotIndex(): Promise<RebuildResult> {
    const { snapshotIndexStore, vaultPrefix, logger } = this.deps;

    const existing = await this.readExistingIndexIds();

    const entries = await this.listManifestEntries(vaultPrefix);
    const { indexEntries, invalidManifests } = await this.downloadValidManifests(entries);

    const validIds = new Set(indexEntries.map((e) => e.id));
    const phantomsRemoved = [...existing].filter((id) => !validIds.has(id));
    const kept = [...existing].filter((id) => validIds.has(id));

    await snapshotIndexStore.rebuildFromEntries(indexEntries);
    this.deps.invalidateManifestCache?.();

    logger.info('repair_index_rebuilt', {
      kept_count: kept.length,
      phantoms_removed_count: phantomsRemoved.length,
      invalid_manifest_count: invalidManifests.length,
    });

    return { phantomsRemoved, kept, invalidManifests };
  }

  /**
   * Force-clear `<prefix>/gc_lock`. Use only when a previous sweep
   * crashed and left the lock behind — the GC age-gate normally
   * auto-recovers from stale locks but only after 65 minutes. This is
   * the manual escape hatch for users who don't want to wait.
   *
   * Safe to call when the lock doesn't exist (logs and returns false).
   * Returns true when a lock was actually deleted.
   */
  async clearGcLock(): Promise<boolean> {
    const { dropbox, vaultPrefix, logger } = this.deps;
    const path = gcLockPath(vaultPrefix);
    try {
      await dropbox.deleteV2(path);
      logger.info('gc_lock_cleared', { path });
      return true;
    } catch (err) {
      if (err instanceof PathError && err.code === 'PATH_NOT_FOUND') {
        logger.info('gc_lock_clear_no_lock', {});
        return false;
      }
      throw err;
    }
  }

  /**
   * Trigger a GC sweep outside the retention schedule. Returns the raw
   * `GCResult` from `GCService.sweep()` so callers can surface
   * skipped_locked / skipped_no_index / swept distinctly.
   */
  async gcOrphanContent(): Promise<GCResult> {
    return this.deps.gcService.sweep();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Read the existing snapshot_index.json and return the set of snapshot
   * IDs it claims. Treats both "file missing" and "file corrupt" as "no
   * IDs known" — a corrupt index is exactly the case the rebuild is
   * meant to fix, so we shouldn't fail the whole operation reading it.
   */
  private async readExistingIndexIds(): Promise<Set<string>> {
    try {
      const idx = await this.deps.snapshotIndexStore.read();
      if (!idx) return new Set();
      return new Set(idx.snapshots.map((s) => s.id));
    } catch (err) {
      if (err instanceof CorruptionError && err.code === 'SNAPSHOT_INDEX_INVALID') {
        this.deps.logger.warn('repair_index_existing_corrupt', {
          error: err.message,
        });
        return new Set();
      }
      throw err;
    }
  }

  /**
   * List `<prefix>/snapshots/` and return the file entries. Treats a
   * missing folder as "no manifests" rather than an error — that's a
   * fresh-folder vault, where rebuild produces an empty (but valid)
   * index.
   */
  private async listManifestEntries(
    vaultPrefix: string,
  ): Promise<Array<{ path: string }>> {
    try {
      const all = await this.deps.dropbox.listFolder(snapshotsDir(vaultPrefix));
      return all.filter((e) => e.path.endsWith('.json'));
    } catch (err) {
      if (err instanceof PathError && err.code === 'PATH_NOT_FOUND') return [];
      throw err;
    }
  }

  /**
   * Download manifests in parallel batches and reduce each one to an
   * `SnapshotIndexEntry` immediately so the full `files` map can be
   * garbage-collected before the next batch starts. On a vault with
   * hundreds of snapshots this is the difference between holding all
   * manifest contents in memory at once vs. one batch-worth.
   *
   * Concurrency is bounded by `MANIFEST_DOWNLOAD_BATCH_SIZE` to stay
   * well under Dropbox's user-rate budget on a manual repair op.
   */
  private async downloadValidManifests(
    entries: Array<{ path: string }>,
  ): Promise<{ indexEntries: SnapshotIndexEntry[]; invalidManifests: string[] }> {
    const indexEntries: SnapshotIndexEntry[] = [];
    const invalidManifests: string[] = [];
    for (let i = 0; i < entries.length; i += MANIFEST_DOWNLOAD_BATCH_SIZE) {
      const batch = entries.slice(i, i + MANIFEST_DOWNLOAD_BATCH_SIZE);
      const settled = await Promise.all(
        batch.map(async (entry) => this.fetchManifestEntry(entry.path)),
      );
      for (const result of settled) {
        if (result.kind === 'ok') indexEntries.push(result.entry);
        else invalidManifests.push(result.path);
      }
    }
    // Stable order: list-folder iteration ordering is preserved across
    // batches because we await each batch before kicking off the next.
    return { indexEntries, invalidManifests };
  }

  private async fetchManifestEntry(
    path: string,
  ): Promise<{ kind: 'ok'; entry: SnapshotIndexEntry } | { kind: 'invalid'; path: string }> {
    try {
      const raw = await this.deps.dropbox.downloadJson<unknown>(path);
      if (isSnapshotManifest(raw)) {
        return { kind: 'ok', entry: manifestToIndexEntry(raw) };
      }
      this.deps.logger.warn('repair_manifest_invalid_schema', { path });
      return { kind: 'invalid', path };
    } catch (err) {
      this.deps.logger.warn('repair_manifest_download_failed', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'invalid', path };
    }
  }
}
