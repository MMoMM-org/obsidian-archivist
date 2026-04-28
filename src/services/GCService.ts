// GCService — orphan blob sweep with gc_lock, ROB-012 ordering, and age-gate.
//
// Algorithm (T6.4):
//   1. Read gc_lock; if valid and fresh → abort (skipped_locked).
//   2. Write gc_lock.
//   3. (ROB-012) Read snapshot_index FIRST → build referenced-hash set.
//      If index unreadable → abort defensively (skipped_no_index); remove lock.
//   4. List content/ SECOND → iterate file entries.
//      - Age gate: skip blobs within maxClockSkewMinutes of started_at.
//      - Unreferenced → delete; referenced → keep.
//   5. Remove gc_lock.
//
// References: SDD/ADR-5, SDD/ADR-20, SDD/Risks/ROB-012, ROB-014.

import { CorruptionError, PathError } from '../model/Errors';
import type { DropboxClient } from '../infra/DropboxClient';
import type { Logger } from '../infra/Logger';
import type { SnapshotIndexStore } from './SnapshotIndexStore';
import { gcLockPath, contentFolderPath } from '../util/paths';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type GCResultState = 'skipped_locked' | 'skipped_no_index' | 'swept';

export interface GCResult {
  state: GCResultState;
  deleted: string[];
  kept_count: number;
  skipped_age_gate: number;
  blocking_lock?: { started_at: string; device_id?: string; age_ms: number };
}

export interface GCServiceDeps {
  dropbox: DropboxClient;
  snapshotIndexStore: SnapshotIndexStore;
  logger: Logger;
  vaultPrefix: string;
  /**
   * Identifier recorded in the GC lock file's `device_id` field for
   * diagnostics ("which device left this stale lock?"). Accept either a
   * string or a getter — production wires the getter so the lock carries
   * the real DeviceCoordinator UUID even when GCService is constructed
   * before the device id has been resolved (Obsidian plugin lifecycle:
   * services are wired synchronously in `onload`, but `loadData()` reads
   * are async). Tests pass a fixed string.
   */
  deviceId: string | (() => string | Promise<string>);
  now?: () => Date;
  maxClockSkewMinutes?: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface GcLock {
  schema_version: '1.0';
  started_at: string;
  device_id?: string;
}

function isGcLock(v: unknown): v is GcLock {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.schema_version === '1.0' && typeof o.started_at === 'string';
}

// ---------------------------------------------------------------------------
// GCService
// ---------------------------------------------------------------------------

export class GCService {
  private readonly dropbox: DropboxClient;
  private readonly snapshotIndexStore: SnapshotIndexStore;
  private readonly logger: Logger;
  private readonly lockPath: string;
  private readonly contentFolder: string;
  private readonly resolveDeviceId: () => string | Promise<string>;
  private readonly now: () => Date;
  private readonly maxClockSkewMinutes: number;

  constructor(deps: GCServiceDeps) {
    this.dropbox = deps.dropbox;
    this.snapshotIndexStore = deps.snapshotIndexStore;
    this.logger = deps.logger;
    this.lockPath = gcLockPath(deps.vaultPrefix);
    this.contentFolder = contentFolderPath(deps.vaultPrefix);
    this.resolveDeviceId =
      typeof deps.deviceId === 'function' ? deps.deviceId : () => deps.deviceId as string;
    this.now = deps.now ?? (() => new Date());
    this.maxClockSkewMinutes = deps.maxClockSkewMinutes ?? 5;
  }

  async sweep(): Promise<GCResult> {
    const now = this.now();

    const lockCheck = await this.checkExistingLock(now);
    if (lockCheck !== 'proceed') return lockCheck;

    const deviceId = await this.resolveDeviceId();
    const lock: GcLock = {
      schema_version: '1.0',
      started_at: now.toISOString(),
      device_id: deviceId,
    };
    await this.dropbox.uploadJson(this.lockPath, lock);

    try {
      return await this.runSweep(now);
    } finally {
      await this.removeLock();
    }
  }

  // ---------------------------------------------------------------------------
  // Lock handling
  // ---------------------------------------------------------------------------

  private async checkExistingLock(now: Date): Promise<GCResult | 'proceed'> {
    let raw: unknown;
    try {
      raw = await this.dropbox.downloadJson(this.lockPath);
    } catch (err) {
      if (err instanceof PathError && err.code === 'PATH_NOT_FOUND') return 'proceed';
      throw err;
    }

    if (!isGcLock(raw)) {
      this.logger.warn('gc_lock_invalid', { error: 'lock failed schema validation' });
      return 'proceed';
    }

    const startedAtMs = Date.parse(raw.started_at);
    if (!Number.isFinite(startedAtMs)) {
      this.logger.warn('gc_lock_invalid', { error: 'started_at is not a valid date' });
      return 'proceed';
    }

    const thresholdMs = (60 + this.maxClockSkewMinutes) * 60 * 1000;
    const ageMs = now.getTime() - startedAtMs;

    if (ageMs <= thresholdMs) {
      return {
        state: 'skipped_locked',
        deleted: [],
        kept_count: 0,
        skipped_age_gate: 0,
        blocking_lock: { started_at: raw.started_at, device_id: raw.device_id, age_ms: ageMs },
      };
    }

    this.logger.info('gc_lock_stale', { started_at: raw.started_at, age_ms: ageMs });
    return 'proceed';
  }

  // ---------------------------------------------------------------------------
  // Core sweep (called after lock is written)
  // ---------------------------------------------------------------------------

  private async runSweep(now: Date): Promise<GCResult> {
    // Step A (ROB-012): read index FIRST
    const referenced = await this.buildReferencedSet();
    if (referenced === null) {
      this.logger.warn('gc_aborted_no_index', {});
      return { state: 'skipped_no_index', deleted: [], kept_count: 0, skipped_age_gate: 0 };
    }

    // Step B (ROB-012): list content SECOND
    const entries = await this.dropbox.listFolder(this.contentFolder, { recursive: true });

    const startedAtMs = now.getTime();
    const ageGateMs = this.maxClockSkewMinutes * 60 * 1000;

    const deleted: string[] = [];
    let kept_count = 0;
    let skipped_age_gate = 0;

    for (const entry of entries) {
      if (entry.tag !== 'file') continue;

      const hash = entry.path.slice(entry.path.lastIndexOf('/') + 1);

      if (entry.server_modified !== undefined) {
        const modifiedMs = Date.parse(entry.server_modified);
        if (Number.isFinite(modifiedMs) && Math.abs(modifiedMs - startedAtMs) <= ageGateMs) {
          skipped_age_gate++;
          continue;
        }
      }

      if (referenced.has(hash)) {
        kept_count++;
        continue;
      }

      try {
        await this.dropbox.deleteV2(entry.path);
        deleted.push(entry.path);
      } catch (err) {
        this.logger.warn('gc_delete_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { state: 'swept', deleted, kept_count, skipped_age_gate };
  }

  private async buildReferencedSet(): Promise<Set<string> | null> {
    let index;
    try {
      index = await this.snapshotIndexStore.read();
    } catch (err) {
      if (err instanceof CorruptionError) return null;
      throw err;
    }
    if (index === null) return null;

    const set = new Set<string>();
    for (const entry of index.snapshots) {
      for (const hash of entry.blob_hashes) {
        set.add(hash);
      }
    }
    return set;
  }

  private async removeLock(): Promise<void> {
    try {
      await this.dropbox.deleteV2(this.lockPath);
    } catch (err) {
      this.logger.warn('gc_lock_remove_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
