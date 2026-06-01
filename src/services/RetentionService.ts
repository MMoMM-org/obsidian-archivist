// RetentionService — metadata-only retention orchestrator (ADR-17/20, T6.3).
//
// PERF-C1: reads only snapshot_index.json — never downloads individual manifest
// bodies during the happy path. The 2-second SLO depends on this invariant.
//
// ROB-002: triggerGcSweep is fire-and-forget. RetentionService never awaits it.
// Phase 7 wires MaintenanceScheduler → RetentionService.runIfDue() and supplies
// the triggerGcSweep callback that calls GCService.sweep().

import type { DropboxClient } from '../infra/DropboxClient';
import type { Logger } from '../infra/Logger';
import { CorruptionError } from '../model/Errors';
import type { LocalIndex } from '../model/Index';
import type { SnapshotManifest } from '../model/Manifest';
import { isSnapshotManifest } from '../model/Manifest';
import type { PluginSettings } from '../model/Settings';
import type { SnapshotIndex, SnapshotIndexEntry, SnapshotTier } from '../model/SnapshotIndex';
import type { SnapshotIndexStore } from './SnapshotIndexStore';
import { evaluateTiers } from './retention/evaluator';
import { augmentWithAncestors } from './retention/chainIntegrity';
import { snapshotsDir, snapshotPath } from '../util/paths';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RetentionState =
  | 'skipped_throttle'
  | 'pruned'
  | 'no_op_fresh'
  | 'no_op_all_kept'
  | 'all_deletes_failed';

export interface RetentionResult {
  ran: boolean;
  pruned_ids: string[];
  failed_deletes: string[];
  state: RetentionState;
}

/** Snapshot row in a dry-run result — enough context to explain *why* the
 *  user is looking at it without exposing internal index objects. */
export interface RetentionDryRunRow {
  id: string;
  type: 'full' | 'inc';
  created_at: string;
  tier: SnapshotTier | null;
}

export type RetentionDryRunState =
  | 'evaluated'        // ran the diff; would_prune is authoritative
  | 'no_op_fresh'      // local index missing or empty — nothing to evaluate
  | 'no_op_all_kept';  // ran the diff; every snapshot is kept

export interface RetentionDryRunResult {
  state: RetentionDryRunState;
  total_snapshots: number;
  would_prune: RetentionDryRunRow[];
  would_keep: RetentionDryRunRow[];
}

export interface PluginStoreLike {
  loadIndex(): Promise<LocalIndex | null>;
  saveIndex(index: LocalIndex): Promise<void>;
  loadSettings(): Promise<PluginSettings>;
}

export interface RetentionServiceDeps {
  dropbox: DropboxClient;
  pluginStore: PluginStoreLike;
  snapshotIndexStore: SnapshotIndexStore;
  logger: Logger;
  vaultPrefix: string;
  /** Fire-and-forget GC trigger. Phase 7 wires MaintenanceScheduler here. */
  triggerGcSweep?: () => void;
  /** Injectable clock for testability. */
  now?: () => Date;
}

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// RetentionService
// ---------------------------------------------------------------------------

export class RetentionService {
  private readonly dropbox: DropboxClient;
  private readonly pluginStore: PluginStoreLike;
  private readonly snapshotIndexStore: SnapshotIndexStore;
  private readonly logger: Logger;
  private readonly vaultPrefix: string;
  private readonly triggerGcSweep: (() => void) | undefined;
  private readonly clock: () => Date;

  constructor(deps: RetentionServiceDeps) {
    this.dropbox = deps.dropbox;
    this.pluginStore = deps.pluginStore;
    this.snapshotIndexStore = deps.snapshotIndexStore;
    this.logger = deps.logger;
    this.vaultPrefix = deps.vaultPrefix;
    this.triggerGcSweep = deps.triggerGcSweep;
    this.clock = deps.now ?? (() => new Date());
  }

