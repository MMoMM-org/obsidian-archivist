// VaultIdentity — vault-fingerprint mechanism for cross-vault isolation.
//
// The ownership-of-a-Dropbox-folder problem (see
// `docs/operations/connecting-existing-backup.md`) is solved with a
// pair of UUIDs that must agree before any backup-write is allowed:
//
//   - local `vault_id`           → top-level field in `data.json`
//   - remote `vault_meta.json`   → `<prefix>/vault_meta.json` on Dropbox
//
// Generation rules:
//   - Local: generated once on first plugin load, persisted in `data.json`.
//     Survives plugin reinstalls IF the data.json sticks around. If it's
//     wiped, the next load enters the adoption flow against the remote
//     vault_meta (see ConsistencyCheck.kind === 'adopt-remote').
//   - Remote: written once on the first backup that this device performs
//     against a fresh-folder, OR adopted by the user from the modal when
//     pointing a vault at an existing backup.
//
// The service exposes a single `checkConsistency()` method that callers
// (BackupService pre-write, plugin onload) reduce over to decide what to
// do:
//
//   - 'ok'             → IDs agree, proceed.
//   - 'fresh-folder'   → no vault_meta on Dropbox; first write should
//                        upload one bound to the local id.
//   - 'adopt-remote'   → no local id, but Dropbox has a vault_meta.
//                        The UI shows the Adoption modal; on confirm,
//                        the local id is set to the remote id.
//   - 'mismatch'       → both sides have an id but they differ. Backup
//                        writes are blocked; the user must change
//                        vault_prefix or explicitly adopt.
//   - 'remote-corrupt' → vault_meta.json failed schema validation. The
//                        user is offered overwrite-with-local from the
//                        modal; until then, treat as mismatch.

import { ConfigError, PathError } from '../model/Errors';
import type { DropboxClient } from '../infra/DropboxClient';
import type { Logger } from '../infra/Logger';
import type { PluginStore } from '../infra/PluginStore';
import {
  CURRENT_VAULT_META_SCHEMA,
  parseVaultMeta,
  type VaultMeta,
} from '../model/VaultMeta';
import { vaultMetaPath } from '../util/paths';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VaultIdentityDeps {
  pluginStore: PluginStore;
  dropbox: DropboxClient;
  vaultPrefix: string;
  vaultName: string;
  logger: Logger;
  /** Injectable for tests — defaults to crypto.randomUUID-style v4. */
  generateId?: () => string;
  /** Injectable clock for the `claimed_at` timestamp. */
  now?: () => Date;
}

export type ConsistencyCheck =
  | { kind: 'ok'; localId: string; remote: VaultMeta }
  | { kind: 'fresh-folder'; localId: string }
  | { kind: 'adopt-remote'; remote: VaultMeta }
  | { kind: 'mismatch'; localId: string; remote: VaultMeta }
  | { kind: 'remote-corrupt'; localId: string; rawError: string };

// ---------------------------------------------------------------------------
// VaultIdentity
// ---------------------------------------------------------------------------

export class VaultIdentity {
  constructor(private readonly deps: VaultIdentityDeps) {}

  /**
   * Ensure the local `data.json` has a `vault_id`. If absent, generate
   * one and persist. Returns the (possibly newly-created) ID. Idempotent
   * — repeated calls on a populated `data.json` only read.
   *
   * Note: this does NOT contact Dropbox. Callers that want adoption
   * semantics on first install must call {@link checkConsistency} after
   * Dropbox is reachable and react to `kind === 'adopt-remote'`.
   */
  async ensureLocalVaultId(): Promise<string> {
    const existing = await this.deps.pluginStore.loadVaultId();
    if (existing) return existing;
    const fresh = (this.deps.generateId ?? generateUuidV4)();
    await this.deps.pluginStore.saveVaultId(fresh);
    this.deps.logger.info('vault_id_generated', { vault_id: fresh });
    return fresh;
  }

