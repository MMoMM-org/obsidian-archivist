// BackupService — crash-safe 7-step commit protocol for full and incremental snapshots.
//
// Step order is non-negotiable (from SDD crash-recovery matrix):
//   1. Upload new content blobs (CAS, idempotent overwrite)
//   2. verifyNoConflict SECOND time (ROB-001 — shrinks race window)
//   3. Upload manifest JSON to snapshots/<id>.json
//   4. Append entry to snapshot_index.json (ADR-20)
//   5. Write HEAD.json
//   6. Update LocalIndex via PluginStore.saveIndex
//   7. Advance queue cursor via PluginStore.saveQueue
//
// Design invariants:
//   - No retry/backoff here — DropboxClient owns that.
//   - Exclusions are passed in by the caller (default null for T5.3).
//   - No MaintenanceScheduler wiring — that belongs in Phase 7 scheduler integration.
//   - Parallelism capped by settings.advanced.upload_parallelism (default 4).
//   - Adaptive chunk size: 8 MB for files < 50 MB, 150 MB for files >= 50 MB (PERF-M2).

import { buildFullManifest, buildIncManifest } from './ManifestBuilder';
import type { BackupProgressReporter } from './BackupProgress';
import type { ChangeDetector } from './ChangeDetector';
import type { SnapshotIndexStore } from './SnapshotIndexStore';
import type { DeviceCoordinator } from './DeviceCoordinator';
import type { DropboxClient } from '../infra/DropboxClient';
import type { EventQueue as EventQueueInfra } from '../infra/EventQueue';
import type { Logger } from '../infra/Logger';
import type { PluginStore } from '../infra/PluginStore';
import type { VaultAdapter } from '../infra/VaultAdapter';
import { ConfigError, PathError } from '../model/Errors';
import type { LocalIndex } from '../model/Index';
import type { QueueEntry } from '../model/QueueEntry';
import type { RenameEntry, SnapshotManifest } from '../model/Manifest';
import { contentPath, headPath, snapshotPath } from '../util/paths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SMALL_FILE_THRESHOLD_BYTES = 50 * 1024 * 1024;    // 50 MB
const SMALL_FILE_CHUNK_BYTES = 8 * 1024 * 1024;         // 8 MB
const LARGE_FILE_CHUNK_BYTES = 150 * 1024 * 1024;       // 150 MB
const DEFAULT_UPLOAD_PARALLELISM = 4;

/**
 * Hard ceiling on the once-per-session chain-integrity walk. Each step
 * is a Dropbox round-trip; at ~200 ms per call, 100 caps the worst-case
 * startup cost at ~20 s. Retention defaults bound the chain to "a few
 * dozen" so this is well above steady-state but well below the previous
 * 1000-link / ~3-min ceiling that bit users with retention disabled.
 * A chain that exceeds this is treated as broken with `reason:
 * 'depth_exceeded'` and the next backup re-bootstraps with a FULL.
 */
const CHAIN_WALK_MAX_DEPTH = 100;

/**
 * Soft warning threshold — at this depth we log once per chain walk so
 * we notice creeping chain length before it bites the depth ceiling.
 */
const CHAIN_WALK_DEPTH_WARN = 50;

const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Injectable hasher so tests can provide a real crypto.subtle sha256 without
 *  pulling in the full Hasher module. Production code passes `sha256hex`. */
export type HasherFn = (bytes: Uint8Array) => Promise<string>;

export interface BackupServiceDeps {
  dropbox: DropboxClient;
  vault: VaultAdapter;
  hasher: HasherFn;
  deviceCoordinator: DeviceCoordinator;
  pluginStore: PluginStore;
  snapshotIndexStore: SnapshotIndexStore;
  /**
   * The live, in-memory EventQueue. Required so cursor advances after a
   * commit go through the same opQueue as enqueues — without this routing,
   * the queue file ends up correct but the in-memory state is stale, and
   * FSM.getQueueSize keeps returning phantom pending events for an entire
   * inc_interval after every successful inc.
   */
  eventQueue: EventQueueInfra;
  vaultPrefix: string;
  vaultName: string;
  /**
   * Optional ChangeDetector. When provided AND
   * settings.advanced.reconcile_scan_enabled is true, the FIRST runIncremental
   * after construction performs a full vault reconcile pass to surface offline
   * changes (mutations that happened while Obsidian was closed). Subsequent
   * runs use the live event queue only — the live queue is authoritative once
   * Obsidian is running. Tests that only exercise the queue path may omit it.
   */
  changeDetector?: ChangeDetector;
  /**
   * Optional logger for backup lifecycle events ("Starting full backup",
   * "N files written", per-path debug lines). Tests omit it to stay quiet —
   * production code always provides one.
   */
  logger?: Logger;
  /**
   * Optional progress reporter — drives the live status-bar tooltip ("Archivist
   * — uploading 432/5988"). When absent (most tests, batch CLI flows) the
   * service is a strict no-op for progress events.
   */
  progress?: BackupProgressReporter;
  /**
   * Optional callback fired when the chain-walk probe detects that the local
   * chain references a manifest no longer on Dropbox. Triggers right before
   * runIncremental falls back to runFull. main.ts wires this to a persistent
   * banner so users see WHY a backup is suddenly running long. Tests omit it
   * — the recovery still happens silently.
   */
  onChainCorruptionDetected?: (info: {
    missingId: string | null;
    referrerId: string;
    walkedDepth: number;
  }) => void;
  /**
   * Optional vault-fingerprint guard. When provided, BackupService runs a
   * pre-write consistency check on every backup attempt and aborts on
   * 'mismatch' / 'remote-corrupt' / 'adopt-remote' (the UI handles
   * adoption — BackupService never silently claims a foreign folder).
   * On 'fresh-folder', the service writes vault_meta.json after the
   * first successful FULL so subsequent runs see 'ok'.
   */
  vaultIdentity?: VaultIdentitySubset;
  /** Injectable clock for deterministic tests. Defaults to new Date().toISOString(). */
  now?: () => string;
}

