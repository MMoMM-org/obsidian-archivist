// BackupService — crash-safe 7-step commit protocol for full snapshots.
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

import { buildFullManifest } from './ManifestBuilder';
import type { SnapshotIndexStore } from './SnapshotIndexStore';
import type { DeviceCoordinator } from './DeviceCoordinator';
import type { DropboxClient } from '../infra/DropboxClient';
import type { PluginStore } from '../infra/PluginStore';
import type { VaultAdapter } from '../infra/VaultAdapter';
import type { LocalIndex } from '../model/Index';
import type { SnapshotManifest } from '../model/Manifest';
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
    const parallelism = settings.advanced.upload_parallelism ?? DEFAULT_UPLOAD_PARALLELISM;

    // --- Hash all vault files ---
    const vaultFiles = this.vault.getFiles();
    const hashes = await this.hashFiles(vaultFiles.map((f) => f.path));

    // --- Step 1: Upload new content blobs (CAS, idempotent) ---
    const newBlobs = await this.collectNewBlobs(vaultFiles.map((f) => f.path), hashes);
    await this.uploadBlobs(newBlobs, parallelism);

    // --- Step 2: Second conflict check BEFORE manifest write (ROB-001) ---
    await this.coordinator.verifyNoConflict();

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
    await this.dropbox.uploadJson(headPath(this.vaultPrefix), {
      schema_version: '1.0',
      snapshot_id: manifest.id,
      snapshot_type: manifest.type,
      device_id: manifest.device_id,
      committed_at: this.now(),
    });

    // --- Step 6: Update LocalIndex ---
    await this.saveLocalIndex(manifest);

    // --- Step 7: Advance queue cursor ---
    await this.advanceQueueCursor(manifest.created_at);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async hashFiles(paths: string[]): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    // Hash in parallel — bounded by upload_parallelism is unnecessary here since
    // hashing is CPU-bound and we want all hashes before we know what's "new".
    const results = await Promise.all(
      paths.map(async (path) => {
        const bytes = await this.vault.readBytes(path);
        const hash = await this.hasher(bytes);
        return { path, hash };
      }),
    );
    for (const { path, hash } of results) {
      hashes.set(path, hash);
    }
    return hashes;
  }

  /**
   * CAS dedup: only upload blobs not already present in the Dropbox content store.
   * We use mode=overwrite on the content-hash path — idempotent, no pre-check needed.
   * Returns a Map<hash, bytes> of blobs that need to be uploaded.
   *
   * For Full backups the "already uploaded" set is determined by checking whether
   * the content path exists via uploadBlob overwrite semantics. Since uploadBlob is
   * idempotent, we can upload all unique-hash blobs unconditionally — but we dedup
   * by hash so two files with the same content produce one upload.
   */
  private async collectNewBlobs(
    paths: string[],
    hashes: Map<string, string>,
  ): Promise<Map<string, Uint8Array>> {
    const seen = new Set<string>();
    const blobs = new Map<string, Uint8Array>();

    for (const path of paths) {
      const hash = hashes.get(path)!;
      if (seen.has(hash)) continue;
      seen.add(hash);

      const bytes = await this.vault.readBytes(path);
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

  private async saveLocalIndex(manifest: SnapshotManifest): Promise<void> {
    const existing = await this.pluginStore.loadIndex();
    const updated: LocalIndex = {
      schema_version: '1.0',
      last_full_snapshot_id: manifest.id,
      last_full_commit_at: manifest.created_at,
      last_inc_snapshot_id: existing?.last_inc_snapshot_id ?? null,
      last_inc_commit_at: existing?.last_inc_commit_at ?? null,
      last_retention_at: existing?.last_retention_at ?? null,
      index_missing_recovery_required: false,
      files: { ...manifest.files },
    };
    await this.pluginStore.saveIndex(updated);
  }

  private async advanceQueueCursor(committedThrough: string): Promise<void> {
    const queue = await this.pluginStore.loadQueue();
    const updated = {
      ...queue,
      committed_through: committedThrough,
      entries: queue.entries.filter(
        (e) => e.observed_at > committedThrough,
      ),
    };
    await this.pluginStore.saveQueue(updated);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueHashes(manifest: SnapshotManifest): string[] {
  const seen = new Set<string>();
  for (const entry of Object.values(manifest.files)) {
    seen.add(entry.hash);
  }
  return Array.from(seen);
}
