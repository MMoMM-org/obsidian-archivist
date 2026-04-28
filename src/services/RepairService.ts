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
import type { SnapshotManifest } from '../model/Manifest';
import { isSnapshotManifest } from '../model/Manifest';
import { snapshotsDir } from '../util/paths';
import type { SnapshotIndexStore } from './SnapshotIndexStore';
import type { GCService, GCResult } from './GCService';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RepairServiceDeps {
  dropbox: DropboxClient;
  snapshotIndexStore: SnapshotIndexStore;
  gcService: GCService;
  vaultPrefix: string;
  logger: Logger;
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
    const { manifests, invalidManifests } = await this.downloadValidManifests(entries);

    const validIds = new Set(manifests.map((m) => m.id));
    const phantomsRemoved = [...existing].filter((id) => !validIds.has(id));
    const kept = [...existing].filter((id) => validIds.has(id));

    await snapshotIndexStore.rebuild(manifests);

    logger.info('repair_index_rebuilt', {
      kept_count: kept.length,
      phantoms_removed_count: phantomsRemoved.length,
      invalid_manifest_count: invalidManifests.length,
    });

    return { phantomsRemoved, kept, invalidManifests };
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

  private async downloadValidManifests(
    entries: Array<{ path: string }>,
  ): Promise<{ manifests: SnapshotManifest[]; invalidManifests: string[] }> {
    const manifests: SnapshotManifest[] = [];
    const invalidManifests: string[] = [];
    for (const entry of entries) {
      try {
        const raw = await this.deps.dropbox.downloadJson<unknown>(entry.path);
        if (isSnapshotManifest(raw)) {
          manifests.push(raw);
        } else {
          this.deps.logger.warn('repair_manifest_invalid_schema', { path: entry.path });
          invalidManifests.push(entry.path);
        }
      } catch (err) {
        this.deps.logger.warn('repair_manifest_download_failed', {
          path: entry.path,
          error: err instanceof Error ? err.message : String(err),
        });
        invalidManifests.push(entry.path);
      }
    }
    return { manifests, invalidManifests };
  }
}