/**
 * Narrow subset of VaultIdentity that BackupService actually exercises.
 * Keeps the dep cycle one-way: BackupService → vault-identity contract,
 * not BackupService → src/services/VaultIdentity (which would make
 * VaultIdentity tests transitively pull in BackupService's deps).
 */
export interface VaultIdentitySubset {
  checkConsistency(): Promise<
    | { kind: 'ok'; localId: string; remote: { vault_id: string; vault_name: string } }
    | { kind: 'fresh-folder'; localId: string }
    | { kind: 'adopt-remote'; remote: { vault_id: string; vault_name: string } }
    | { kind: 'mismatch'; localId: string; remote: { vault_id: string; vault_name: string } }
    | { kind: 'remote-corrupt'; localId: string; rawError: string }
  >;
  claimRemote(localVaultId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// BackupService
// ---------------------------------------------------------------------------

export class BackupService {
  private readonly dropbox: DropboxClient;
  private readonly vault: VaultAdapter;
  private readonly hasher: HasherFn;
  private readonly coordinator: DeviceCoordinator;
  private readonly pluginStore: PluginStore;
  private readonly snapshotIndexStore: SnapshotIndexStore;
  private readonly eventQueue: EventQueueInfra;
  private readonly vaultPrefix: string;
  private readonly vaultName: string;
  private readonly changeDetector: ChangeDetector | null;
  private readonly logger: Logger;
  private readonly progress: BackupProgressReporter | null;
  private readonly onChainCorruptionDetected:
    | ((info: { missingId: string | null; referrerId: string; walkedDepth: number }) => void)
    | null;
  private readonly vaultIdentity: VaultIdentitySubset | null;
  private readonly now: () => string;

  /**
   * One-shot flag for the reconcile-on-startup pass. Flips to false after the
   * first runIncremental call (regardless of outcome) so subsequent ticks
   * never re-scan the entire vault — the live event queue is authoritative
   * once Obsidian is running.
   */
  private firstIncSinceLoad = true;

  /**
   * One-shot flag for the Dropbox parent-manifest existence check. We probe
   * the manifest of the snapshot we'd attach the next INC to (the
   * last_inc_snapshot_id, or last_full if no inc yet) on the first INC of
   * the session. If it's missing, the local chain is desynced from Dropbox
   * (user nuked the folder, restored an old backup, GC ran wild, ...) and
   * stacking another INC just deepens the orphan chain. Falling back to
   * FULL re-bootstraps. Flips to true after the first probe so steady-state
   * INCs don't pay the extra round-trip.
   *
   * Probes the *parent manifest*, not just HEAD.json — HEAD existing tells
   * us nothing about whether the manifest IT points to (or our local index
   * points to) is still on Dropbox.
   */
  private dropboxChainVerified = false;

  /**
   * Session cache for the vault-ownership check. Once we've confirmed
   * 'ok' (or moved through 'fresh-folder' + a successful claim), the
   * vault_meta on Dropbox cannot move out from under us within the
   * single-process lifetime — so subsequent backup runs return the
   * cached state without an extra `vault_meta.json` round-trip per run.
   *
   * Cleared by no public mechanism in V1 — adoption / repair currently
   * require a plugin reload, which constructs a fresh BackupService.
   * Mirrors `dropboxChainVerified` above.
   */
  private vaultOwnershipVerified: { freshFolder: boolean; localId: string | null } | null = null;

  constructor(deps: BackupServiceDeps) {
    this.dropbox = deps.dropbox;
    this.vault = deps.vault;
    this.hasher = deps.hasher;
    this.coordinator = deps.deviceCoordinator;
    this.pluginStore = deps.pluginStore;
    this.snapshotIndexStore = deps.snapshotIndexStore;
    this.eventQueue = deps.eventQueue;
    this.vaultPrefix = deps.vaultPrefix;
    this.vaultName = deps.vaultName;
    this.changeDetector = deps.changeDetector ?? null;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.progress = deps.progress ?? null;
    this.onChainCorruptionDetected = deps.onChainCorruptionDetected ?? null;
    this.vaultIdentity = deps.vaultIdentity ?? null;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Pre-write fingerprint check. Returns the consistency state so callers
   * (runFull, runIncremental) can react: 'ok' / 'fresh-folder' proceed,
   * everything else aborts with a clear error message that points at the
   * troubleshooting doc. When `vaultIdentity` was not injected, this is
   * a no-op (returns 'ok' with synthetic IDs) — keeps existing tests that
   * don't care about identity working unchanged.
   */
  private async assertVaultOwnership(): Promise<{ freshFolder: boolean; localId: string | null }> {
    if (!this.vaultIdentity) {
      return { freshFolder: false, localId: null };
    }
    // Session cache (H1): once we've verified ownership ('ok' or
    // post-claim), skip the per-backup vault_meta round-trip. Cleared
    // only by plugin reload — adoption / repair flows construct a
    // fresh BackupService.
    if (this.vaultOwnershipVerified) {
      return this.vaultOwnershipVerified;
    }
    const result = await this.vaultIdentity.checkConsistency();
    switch (result.kind) {
      case 'ok':
        this.vaultOwnershipVerified = { freshFolder: false, localId: result.localId };
        return this.vaultOwnershipVerified;
      case 'fresh-folder':
        // Don't cache yet — runFull will trigger claimRemote which
        // promotes us into the 'ok' state. The cache flips after the
        // claim succeeds (see runFull below).
        return { freshFolder: true, localId: result.localId };
      case 'adopt-remote':
        throw new ConfigError(
          'VAULT_ID_NEEDS_ADOPTION',
          `This Dropbox folder belongs to vault "${result.remote.vault_name}" (${result.remote.vault_id}). Reload Obsidian to re-open the Adopt dialog, or change Dropbox vault folder in Settings → Archivist → Dropbox to point at a different folder. See docs/operations/connecting-existing-backup.md.`,
          false,
        );
      case 'mismatch':
        throw new ConfigError(
          'VAULT_ID_MISMATCH',
          `Vault identity mismatch: local vault_id ${result.localId} does not match Dropbox vault_meta.vault_id ${result.remote.vault_id} (registered to "${result.remote.vault_name}"). Backup blocked to prevent cross-vault pollution. See docs/troubleshooting/dropbox-corruption.md.`,
          false,
        );
      case 'remote-corrupt':
        throw new ConfigError(
          'VAULT_META_CORRUPT',
          `Dropbox vault_meta.json failed schema validation (${result.rawError}). Backup blocked. Delete vault_meta.json on Dropbox to let the next backup recreate it, or run "Verify backup ownership" from the command palette to inspect. See docs/troubleshooting/dropbox-corruption.md.`,
          false,
        );
    }
  }

  /**
   * Internal helper: once a freshFolder claim succeeds, the next backup's
   * consistency check would return 'ok' for the same IDs — pre-fill the
   * cache so we skip the round-trip.
   */
  private markVaultOwnershipClaimed(localId: string): void {
    this.vaultOwnershipVerified = { freshFolder: false, localId };
  }

  /**
   * Execute a full vault backup following the 7-step crash-safe commit protocol.
   *
   * Throws on any error — the caller is responsible for surfacing the failure
   * to the user and scheduling recovery. Orphan blobs left by a mid-upload
   * crash are GC candidates (Phase 6).
   */
  async runFull(opts?: { exclusionsApplied?: string[] | null }): Promise<{ filesWritten: number }> {
    const exclusionsApplied = opts?.exclusionsApplied ?? null;
    const createdAt = this.now();
    this.logger.info('Starting full backup');
    this.progress?.start({ kind: 'full' });

    try {
      // --- Vault-fingerprint guard (ahead of conflict check so identity
      //     issues don't burn an extra HEAD round-trip on the wrong folder) ---
      const ownership = await this.assertVaultOwnership();

      // --- Pre-upload conflict check (first of two — ROB-001) ---
      await this.coordinator.verifyNoConflict();

      const deviceId = await this.coordinator.getOrCreateDeviceId();
      const settings = await this.pluginStore.loadSettings();
      const parallelism = resolveParallelism(settings.advanced.upload_parallelism);

      // --- Read, hash, and collect all vault files in one batched pass (TOCTOU fix) ---
      const vaultFiles = this.vault.getFiles();
      this.progress?.setPhase('reading', vaultFiles.length);
      const fileData = await this.readAndHashFiles(
        vaultFiles.map((f) => f.path),
        parallelism,
        (delta) => this.progress?.advance(delta),
      );
      const hashes = new Map(Array.from(fileData.entries()).map(([p, d]) => [p, d.hash]));

      // --- Step 1: Upload new content blobs (CAS, idempotent) ---
      const newBlobs = this.collectNewBlobs(fileData);
      this.progress?.setPhase('uploading', newBlobs.size);
      await this.uploadBlobs(newBlobs, parallelism, (delta) => this.progress?.advance(delta));

      // --- Build manifest ---
      const manifest = buildFullManifest({
        vaultFiles,
        hashes,
        vaultName: this.vaultName,
        vaultPrefix: this.vaultPrefix,
        deviceId,
        createdAt,
        exclusionsApplied,
      });

      // Full pre-uploaded blobs at step 1 above to preserve the crash-recovery
      // matrix semantics. `fileBytes` is still passed for interface symmetry
      // but commitSnapshot's blob-upload branch is gated on manifest.type === 'inc'.

      for (const path of Object.keys(manifest.files)) {
        this.logger.debug('wrote', { path });
      }

      // --- Steps 2-7: crash-safe commit protocol ---
      this.progress?.setPhase('committing', 1);
      await this.commitSnapshot({
        manifest,
        fileBytes: fileData,
        parallelism,
        queueCursorAdvanceTo: manifest.created_at,
      });
      this.progress?.advance(1);

      // First successful FULL on a fresh folder claims the remote
      // vault_meta. We do this AFTER commit succeeds so a partial
      // upload doesn't leave a vault_meta pointing at half-state. If
      // the claim itself fails we log + swallow — the chain is
      // already committed and the next backup will retry the claim
      // (the consistency check is idempotent).
      if (ownership.freshFolder && ownership.localId && this.vaultIdentity) {
        try {
          await this.vaultIdentity.claimRemote(ownership.localId);
          this.markVaultOwnershipClaimed(ownership.localId);
        } catch (err) {
          this.logger.warn('vault_meta_claim_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const fileCount = Object.keys(manifest.files).length;
      this.logger.info('full backup done');
      this.logger.info(`${fileCount} files written`);
      return { filesWritten: fileCount };
    } finally {
      this.progress?.end();
    }
  }

  /**
   * Execute an incremental backup using queue entries since the last committed snapshot.
   *
   * Short-circuits (0 Dropbox calls) if the queue is empty.
   * Throws ConflictError if another device committed during our window (queue intact on throw).
   * Throws if LocalIndex is null — caller must ensure a Full has run first.
   */
  async runIncremental(opts?: { exclusionsApplied?: string[] | null }): Promise<{ filesWritten: number }> {
    const exclusionsApplied = opts?.exclusionsApplied ?? null;

    // "Starting inc backup" is logged AFTER we've confirmed there's actual
    // work — emitting it up here would pair "Starting" with "no changes" on
    // every idle tick and read like a noisy attempt-then-fail trio.

    // One-shot reconcile decision: claim the flag synchronously so a second
    // overlapping invocation can't double-scan, but only commit to the
    // reconcile path once we've confirmed all the gating conditions below.
    const wasFirstIncSinceLoad = this.firstIncSinceLoad;
    this.firstIncSinceLoad = false;

    const settings = await this.pluginStore.loadSettings();
    const parallelism = resolveParallelism(settings.advanced.upload_parallelism);

    // Load index. If absent the vault has never been backed up — promote to a
    // FULL so the caller (FSM tick) doesn't have to special-case the bootstrap.
    // The FULL writes the index as a side effect, so subsequent INCs find a
    // valid one. Same fallback applies if the index exists but has no parent
    // snapshot id yet (rare race: index written before any commit landed).
    const index = await this.pluginStore.loadIndex();
    if (index === null) {
      return this.runFull(opts);
    }

    // Once-per-session full chain walk: verify the entire predecessor chain
    // from `last_inc_snapshot_id` (or `last_full` if no inc yet) back to its
    // nearest Full ancestor. If ANY manifest in that chain is missing on
    // Dropbox, the new inc would inherit the same broken parent_id link and
    // the BackupBrowser would keep showing chain_broken on every snapshot
    // newer than the gap. Re-bootstrap with FULL.
    //
    // Cost: one `downloadJson` per snapshot in the chain. Bounded by retention
    // (typically <50 for V1 defaults), once per session — acceptable to catch
    // mid-chain corruption that a single-probe check misses.
    if (!this.dropboxChainVerified) {
      const startId = index.last_inc_snapshot_id ?? index.last_full_snapshot_id;
      if (startId !== null) {
        const result = await this.walkChainToFull(startId);
        if (result.broken) {
          this.dropboxChainVerified = true;
          this.logger.warn('dropbox_chain_broken_falling_back_to_full', {
            missing_id: result.missingId,
            referrer_id: result.referrerId,
            walked_depth: result.walkedDepth,
            reason: result.reason,
            local_last_full: index.last_full_snapshot_id,
            local_last_inc: index.last_inc_snapshot_id,
          });
          this.onChainCorruptionDetected?.({
            missingId: result.missingId,
            referrerId: result.referrerId,
            walkedDepth: result.walkedDepth,
          });
          return this.runFull(opts);
        }
        this.dropboxChainVerified = true;
      } else {
        this.dropboxChainVerified = true;
      }
    }

    // Snapshot queue at call time; new events enqueued during the run stay untouched
    const queue = await this.pluginStore.loadQueue();

    // Reconcile pass: bridges the offline window by scanning the entire vault
    // against the persisted index for paths that changed/were deleted while
    // Obsidian was closed. Live event queue is reliable WHILE Obsidian runs,
    // so we only do this once per plugin load (firstIncSinceLoad), gated on
    // the user setting (default true). Renames continue to come from the
    // queue — the reconcile pass reports paths only.
    const reconcileDetector =
      wasFirstIncSinceLoad && settings.advanced.reconcile_scan_enabled
        ? this.changeDetector
        : null;

    let changesPaths: string[];
    let deleted: string[];
    let renames: RenameEntry[];

    if (reconcileDetector !== null) {
      const buckets = bucketQueueEntries(queue.entries);
      renames = buckets.renames;
      const renameSourcePaths = new Set(renames.map((r) => r.from));
      const renameTargetPaths = new Set(renames.map((r) => r.to));

      const merged = await reconcileDetector.getChangedPaths(
        index,
        settings.advanced.exclusion_globs,
        { reconcile: true },
      );

      const onDisk = new Set(this.vault.getFiles().map((f) => f.path));
      const changeSet = new Set<string>();
      const deleteSet = new Set<string>(buckets.deleted);
      for (const p of merged) {
        // Skip rename source/target paths — already represented by the renames
        // bucket; counting them as create/delete would corrupt the manifest.
        if (renameSourcePaths.has(p) || renameTargetPaths.has(p)) continue;
        if (onDisk.has(p)) changeSet.add(p);
        else deleteSet.add(p);
      }
      changesPaths = [...changeSet];
      deleted = [...deleteSet];

      // Empty-after-reconcile short-circuit: nothing changed on disk OR in queue.
      if (changesPaths.length === 0 && deleted.length === 0 && renames.length === 0) {
        this.logger.info('Inc backup: no changes');
        return { filesWritten: 0 };
      }
    } else {
      // Empty-queue short-circuit: BEFORE verifyNoConflict (idle tick — no Dropbox calls)
      if (queue.entries.length === 0) {
        this.logger.info('Inc backup: no changes');
        return { filesWritten: 0 };
      }
      const buckets = bucketQueueEntries(queue.entries);
      changesPaths = buckets.changesPaths;
      deleted = buckets.deleted;
      renames = buckets.renames;
    }

    // We have actual work — announce the start. (Late on purpose: a no-op
    // tick stays silent except for the single "Inc backup: no changes" line.)
    this.logger.info('Starting inc backup');
    this.progress?.start({ kind: 'inc' });

    try {
      // --- Vault-fingerprint guard (mirror of runFull). Inc never claims
      //     a fresh folder — the first ever upload is always a Full — so
      //     we throw away the freshFolder flag here. ---
      await this.assertVaultOwnership();

      // --- Pre-upload conflict check (first of two — ROB-001) ---
      await this.coordinator.verifyNoConflict();

      const deviceId = await this.coordinator.getOrCreateDeviceId();
      const createdAt = this.now();

      // --- Read + hash changed files (only those that still exist on disk) ---
      const existingPaths = changesPaths.filter((p) =>
        this.vault.getFiles().some((f) => f.path === p),
      );
      this.progress?.setPhase('reading', existingPaths.length);
      const fileData = await this.readAndHashFiles(
        existingPaths,
        parallelism,
        (delta) => this.progress?.advance(delta),
      );

      // --- Filter: skip files whose hash is unchanged vs index ---
      const changes = buildChanges(fileData, changesPaths, index);

      // No-op inc short-circuit: queue had events but after hashing every
      // file's content matched the index — nothing actually changed. This
      // happens with formatters / linters / "save on focus loss" plugins
      // that rewrite a file with identical content. Advance the queue
      // cursor so we don't re-evaluate the same no-op events on every
      // tick, then skip the commit chain entirely (no manifest, no HEAD
      // bump, no Dropbox round-trip).
      if (changes.length === 0 && deleted.length === 0 && renames.length === 0) {
        const maxObservedAt = queue.entries.reduce(
          (max, e) => (e.observed_at > max ? e.observed_at : max),
          queue.entries[0]?.observed_at ?? this.now(),
        );
        await this.eventQueue.commitWindow(maxObservedAt);
        this.logger.info('Inc backup: no actual changes');
        return { filesWritten: 0 };
      }

      // --- Determine parent snapshot ---
      // Same bootstrap fallback as the index-null case above: if the index
      // exists but never recorded a successful commit, the chain has no head to
      // diff against — run a FULL instead. runFull returns its own
      // { filesWritten } so the caller's toast count stays accurate.
      const parentId = index.last_inc_snapshot_id ?? index.last_full_snapshot_id;
      if (parentId === null) {
        return this.runFull(opts);
      }

      // --- Build Inc manifest ---
      const vaultFiles = this.vault.getFiles();
      const incChanges = changes.map((path) => {
        const data = fileData.get(path)!;
        const vf = vaultFiles.find((f) => f.path === path);
        return { path, hash: data.hash, size: vf?.size ?? data.bytes.length, mtime: vf?.mtime ?? 0 };
      });

      const manifest = buildIncManifest({
        parentId,
        changes: incChanges,
        deleted,
        renames,
        vaultName: this.vaultName,
        vaultPrefix: this.vaultPrefix,
        deviceId,
        createdAt,
        exclusionsApplied,
      });

      // Max observed_at across all consumed queue entries. Empty queue is only
      // reachable via the reconcile path (offline changes only, no live events) —
      // fall back to manifest.created_at so the cursor still advances past any
      // events that arrive between the scan and the cursor write (those will
      // have observed_at > createdAt and survive the filter).
      const maxObservedAt =
        queue.entries.length === 0
          ? createdAt
          : queue.entries.reduce(
              (max, e) => (e.observed_at > max ? e.observed_at : max),
              queue.entries[0].observed_at,
            );

      for (const path of Object.keys(manifest.files)) {
        this.logger.debug('wrote', { path });
      }

      // --- Steps 2-7: crash-safe commit protocol ---
      // Inc snapshots upload blobs INSIDE commitSnapshot (vs Full which
      // pre-uploads), so the uploading phase total isn't known until we
      // dedup. Set it here from the manifest's unique-hash count so the
      // tooltip shows realistic numbers, then commitSnapshot advances per
      // batch via the same callback.
      this.progress?.setPhase('uploading', uniqueHashes(manifest).length);
      await this.commitSnapshot({
        manifest,
        fileBytes: fileData,
        parallelism,
        queueCursorAdvanceTo: maxObservedAt,
        onUploadBatchDone: (delta) => this.progress?.advance(delta),
      });
      this.progress?.setPhase('committing', 1);
      this.progress?.advance(1);

      const fileCount = Object.keys(manifest.files).length;
      this.logger.info('inc backup done');
      this.logger.info(`${fileCount} files written`);
      return { filesWritten: fileCount };
    } finally {
      this.progress?.end();
    }
  }

  // ---------------------------------------------------------------------------
  // Shared commit protocol (steps 2-7)
  // ---------------------------------------------------------------------------

  /**
   * Shared 6-sub-step commit protocol used by both runFull and runIncremental.
   *
   * Caller is responsible for step 1 (blob upload) before calling this.
   * This method handles:
   *   2. Second verifyNoConflict (ROB-001 double-check)
   *   3. Upload manifest JSON
   *   4. Append to snapshot_index
   *   5. Write HEAD
   *   6. Update LocalIndex
   *   7. Advance queue cursor to queueCursorAdvanceTo
   */
  private async commitSnapshot(args: {
    manifest: SnapshotManifest;
    fileBytes: Map<string, { hash: string; bytes: Uint8Array }>;
    parallelism: number;
    queueCursorAdvanceTo: string;
    /** Optional per-batch progress callback for the inc upload step. */
    onUploadBatchDone?: (delta: number) => void;
  }): Promise<void> {
    const { manifest, fileBytes, parallelism, queueCursorAdvanceTo, onUploadBatchDone } = args;

    // --- Step 1: Upload new content blobs ---
    // runFull pre-uploads blobs before calling commitSnapshot (so a crash between blob upload
    // and the 2nd verifyNoConflict leaves orphan blobs for GC, matching the crash-recovery matrix).
    // runIncremental delegates blob upload here so the full protocol is centralized.
    if (manifest.type === 'inc') {
      const newBlobs = this.collectNewBlobs(fileBytes);
      await this.uploadBlobs(newBlobs, parallelism, onUploadBatchDone);
    }

    // --- Step 2: Second conflict check BEFORE manifest write (ROB-001) ---
    await this.coordinator.verifyNoConflict();

    // --- Step 3: Upload manifest ---
    await this.dropbox.uploadJson(snapshotPath(manifest), manifest);

    // --- Step 4: Append to snapshot_index ---
    await this.snapshotIndexStore.append({
      id: manifest.id,
      type: manifest.type,
      parent_id: manifest.parent_id,
      created_at: manifest.created_at,
      device_id: manifest.device_id,
      blob_hashes: uniqueHashes(manifest),
    });

    // --- Step 5: Write HEAD ---
    const committedAt = this.now();
    await this.dropbox.uploadJson(headPath(this.vaultPrefix), {
      schema_version: '1.0',
      snapshot_id: manifest.id,
      snapshot_type: manifest.type,
      device_id: manifest.device_id,
      committed_at: committedAt,
    });

    // --- Step 6: Update LocalIndex ---
    await this.saveLocalIndex(manifest, committedAt);

    // --- Step 7: Advance queue cursor (in-memory + disk via EventQueue) ---
    await this.eventQueue.commitWindow(queueCursorAdvanceTo);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Walk the predecessor chain from `startId` back to its nearest Full
   * ancestor, downloading each manifest. Returns `{ broken: false }` when
   * the chain reaches a Full intact, or `{ broken: true, ... }` on the
   * first PATH_NOT_FOUND or pathological condition (cycle, missing
   * parent_id on a non-Full, depth ceiling). Other errors propagate.
   *
   * Cost: one downloadJson per chain link. Bounded by retention; in V1
   * defaults that's a few dozen at most. CHAIN_WALK_MAX_DEPTH caps the
   * worst case at ~100 round-trips so a user with retention disabled
   * doesn't see a multi-minute startup hang. CHAIN_WALK_DEPTH_WARN logs
   * a warning at 50 so we notice creeping chain length before it bites.
   */
  private async walkChainToFull(
    startId: string,
  ): Promise<
    | { broken: false; depth: number }
    | {
        broken: true;
        missingId: string | null;
        referrerId: string;
        walkedDepth: number;
        reason: 'missing_manifest' | 'cycle' | 'invalid_schema' | 'depth_exceeded';
      }
  > {
    const seen = new Set<string>();
    let cursor: string | null = startId;
    let lastSeen = startId;
    let depth = 0;
    let warnedDepth = false;

    while (cursor !== null) {
      if (depth >= CHAIN_WALK_MAX_DEPTH) {
        // Distinct from a missing-manifest break: we know the chain is
        // structurally fine here, just unreasonably long. The fallback
        // FULL is still the right action — a chain this deep would
        // freeze the Backup Browser even if it weren't broken.
        return {
          broken: true,
          missingId: null,
          referrerId: lastSeen,
          walkedDepth: depth,
          reason: 'depth_exceeded',
        };
      }
      if (!warnedDepth && depth >= CHAIN_WALK_DEPTH_WARN) {
        this.logger.warn('dropbox_chain_walk_depth_high', { depth, start_id: startId });
        warnedDepth = true;
      }
      if (seen.has(cursor)) {
        return {
          broken: true,
          missingId: cursor,
          referrerId: lastSeen,
          walkedDepth: depth,
          reason: 'cycle',
        };
      }
      seen.add(cursor);

      let manifest: { type?: unknown; parent_id?: unknown };
      try {
        manifest = await this.dropbox.downloadJson<{ type?: unknown; parent_id?: unknown }>(
          snapshotPath({ vault_prefix: this.vaultPrefix, id: cursor }),
        );
      } catch (err) {
        if (err instanceof PathError && err.code === 'PATH_NOT_FOUND') {
          return {
            broken: true,
            missingId: cursor,
            referrerId: lastSeen,
            walkedDepth: depth,
            reason: 'missing_manifest',
          };
        }
        throw err;
      }

      depth += 1;
      if (manifest.type === 'full') {
        return { broken: false, depth };
      }
      if (typeof manifest.parent_id !== 'string') {
        return {
          broken: true,
          missingId: null,
          referrerId: cursor,
          walkedDepth: depth,
          reason: 'invalid_schema',
        };
      }
      lastSeen = cursor;
      cursor = manifest.parent_id;
    }

    return {
      broken: true,
      missingId: null,
      referrerId: lastSeen,
      walkedDepth: depth,
      reason: 'invalid_schema',
    };
  }

  /**
   * Read each file exactly once and compute its hash in the same step.
   * This eliminates the TOCTOU window where hashing and uploading used separate
   * readBytes calls — if a file changes between reads, the manifest hash and the
   * uploaded blob would have diverged, corrupting the CAS entry.
   * Batched by parallelism to bound I/O concurrency (fixes EMFILE risk on large vaults).
   */
  private async readAndHashFiles(
    paths: string[],
    parallelism: number,
    onBatchDone?: (delta: number) => void,
  ): Promise<Map<string, { hash: string; bytes: Uint8Array }>> {
    const map = new Map<string, { hash: string; bytes: Uint8Array }>();
    for (let i = 0; i < paths.length; i += parallelism) {
      const batch = paths.slice(i, i + parallelism);
      const results = await Promise.all(batch.map(async (p) => {
        const bytes = await this.vault.readBytes(p);
        const hash = await this.hasher(bytes);
        return { path: p, bytes, hash };
      }));
      for (const r of results) map.set(r.path, { hash: r.hash, bytes: r.bytes });
      onBatchDone?.(batch.length);
    }
    return map;
  }

  /**
   * CAS dedup: derive upload set from the already-read file data — no second readBytes call.
   * Returns a Map<hash, bytes> of unique-hash blobs to upload. Idempotent overwrite means
   * no pre-check is needed; dedup is at the content-hash level, not the API-call level.
   */
  private collectNewBlobs(
    fileData: Map<string, { hash: string; bytes: Uint8Array }>,
  ): Map<string, Uint8Array> {
    const seen = new Set<string>();
    const blobs = new Map<string, Uint8Array>();
    for (const { hash, bytes } of fileData.values()) {
      if (seen.has(hash)) continue;
      seen.add(hash);
      blobs.set(hash, bytes);
    }
    return blobs;
  }

  private async uploadBlobs(
    blobs: Map<string, Uint8Array>,
    parallelism: number,
    onBatchDone?: (delta: number) => void,
  ): Promise<void> {
    const entries = Array.from(blobs.entries());
    for (let i = 0; i < entries.length; i += parallelism) {
      const batch = entries.slice(i, i + parallelism);
      await Promise.all(
        batch.map(([hash, bytes]) => this.uploadBlob(hash, bytes)),
      );
      onBatchDone?.(batch.length);
    }
  }

  private async uploadBlob(hash: string, bytes: Uint8Array): Promise<void> {
    const path = contentPath(this.vaultPrefix, hash);
    const chunkBytes = bytes.length < SMALL_FILE_THRESHOLD_BYTES
      ? SMALL_FILE_CHUNK_BYTES
      : LARGE_FILE_CHUNK_BYTES;
    await this.dropbox.uploadLarge(path, bytes, { mode: 'overwrite', chunkBytes });
  }

  private async saveLocalIndex(manifest: SnapshotManifest, committedAt: string): Promise<void> {
    const existing = await this.pluginStore.loadIndex();

    if (manifest.type === 'full') {
      const updated: LocalIndex = {
        schema_version: '1.0',
        last_full_snapshot_id: manifest.id,
        last_full_commit_at: committedAt,
        last_inc_snapshot_id: null,
        last_inc_commit_at: null,
        last_retention_at: existing?.last_retention_at ?? null,
        index_missing_recovery_required: false,
        files: { ...manifest.files },
      };
      await this.pluginStore.saveIndex(updated);
      return;
    }

    // Inc: apply renames, deletes, and file-content changes to the existing index.
    const base = existing ?? {
      schema_version: '1.0' as const,
      last_full_snapshot_id: null,
      last_full_commit_at: null,
      last_inc_snapshot_id: null,
      last_inc_commit_at: null,
      last_retention_at: null,
      index_missing_recovery_required: false,
      files: {},
    };

    const files = { ...base.files };

    // Apply renames: remove old path, carry entry to new path (if not already in manifest.files)
    for (const rename of manifest.renames) {
      const oldEntry = files[rename.from];
      delete files[rename.from];
      if (oldEntry && !manifest.files[rename.to]) {
        files[rename.to] = oldEntry;
      }
    }

    // Apply deletes
    for (const deletedPath of manifest.deleted) {
      delete files[deletedPath];
    }

    // Overlay changed files from Inc manifest
    for (const [path, entry] of Object.entries(manifest.files)) {
      files[path] = entry;
    }

    const updated: LocalIndex = {
      ...base,
      last_inc_snapshot_id: manifest.id,
      last_inc_commit_at: committedAt,
      index_missing_recovery_required: false,
      files,
    };
    await this.pluginStore.saveIndex(updated);
  }

  // advanceQueueCursor was removed — its callers now use this.eventQueue.commitWindow,
  // which serializes through the EventQueue's opQueue and keeps the in-memory state
  // in sync with the on-disk write. The old direct-to-pluginStore write left the
  // EventQueue's state.entries stale, which made FSM.getQueueSize report phantom
  // pending events for an entire inc_interval after every successful inc.
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function resolveParallelism(raw: number | undefined): number {
  const DEFAULT = DEFAULT_UPLOAD_PARALLELISM;
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return DEFAULT;
  return Math.floor(raw);
}

function uniqueHashes(manifest: SnapshotManifest): string[] {
  const seen = new Set<string>();
  for (const entry of Object.values(manifest.files)) {
    seen.add(entry.hash);
  }
  return Array.from(seen);
}

/**
 * Bucket queue entries into changesPaths, deleted, and renames.
 *
 * Rules:
 * - create/modify → changesPaths (re-hash these paths)
 * - rename → add the new path (to) to changesPaths; record rename entry
 * - delete → deleted list; removes any prior create/modify for the same path in this run
 * - delete overrides prior create/modify for the same path
 */
function bucketQueueEntries(entries: QueueEntry[]): {
  changesPaths: string[];
  deleted: string[];
  renames: RenameEntry[];
} {
  const changesSet = new Set<string>();
  const deletedSet = new Set<string>();
  const renamesMap = new Map<string, string>(); // from → to

  for (const entry of entries) {
    if (entry.type === 'create' || entry.type === 'modify') {
      deletedSet.delete(entry.path); // later create/modify supersedes earlier delete
      changesSet.add(entry.path);
    } else if (entry.type === 'delete') {
      changesSet.delete(entry.path);
      deletedSet.add(entry.path);
      // If this path was a rename target, the rename is superseded.
      // The 'from' side must also be recorded as deleted.
      for (const [from, to] of renamesMap) {
        if (to === entry.path) {
          renamesMap.delete(from);
          deletedSet.add(from);
        }
      }
    } else if (entry.type === 'rename' && entry.prev_path !== null) {
      renamesMap.set(entry.prev_path, entry.path);
      // Add the rename target to changes (its content may have changed)
      if (!deletedSet.has(entry.path)) {
        changesSet.add(entry.path);
      }
    }
  }

  const renames: RenameEntry[] = Array.from(renamesMap.entries()).map(
    ([from, to]) => ({ from, to }),
  );

  return {
    changesPaths: Array.from(changesSet),
    deleted: Array.from(deletedSet),
    renames,
  };
}

/**
 * Filter hashed files to those whose content actually changed vs the local index.
 * For rename targets: include only if hash changed (pure rename → renames[] only, not files[]).
 */
function buildChanges(
  hashMap: Map<string, { hash: string; bytes: Uint8Array }>,
  changesPaths: string[],
  index: LocalIndex,
): string[] {
  const changed: string[] = [];
  for (const path of changesPaths) {
    const hashed = hashMap.get(path);
    if (!hashed) continue; // file was deleted before we got to read it
    const { hash } = hashed;
    if (hash === index.files[path]?.hash) continue; // unchanged content (spurious or pure rename)
    changed.push(path);
  }
  return changed;
}
