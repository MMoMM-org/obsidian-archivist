// StartupRecovery — crash-recovery matrix + unified StartupState (T5.5 / ROB-008).
//
// Public API: `recoverOnStartup()` runs in a fixed ordered sequence and returns
// a single StartupReport that the scheduler FSM (Phase 7) consumes to decide
// the initial run mode.
//
// Ordered sequence (spec T5.5 bullet 3):
//   1. loadSettings  (spec-order compliance; not inspected by recovery)
//   2. loadIndex
//   3. loadQueue     (spec-order compliance; consumed by Phase 7 scheduler)
//   4. listFolder(snapshots/)
//   5. Early returns: INDEX_MISSING, FRESH_FOLDER
//   6. Download all manifests from snapshots/
//   7. Check snapshot_index completeness → rebuild if stale
//   8. Validate HEAD correctness → rewrite if stale/missing/orphan
//   9. Row 7 reconcile: merge manifest files into local index
//  10. Check gc_lock staleness
//  11. Persist updated index
//  12. Return StartupReport
//
// Design decisions:
//   - Row 7 reconcile replaces index.files with manifest.files for any path
//     present in the manifest but missing/stale in the index. This is
//     authoritative: the newest committed snapshot IS the ground truth for
//     remote state. We do NOT re-hash vault files at startup (10k files would
//     be too expensive); recovery just syncs the index so the next inc only
//     uploads genuinely changed files.
//   - If snapshot_index is stale, the state is SNAPSHOT_INDEX_STALE unless a
//     more severe state (HEAD_STALE, HEAD_POINTS_TO_MISSING) is also triggered.
//     Multiple conditions are captured in `notes[]`; `state` reflects the
//     highest-priority condition.
//   - The gc_lock is flagged but NOT removed — the MaintenanceScheduler owns
//     removal (spec bullet g).

import { PathError } from '../model/Errors';
import { freshStartupReport, StartupState } from '../model/StartupState';
import type { StartupReport } from '../model/StartupState';
import type { LocalIndex } from '../model/Index';
import { emptyLocalIndex } from '../model/Index';
import type { SnapshotManifest } from '../model/Manifest';
import { isSnapshotManifest } from '../model/Manifest';
import type { DropboxClient } from '../infra/DropboxClient';
import type { Logger } from '../infra/Logger';
import { headPath, snapshotsDir } from '../util/paths';
import { gcLockPath } from '../util/paths';
import type { SnapshotIndexStore } from './SnapshotIndexStore';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StartupRecoveryDeps {
  dropbox: DropboxClient;
  pluginStore: PluginStoreLike;
  snapshotIndexStore: SnapshotIndexStore;
  logger: Logger;
  vaultPrefix: string;
  /** Injectable for tests — defaults to Date.now(). */
  now?: () => number;
  /** Threshold offset added to the 1h GC lock base — defaults to 5. */
  maxClockSkewMinutes?: number;
}

/** Minimal surface of PluginStore consumed by StartupRecovery. */
interface PluginStoreLike {
  loadSettings(): Promise<unknown>;
  loadIndex(): Promise<LocalIndex | null>;
  saveIndex(index: LocalIndex): Promise<void>;
  loadQueue(): Promise<unknown>;
}

// HEAD shape expected on Dropbox (same schema as DeviceCoordinator uses).
interface HeadJson {
  schema_version: string;
  snapshot_id: string;
  snapshot_type: string;
  device_id: string;
  committed_at: string;
}

interface GcLock {
  started_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GC_LOCK_BASE_HOURS = 1;
const DEFAULT_MAX_CLOCK_SKEW_MINUTES = 5;

// ---------------------------------------------------------------------------
// StartupRecovery
// ---------------------------------------------------------------------------

export class StartupRecovery {
  private readonly dropbox: DropboxClient;
  private readonly pluginStore: PluginStoreLike;
  private readonly snapshotIndexStore: SnapshotIndexStore;
  private readonly logger: Logger;
  private readonly vaultPrefix: string;
  private readonly now: () => number;
  private readonly maxClockSkewMinutes: number;

  constructor(deps: StartupRecoveryDeps) {
    this.dropbox = deps.dropbox;
    this.pluginStore = deps.pluginStore;
    this.snapshotIndexStore = deps.snapshotIndexStore;
    this.logger = deps.logger;
    this.vaultPrefix = deps.vaultPrefix;
    this.now = deps.now ?? (() => Date.now());
    this.maxClockSkewMinutes = deps.maxClockSkewMinutes ?? DEFAULT_MAX_CLOCK_SKEW_MINUTES;
  }