  /** Read the local vault_id, returning null if absent. */
  async getLocalVaultId(): Promise<string | null> {
    return this.deps.pluginStore.loadVaultId();
  }

  /**
   * Overwrite the local vault_id. Used by the adoption modal — the user
   * confirmed they want this vault to claim the existing Dropbox folder.
   */
  async adoptVaultId(vaultId: string): Promise<void> {
    await this.deps.pluginStore.saveVaultId(vaultId);
    this.deps.logger.info('vault_id_adopted', { vault_id: vaultId });
  }

  /**
   * Read the Dropbox-side vault_meta. Returns null when the file
   * doesn't exist, the parsed meta object on success, or throws via
   * the network/path layer for transient errors. Schema-invalid meta
   * surfaces as a thrown ConfigError that callers convert to the
   * `remote-corrupt` consistency state.
   */
  async loadRemoteVaultMeta(): Promise<VaultMeta | null> {
    try {
      const raw = await this.deps.dropbox.downloadJson<unknown>(
        vaultMetaPath(this.deps.vaultPrefix),
      );
      return parseVaultMeta(raw);
    } catch (err) {
      if (err instanceof PathError && err.code === 'PATH_NOT_FOUND') return null;
      throw err;
    }
  }

  /**
   * Upload a vault_meta.json claiming the current Dropbox folder for
   * the current vault_id. Caller is expected to have ensured the local
   * vault_id exists (via {@link ensureLocalVaultId}). The `claimed_at`
   * timestamp is set by this method.
   */
  async claimRemote(localVaultId: string): Promise<void> {
    const meta: VaultMeta = {
      schema_version: CURRENT_VAULT_META_SCHEMA,
      vault_id: localVaultId,
      vault_name: this.deps.vaultName,
      claimed_at: (this.deps.now ?? (() => new Date()))().toISOString(),
    };
    await this.deps.dropbox.uploadJson(vaultMetaPath(this.deps.vaultPrefix), meta);
    this.deps.logger.info('vault_meta_claimed', { vault_id: localVaultId });
  }

  /**
   * Compare local and remote IDs and return a `ConsistencyCheck`
   * describing the outcome. Does not mutate either side — that's the
   * caller's job after deciding (UI modal for adopt, BackupService
   * for fresh-folder claim, etc.).
   */
  async checkConsistency(): Promise<ConsistencyCheck> {
    const localId = await this.deps.pluginStore.loadVaultId();
    let remote: VaultMeta | null;
    try {
      remote = await this.loadRemoteVaultMeta();
    } catch (err) {
      // Schema-invalid meta — distinct from mismatch because the user
      // cannot manually pick which ID is right; the modal offers
      // "overwrite with local". A network error propagates instead.
      if (err instanceof ConfigError) {
        return {
          kind: 'remote-corrupt',
          localId: localId ?? '',
          rawError: err.message,
        };
      }
      throw err;
    }

    if (remote === null) {
      if (!localId) {
        // Both sides absent: caller should generate the local ID first
        // (via ensureLocalVaultId) and then re-run the check, which
        // produces 'fresh-folder' on the second call.
        const generated = await this.ensureLocalVaultId();
        return { kind: 'fresh-folder', localId: generated };
      }
      return { kind: 'fresh-folder', localId };
    }

    if (!localId) {
      return { kind: 'adopt-remote', remote };
    }

    if (localId === remote.vault_id) {
      return { kind: 'ok', localId, remote };
    }

    return { kind: 'mismatch', localId, remote };
  }
}

// ---------------------------------------------------------------------------
// UUID v4 generator — same shape as DeviceCoordinator's. Duplicated
// rather than exported because the two modules generate identifiers
// for different concerns; keeping them independent avoids accidental
// cross-coupling if one ever needs a different RNG strategy.
// ---------------------------------------------------------------------------

function generateUuidV4(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