  async runIfDue(now: Date = this.clock()): Promise<RetentionResult> {
    const localIndex = await this.pluginStore.loadIndex();
    if (!localIndex) {
      return { ran: false, pruned_ids: [], failed_deletes: [], state: 'no_op_fresh' };
    }

    if (!this.isDue(localIndex.last_retention_at, now)) {
      return { ran: false, pruned_ids: [], failed_deletes: [], state: 'skipped_throttle' };
    }

    const settings = await this.pluginStore.loadSettings();
    const index = await this.loadOrRebuildIndex();

    if (!index) {
      await this.persistTimestamp(localIndex, now);
      return { ran: true, pruned_ids: [], failed_deletes: [], state: 'no_op_fresh' };
    }

    const keepSet = this.computeKeepSet(index, settings, now);
    const { pruned, failed } = await this.pruneSnapshots(index, keepSet);

    await this.persistTimestamp(localIndex, now);

    if (pruned.length > 0) {
      try {
        void this.triggerGcSweep?.();
      } catch (err) {
        this.logger.warn('gc_sweep_trigger_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const state: RetentionState = resolveState(pruned, failed);

    return { ran: true, pruned_ids: pruned, failed_deletes: failed, state };
  }

  /**
   * Dry-run variant of `runIfDue`: bypasses the 24h throttle and reports
   * which snapshots WOULD be pruned under the current retention policy
   * without touching Dropbox or the snapshot index. Used by the
   * "Preview retention" command so users (and tests) can inspect what
   * retention would do before letting it actually run.
   *
   * Side-effect free: no Dropbox calls beyond what
   * `loadOrRebuildIndex` already does for the regular run (the index may
   * still be lazily rebuilt from manifests if the snapshot_index.json is
   * missing — that's a read-only operation). `last_retention_at` is
   * intentionally NOT updated, so the next scheduled `runIfDue` is
   * unaffected by a manual dry-run preview.
   */
  async dryRun(now: Date = this.clock()): Promise<RetentionDryRunResult> {
    const localIndex = await this.pluginStore.loadIndex();
    if (!localIndex) {
      return { state: 'no_op_fresh', total_snapshots: 0, would_prune: [], would_keep: [] };
    }

    const settings = await this.pluginStore.loadSettings();
    const index = await this.loadOrRebuildIndex();
    if (!index || index.snapshots.length === 0) {
      return { state: 'no_op_fresh', total_snapshots: 0, would_prune: [], would_keep: [] };
    }

    const keepSet = this.computeKeepSet(index, settings, now);
    const wouldPrune: RetentionDryRunRow[] = [];
    const wouldKeep: RetentionDryRunRow[] = [];
    for (const snap of index.snapshots) {
      const row = toDryRunRow(snap);
      if (keepSet.has(snap.id)) wouldKeep.push(row);
      else wouldPrune.push(row);
    }

    return {
      state: wouldPrune.length === 0 ? 'no_op_all_kept' : 'evaluated',
      total_snapshots: index.snapshots.length,
      would_prune: wouldPrune,
      would_keep: wouldKeep,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isDue(lastRetentionAt: string | null, now: Date): boolean {
    if (lastRetentionAt === null) return true;
    return now.getTime() - new Date(lastRetentionAt).getTime() >= RETENTION_INTERVAL_MS;
  }

  private async loadOrRebuildIndex(): Promise<SnapshotIndex | null> {
    try {
      const index = await this.snapshotIndexStore.read();
      if (index) return index;
    } catch (err) {
      if (err instanceof CorruptionError && err.code === 'SNAPSHOT_INDEX_INVALID') {
        this.logger.warn('retention_index_fallback', { error: err });
      } else {
        throw err;
      }
    }

    return this.rebuildIndex();
  }

  private async rebuildIndex(): Promise<SnapshotIndex | null> {
    const entries = await this.dropbox.listFolder(snapshotsDir(this.vaultPrefix));
    const manifests = await this.downloadValidManifests(entries);
    await this.snapshotIndexStore.rebuild(manifests);
    return this.snapshotIndexStore.read();
  }

  private async downloadValidManifests(
    entries: Array<{ path: string }>,
  ): Promise<SnapshotManifest[]> {
    const manifests: SnapshotManifest[] = [];
    for (const entry of entries) {
      try {
        const raw = await this.dropbox.downloadJson<unknown>(entry.path);
        if (isSnapshotManifest(raw)) {
          manifests.push(raw);
        } else {
          this.logger.warn('retention_fallback_manifest_invalid', { path: entry.path });
        }
      } catch (err) {
        this.logger.warn('retention_fallback_manifest_download_failed', {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
    return manifests;
  }

  private computeKeepSet(index: SnapshotIndex, settings: PluginSettings, now: Date): Set<string> {
    const tierKept = evaluateTiers(index.snapshots, settings.retention, now);
    return augmentWithAncestors(tierKept, index.snapshots, this.logger);
  }

  private async pruneSnapshots(
    index: SnapshotIndex,
    keepSet: Set<string>,
  ): Promise<{ pruned: string[]; failed: string[] }> {
    const allIds = new Set(index.snapshots.map((s) => s.id));
    const pruneIds = [...allIds].filter((id) => !keepSet.has(id));
    const pruned: string[] = [];
    const failed: string[] = [];

    for (const id of pruneIds) {
      try {
        await this.dropbox.deleteV2(snapshotPath({ vault_prefix: this.vaultPrefix, id }));
        await this.snapshotIndexStore.remove(id);
        this.logger.info('retention_pruned', { snapshot_id: id });
        pruned.push(id);
      } catch (err) {
        this.logger.warn('retention_delete_failed', {
          snapshot_id: id,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        failed.push(id);
      }
    }

    return { pruned, failed };
  }

  private async persistTimestamp(localIndex: LocalIndex, now: Date): Promise<void> {
    await this.pluginStore.saveIndex({
      ...localIndex,
      last_retention_at: now.toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Resolve the retention result state from pruned/failed counts.
 *  - pruned > 0               → 'pruned'          (at least one success)
 *  - pruned === 0, failed > 0 → 'all_deletes_failed'
 *  - pruned === 0, failed === 0 → 'no_op_all_kept'
 */
function resolveState(pruned: string[], failed: string[]): RetentionState {
  if (pruned.length > 0) return 'pruned';
  if (failed.length > 0) return 'all_deletes_failed';
  return 'no_op_all_kept';
}

/** Project a SnapshotIndexEntry to the leaner shape returned by dryRun. */
function toDryRunRow(snap: SnapshotIndexEntry): RetentionDryRunRow {
  return {
    id: snap.id,
    type: snap.type,
    created_at: snap.created_at,
    tier: snap.tier ?? null,
  };
}