  async recoverOnStartup(): Promise<StartupReport> {
    // Step 1: loadSettings (spec-order compliance)
    await this.pluginStore.loadSettings();

    // Step 2: loadIndex
    const index = await this.pluginStore.loadIndex();

    // Step 3: loadQueue (spec-order compliance; consumed by Phase 7)
    await this.pluginStore.loadQueue();

    // Step 4: List snapshots/ directory
    const snapshotEntries = await this.listSnapshotsDir();

    // Step 5a: INDEX_MISSING early return
    if (index === null) {
      return this.handleIndexMissing();
    }

    // Step 5b: FRESH_FOLDER early return
    if (snapshotEntries.length === 0) {
      return this.handleFreshFolder();
    }

    // Step 6: Download all manifests from snapshots/
    const manifests = await this.downloadAllManifests(snapshotEntries);
    if (manifests.length === 0) {
      return this.handleFreshFolder();
    }

    const newestManifest = findNewest(manifests);

    const report = freshStartupReport(StartupState.HEALTHY);

    // Step 7: Check snapshot_index completeness
    await this.reconcileSnapshotIndex(manifests, report);

    // Step 8: Validate HEAD correctness
    await this.reconcileHead(newestManifest, manifests, report);

    // Step 9: Row 7 reconcile — merge manifest files into local index
    const updatedIndex = reconcileIndex(index, newestManifest);

    // Step 10: Check gc_lock staleness
    await this.checkGcLock(report);

    // Step 11: Persist updated index
    await this.pluginStore.saveIndex(updatedIndex);

    return report;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async handleIndexMissing(): Promise<StartupReport> {
    const missingIndex: LocalIndex = {
      ...emptyLocalIndex(),
      index_missing_recovery_required: true,
    };
    await this.pluginStore.saveIndex(missingIndex);
    return freshStartupReport(StartupState.INDEX_MISSING);
  }

  private async handleFreshFolder(): Promise<StartupReport> {
    // Delete HEAD if it exists (orphan HEAD with no snapshots)
    const hp = headPath(this.vaultPrefix);
    try {
      await this.dropbox.deleteV2(hp);
    } catch (err) {
      if (!(err instanceof PathError && err.code === 'PATH_NOT_FOUND')) {
        this.logger.warn('fresh_folder_head_delete_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return freshStartupReport(StartupState.FRESH_FOLDER);
  }

  private async listSnapshotsDir(): Promise<Array<{ path: string }>> {
    try {
      const entries = await this.dropbox.listFolder(snapshotsDir(this.vaultPrefix));
      return entries.filter((e) => e.tag === 'file' && e.path.endsWith('.json'));
    } catch (err) {
      if (err instanceof PathError && err.code === 'PATH_NOT_FOUND') return [];
      throw err;
    }
  }

  private async downloadAllManifests(entries: Array<{ path: string }>): Promise<SnapshotManifest[]> {
    const manifests: SnapshotManifest[] = [];
    for (const entry of entries) {
      try {
        const raw = await this.dropbox.downloadJson<unknown>(entry.path);
        if (isSnapshotManifest(raw)) {
          manifests.push(raw);
        } else {
          this.logger.warn('manifest_invalid_schema', { path: entry.path });
        }
      } catch (err) {
        this.logger.warn('manifest_download_failed', {
          path: entry.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return manifests;
  }

  private async reconcileSnapshotIndex(manifests: SnapshotManifest[], report: StartupReport): Promise<void> {
    let existingIndex: { snapshots: Array<{ id: string }> } | null = null;
    try {
      existingIndex = await this.snapshotIndexStore.read();
    } catch {
      existingIndex = null;
    }

    const indexedIds = new Set(existingIndex?.snapshots.map((s) => s.id) ?? []);
    const allIndexed = manifests.every((m) => indexedIds.has(m.id));

    if (!allIndexed) {
      await this.snapshotIndexStore.rebuild(manifests);
      report.notes.push('snapshot_index_rebuilt');
      if (report.state === StartupState.HEALTHY) {
        report.state = StartupState.SNAPSHOT_INDEX_STALE;
      }
    }
  }

  private async reconcileHead(
    newestManifest: SnapshotManifest,
    allManifests: SnapshotManifest[],
    report: StartupReport,
  ): Promise<void> {
    let headRaw: unknown = null;
    try {
      headRaw = await this.dropbox.downloadJson<unknown>(headPath(this.vaultPrefix));
    } catch (err) {
      if (!(err instanceof PathError && err.code === 'PATH_NOT_FOUND')) throw err;
      headRaw = null;
    }

    const head = parseHead(headRaw);

    if (head === null) {
      // HEAD absent or invalid — rewrite to newest
      await this.rewriteHead(newestManifest);
      if (report.state === StartupState.HEALTHY || report.state === StartupState.SNAPSHOT_INDEX_STALE) {
        report.state = StartupState.HEAD_POINTS_TO_MISSING;
      }
      return;
    }

    const manifestIds = new Set(allManifests.map((m) => m.id));

    if (!manifestIds.has(head.snapshot_id)) {
      // HEAD points at a snapshot that doesn't exist
      this.logger.warn('head_points_to_missing', {
        orphan_id: head.snapshot_id,
        rewriting_to: newestManifest.id,
      });
      await this.rewriteHead(newestManifest);
      report.state = StartupState.HEAD_POINTS_TO_MISSING;
      return;
    }

    if (head.snapshot_id !== newestManifest.id) {
      // HEAD exists but points at an older snapshot than the newest
      await this.rewriteHead(newestManifest);
      if (report.state === StartupState.HEALTHY || report.state === StartupState.SNAPSHOT_INDEX_STALE) {
        report.state = StartupState.HEAD_STALE;
      }
    }
    // else: HEAD matches newest — no action needed
  }

  private async rewriteHead(manifest: SnapshotManifest): Promise<void> {
    const head: HeadJson = {
      schema_version: '1.0',
      snapshot_id: manifest.id,
      snapshot_type: manifest.type,
      device_id: manifest.device_id,
      committed_at: manifest.created_at,
    };
    await this.dropbox.uploadJson(headPath(this.vaultPrefix), head);
  }

  private async checkGcLock(report: StartupReport): Promise<void> {
    let lockRaw: unknown = null;
    try {
      lockRaw = await this.dropbox.downloadJson<unknown>(gcLockPath(this.vaultPrefix));
    } catch (err) {
      if (err instanceof PathError && err.code === 'PATH_NOT_FOUND') return;
      throw err;
    }

    if (!isGcLock(lockRaw)) return;

    const startedAt = new Date(lockRaw.started_at).getTime();
    const thresholdMs = (GC_LOCK_BASE_HOURS * 60 + this.maxClockSkewMinutes) * 60 * 1000;

    if (this.now() - startedAt > thresholdMs) {
      report.stale_gc_lock = true;
      report.notes.push('stale_gc_lock');
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function findNewest(manifests: SnapshotManifest[]): SnapshotManifest {
  return manifests.reduce((best, m) => (m.created_at > best.created_at ? m : best));
}

/**
 * Parse HEAD JSON into a typed object. Returns null if the raw value is absent,
 * null, or fails the basic shape check (schema-invalid HEAD → treated as absent,
 * per SEC-M4 / DeviceCoordinator pattern).
 */
function parseHead(raw: unknown): HeadJson | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const h = raw as Record<string, unknown>;
  if (typeof h.snapshot_id !== 'string') return null;
  if (typeof h.snapshot_type !== 'string') return null;
  if (typeof h.device_id !== 'string') return null;
  if (typeof h.committed_at !== 'string') return null;
  return {
    schema_version: typeof h.schema_version === 'string' ? h.schema_version : '',
    snapshot_id: h.snapshot_id,
    snapshot_type: h.snapshot_type,
    device_id: h.device_id,
    committed_at: h.committed_at,
  };
}

function isGcLock(raw: unknown): raw is GcLock {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as Record<string, unknown>).started_at === 'string'
  );
}

/**
 * Row 7 reconcile: for each path in newestManifest.files that is missing from
 * index.files or has a different hash, update the index entry to the manifest's
 * committed state. Returns a new index object (no mutation).
 *
 * This brings the LocalIndex in sync with the last committed snapshot so the
 * next incremental computes a correct diff (only actually-changed files upload).
 */
function reconcileIndex(index: LocalIndex, newestManifest: SnapshotManifest): LocalIndex {
  const updatedFiles = { ...index.files };
  let changed = false;

  for (const [path, manifestEntry] of Object.entries(newestManifest.files)) {
    const indexEntry = updatedFiles[path];
    if (!indexEntry || indexEntry.hash !== manifestEntry.hash) {
      updatedFiles[path] = { ...manifestEntry };
      changed = true;
    }
  }

  if (!changed) return index;

  return {
    ...index,
    files: updatedFiles,
  };
}
