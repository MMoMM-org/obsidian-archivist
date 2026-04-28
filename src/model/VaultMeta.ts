// VaultMeta — vault-identity record stored on Dropbox at
// `<prefix>/vault_meta.json`. The local plugin compares its own
// `vault_id` against this record on every backup-write to detect
// "this Dropbox folder belongs to a different vault" — see
// `docs/operations/connecting-existing-backup.md`.
//
// The schema is intentionally minimal; the only load-bearing field is
// `vault_id`. `vault_name` and `claimed_at` are diagnostic-only and
// help users identify the folder in the Adoption modal.

import { configInvalid } from './Errors';

export type VaultMetaSchemaVersion = '1.0';
export const CURRENT_VAULT_META_SCHEMA: VaultMetaSchemaVersion = '1.0';

export interface VaultMeta {
  schema_version: VaultMetaSchemaVersion;
  vault_id: string;
  /** Obsidian vault name at the moment vault_meta was claimed. Diagnostic only. */
  vault_name: string;
  /** ISO-8601 timestamp of the original claim. Diagnostic only. */
  claimed_at: string;
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isVaultId(v: unknown): v is string {
  return typeof v === 'string' && UUID_V4_REGEX.test(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isVaultMeta(v: unknown): v is VaultMeta {
  if (!isObject(v)) return false;
  return (
    v.schema_version === CURRENT_VAULT_META_SCHEMA &&
    isVaultId(v.vault_id) &&
    typeof v.vault_name === 'string' &&
    typeof v.claimed_at === 'string'
  );
}

/**
 * Parse + validate a raw blob into a VaultMeta. Throws ConfigError with
 * a field-level message on shape mismatch — caller is expected to log
 * and treat the file as corrupt (same recovery path as the snapshot
 * index: a corrupt vault_meta blocks the consistency check; the
 * adoption modal will offer to overwrite it).
 */
export function parseVaultMeta(raw: unknown): VaultMeta {
  if (!isObject(raw)) throw configInvalid('vault_meta', 'expected object');
  if (raw.schema_version !== CURRENT_VAULT_META_SCHEMA) {
    throw configInvalid('vault_meta.schema_version', `unknown version ${String(raw.schema_version)}`);
  }
  if (!isVaultId(raw.vault_id)) {
    throw configInvalid('vault_meta.vault_id', 'expected UUID v4');
  }
  if (typeof raw.vault_name !== 'string') {
    throw configInvalid('vault_meta.vault_name', 'expected string');
  }
  if (typeof raw.claimed_at !== 'string') {
    throw configInvalid('vault_meta.claimed_at', 'expected string');
  }
  return raw as unknown as VaultMeta;
}
