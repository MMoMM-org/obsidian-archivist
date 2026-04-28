// DeviceCoordinator — device identity, ownership flag, and HEAD conflict detection.
//
// Responsibilities (T5.1 / PRD F5 / SDD Algorithm 2):
//   - Generate and persist a stable UUIDv4 per install. Persisted by
//     PluginStore in the `device.json` sidecar (NOT data.json — see ADR-11
//     and the PluginStore module doc for the sync-isolation rationale).
//   - Track the `designated` flag (which device performs backups).
//   - Validate HEAD.json schema before trusting any field (SEC-M4 DoS-protection).
//   - Detect multi-device conflicts: another device committed within recentWindowHours.
//
// Design invariants:
//   - takeOwnership / releaseOwnership are pure local mutations — no Dropbox calls.
//   - A schema-invalid HEAD is logged as WARN and treated as absent; it never blocks
//     backups (SEC-M4). Only a valid HEAD from a different, recently-active device
//     raises ConflictError('DEVICE_CONFLICT').
//   - NetworkError from downloadJson propagates unmodified to the caller (retry lives
//     at the backup layer, not here).

import { ConflictError, PathError } from '../model/Errors';
import { headPath } from '../util/paths';
import type { DropboxClient } from '../infra/DropboxClient';
import type { Logger } from '../infra/Logger';
import type { DeviceBlock, PluginStore } from '../infra/PluginStore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KNOWN_SCHEMA_VERSIONS = new Set(['1.0']);
const SNAPSHOT_ID_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-(full|inc)$/;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_MAX_CLOCK_SKEW_MINUTES = 5;
const DEFAULT_RECENT_WINDOW_HOURS = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceCoordinatorDeps {
  pluginStore: PluginStore;
  dropbox: DropboxClient;
  logger: Logger;
  vaultPrefix: string;
  /** Injectable for tests — defaults to Date.now(). */
  now?: () => number;
}

export interface VerifyNoConflictOptions {
  maxClockSkewMinutes?: number;
  recentWindowHours?: number;
}

// ---------------------------------------------------------------------------
// DeviceCoordinator
// ---------------------------------------------------------------------------

export class DeviceCoordinator {
  private readonly pluginStore: PluginStore;
  private readonly dropbox: DropboxClient;
  private readonly logger: Logger;
  private readonly vaultPrefix: string;
  private readonly now: () => number;

  /** In-flight latch — two concurrent first-time callers share the same UUID. */
  private idPromise: Promise<string> | null = null;

  constructor(deps: DeviceCoordinatorDeps) {
    this.pluginStore = deps.pluginStore;
    this.dropbox = deps.dropbox;
    this.logger = deps.logger;
    this.vaultPrefix = deps.vaultPrefix;
    this.now = deps.now ?? (() => Date.now());
  }

  async getOrCreateDeviceId(): Promise<string> {
    if (this.idPromise) return this.idPromise;
    this.idPromise = (async () => {
      const device = await this.loadDevice();
      if (device.device_id) return device.device_id;
      const id = generateUuidV4();
      this.logger.info('device_id_generated', { device_id: id });
      await this.saveDevice({ ...device, device_id: id });
      return id;
    })();
    // On failure, clear the latch so a later caller can retry. Successful
    // results stay cached for the lifetime of this instance.
    this.idPromise.catch(() => {
      this.idPromise = null;
    });
    return this.idPromise;
  }

  async isActiveOwner(): Promise<boolean> {
    const device = await this.loadDevice();
    return device.designated;
  }

  async takeOwnership(label?: string): Promise<void> {
    const device = await this.loadDevice();
    const updated: DeviceBlock = {
      ...device,
      designated: true,
      device_label: label ?? device.device_label,
    };
    await this.saveDevice(updated);
    this.logger.info('ownership_taken', { device_label: updated.device_label });
  }

  async releaseOwnership(): Promise<void> {
    const device = await this.loadDevice();
    await this.saveDevice({ ...device, designated: false });
    this.logger.info('ownership_released', {});
  }

  async verifyNoConflict(opts?: VerifyNoConflictOptions): Promise<void> {
    const maxClockSkewMinutes = opts?.maxClockSkewMinutes ?? DEFAULT_MAX_CLOCK_SKEW_MINUTES;
    const recentWindowHours = opts?.recentWindowHours ?? DEFAULT_RECENT_WINDOW_HOURS;

    const path = headPath(this.vaultPrefix);
    let headRaw: unknown;

    try {
      headRaw = await this.dropbox.downloadJson(path);
    } catch (err) {
      // Only "path not found" means fresh folder. PATH_CONFLICT / BAD_REQUEST
      // and any other PathError code is a genuine error that must propagate —
      // swallowing them would mask permission problems as "no HEAD.json yet".
      if (err instanceof PathError && err.code === 'PATH_NOT_FOUND') return;
      throw err;
    }

    if (headRaw === null || headRaw === undefined) return;

    if (!this.validateHeadSchema(headRaw, maxClockSkewMinutes)) {
      this.logger.warn('head_invalid', { reason: 'HEAD.json failed schema validation — treating as absent' });
      return;
    }

    const head = headRaw as Record<string, unknown>;
    const headDeviceId = head.device_id as string;
    const committedAt = head.committed_at as string;

    const myDeviceId = await this.getOrCreateDeviceId();
    if (headDeviceId === myDeviceId) return;

    const ageHours = (this.now() - new Date(committedAt).getTime()) / (1000 * 60 * 60);
    if (ageHours > recentWindowHours) return;

    throw new ConflictError(
      'DEVICE_CONFLICT',
      `Another device (${headDeviceId}) committed ${ageHours.toFixed(2)}h ago. ` +
        `Take ownership or wait until the other device has been inactive for ${recentWindowHours}h.`,
      false,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private validateHeadSchema(raw: unknown, maxClockSkewMinutes: number): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const h = raw as Record<string, unknown>;

    if (!KNOWN_SCHEMA_VERSIONS.has(h.schema_version as string)) return false;
    if (typeof h.snapshot_id !== 'string' || !SNAPSHOT_ID_REGEX.test(h.snapshot_id)) return false;
    if (h.snapshot_type !== 'full' && h.snapshot_type !== 'inc') return false;
    if (typeof h.device_id !== 'string' || !UUID_V4_REGEX.test(h.device_id)) return false;
    if (typeof h.committed_at !== 'string') return false;

    const ts = new Date(h.committed_at).getTime();
    if (Number.isNaN(ts)) return false;

    const maxFutureMs = maxClockSkewMinutes * 60 * 1000;
    if (ts > this.now() + maxFutureMs) return false;

    return true;
  }

  private loadDevice(): Promise<DeviceBlock> {
    return this.pluginStore.loadDevice();
  }

  private saveDevice(device: DeviceBlock): Promise<void> {
    return this.pluginStore.saveDevice(device);
  }
}

// ---------------------------------------------------------------------------
// UUIDv4 generator
// ---------------------------------------------------------------------------

function generateUuidV4(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
