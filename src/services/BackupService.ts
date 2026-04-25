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
import type { SnapshotIndexStore } from './SnapshotIndexStore';
import type { DeviceCoordinator } from './DeviceCoordinator';
import type { DropboxClient } from '../infra/DropboxClient';
import type { PluginStore } from '../infra/PluginStore';
import type { VaultAdapter } from '../infra/VaultAdapter';
import type { LocalIndex } from '../model/Index';
import type { EventQueue, QueueEntry } from '../model/QueueEntry';
import type { RenameEntry, SnapshotManifest } from '../model/Manifest';
import { contentPath, headPath, snapshotPath } from '../util/paths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SMALL_FILE_THRESHOLD_BYTES = 50 * 1024 * 1024;    // 50 MB
const SMALL_FILE_CHUNK_BYTES = 8 * 1024 * 1024;         // 8 MB
const LARGE_FILE_CHUNK_BYTES = 150 * 1024 * 1024;       // 150 MB
const DEFAULT_UPLOAD_PARALLELISM = 4;

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
  vaultPrefix: string;
  vaultName: string;
  /** Injectable clock for deterministic tests. Defaults to new Date().toISOString(). */
  now?: () => string;
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
  private readonly vaultPrefix: string;
  private readonly vaultName: string;
  private readonly now: () => string;

  constructor(deps: BackupServiceDeps) {
    this.dropbox = deps.dropbox;
    this.vault = deps.vault;
    this.hasher = deps.hasher;
    this.coordinator = deps.deviceCoordinator;
    this.pluginStore = deps.pluginStore;
    this.snapshotIndexStore = deps.snapshotIndexStore;
    this.vaultPrefix = deps.vaultPrefix;
    this.vaultName = deps.vaultName;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Execute a full vault backup following the 7-step crash-safe commit protocol.
   *
   * Throws on any error — the caller is responsible for surfacing the failure
   * to the user and scheduling recovery. Orphan blobs left by a mid-upload
   * crash are GC candidates (Phase 6).
   */
  async runFull(opts?: { exclusionsApplied?: string[] | null }): Promise<void> {
    const exclusionsApplied = opts?.exclusionsApplied ?? null;
    const createdAt = this.now();

    // --- Pre-upload conflict check (first of two — ROB-001) ---
    await this.coordinator.verifyNoConflict();

    const deviceId = await this.coordinator.getOrCreateDeviceId();
    const settings = await this.pluginStore.loadSettings();
    const parallelism = resolveParallelism(settings.advanced.upload_parallelism);

    // --- Read, hash, and collect all vault files in one batched pass (TOCTOU fix) ---
    const vaultFiles = this.vault.getFiles();
    const fileData = await this.readAndHashFiles(vaultFiles.map((f) => f.path), parallelism);
    const hashes = new Map(Array.from(fileData.entries()).map(([p, d]) => [p, d.hash]));

    // --- Step 1: Upload new content blobs (CAS, idempotent) ---
    const newBlobs = this.collectNewBlobs(fileData);
    await this.uploadBlobs(newBlobs, parallelism);

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

    // --- Steps 2-7: crash-safe commit protocol ---
    const queueForFull = await this.pluginStore.loadQueue();
    await this.commitSnapshot({
      manifest,
      fileBytes: fileData,
      parallelism,
      queueCursorAdvanceTo: manifest.created_at,
      baseQueueSnapshot: queueForFull,
    });
  }

  /**
   * Execute an incremental backup using queue entries since the last committed snapshot.
   *
   * Short-circuits (0 Dropbox calls) if the queue is empty.
   * Throws ConflictError if another device committed during our window (queue intact on throw).
   * Throws if LocalIndex is null — caller must ensure a Full has run first.
   */
  async runIncremental(opts?: { exclusionsApplied?: string[] | null }): Promise<void> {
    const exclusionsApplied = opts?.exclusionsApplied ?? null;

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

    // Snapshot queue at call time; new events enqueued during the run stay untouched
    const queue = await this.pluginStore.loadQueue();

    // Empty-queue short-circuit: BEFORE verifyNoConflict (idle tick — no Dropbox calls)
    if (queue.entries.length === 0) return;

    // --- Pre-upload conflict check (first of two — ROB-001) ---
    await this.coordinator.verifyNoConflict();

    const deviceId = await this.coordinator.getOrCreateDeviceId();
    const createdAt = this.now();

    // --- Bucket queue entries ---
    const { changesPaths, deleted, renames } = bucketQueueEntries(queue.entries);

    // --- Read + hash changed files (only those that still exist on disk) ---
    const existingPaths = changesPaths.filter((p) =>
      this.vault.getFiles().some((f) => f.path === p),
    );
    const fileData = await this.readAndHashFiles(existingPaths, parallelism);

    // --- Filter: skip files whose hash is unchanged vs index ---
    const changes = buildChanges(fileData, changesPaths, index);

    // --- Determine parent snapshot ---
    // Same bootstrap fallback as the index-null case above: if the index
    // exists but never recorded a successful commit, the chain has no head to
    // diff against — run a FULL instead.
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

    // Max observed_at across all consumed queue entries
    const maxObservedAt = queue.entries.reduce(
      (max, e) => (e.observed_at > max ? e.observed_at : max),
      queue.entries[0].observed_at,
    );

    // --- Steps 2-7: crash-safe commit protocol ---
    await this.commitSnapshot({
      manifest,
      fileBytes: fileData,
      parallelism,
      queueCursorAdvanceTo: maxObservedAt,
      baseQueueSnapshot: queue,
    });
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
    baseQueueSnapshot: EventQueue;
  }): Promise<void> {
    const { manifest, fileBytes, parallelism, queueCursorAdvanceTo, baseQueueSnapshot } = args;

    // --- Step 1: Upload new content blobs ---
    // runFull pre-uploads blobs before calling commitSnapshot (so a crash between blob upload
    // and the 2nd verifyNoConflict leaves orphan blobs for GC, matching the crash-recovery matrix).
    // runIncremental delegates blob upload here so the full protocol is centralized.
    if (manifest.type === 'inc') {
      const newBlobs = this.collectNewBlobs(fileBytes);
      await this.uploadBlobs(newBlobs, parallelism);
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

    // --- Step 7: Advance queue cursor ---
    await this.advanceQueueCursor(queueCursorAdvanceTo, baseQueueSnapshot);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

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
  ): Promise<void> {
    const entries = Array.from(blobs.entries());
    for (let i = 0; i < entries.length; i += parallelism) {
      const batch = entries.slice(i, i + parallelism);
      await Promise.all(
        batch.map(([hash, bytes]) => this.uploadBlob(hash, bytes)),
      );
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

  private async advanceQueueCursor(
    committedThrough: string,
    baseSnapshot: EventQueue,
  ): Promise<void> {
    const updated: EventQueue = {
      ...baseSnapshot,
      committed_through: committedThrough,
      entries: baseSnapshot.entries.filter((e) => e.observed_at > committedThrough),
    };
    await this.pluginStore.saveQueue(updated);
  }
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
