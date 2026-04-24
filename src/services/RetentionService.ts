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
import type { SnapshotIndex } from '../model/SnapshotIndex';
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
  | 'no_op_all_kept';

export interface RetentionResult {
  ran: boolean;
  pruned_ids: string[];
  failed_deletes: string[];
  state: RetentionState;
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
      void this.triggerGcSweep?.();
    }

    const state: RetentionState = pruned.length === 0 && failed.length === 0
      ? 'no_op_all_kept'
      : 'pruned';

    return { ran: true, pruned_ids: pruned, failed_deletes: failed, state };
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
