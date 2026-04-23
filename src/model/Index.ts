import { configInvalid } from './Errors';
import { isFileEntry, type FileEntry } from './Manifest';

export interface LocalIndex {
  schema_version: '1.0';
  last_full_snapshot_id: string | null;
  last_inc_snapshot_id: string | null;
  last_full_commit_at: string | null;
  last_inc_commit_at: string | null;
  last_retention_at: string | null;
  index_missing_recovery_required: boolean;
  files: Record<string, FileEntry>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isLocalIndex(v: unknown): v is LocalIndex {
  if (!isObject(v)) return false;
  if (v.schema_version !== '1.0') return false;
  if (!isStringOrNull(v.last_full_snapshot_id)) return false;
  if (!isStringOrNull(v.last_inc_snapshot_id)) return false;
  if (!isStringOrNull(v.last_full_commit_at)) return false;
  if (!isStringOrNull(v.last_inc_commit_at)) return false;
  if (!isStringOrNull(v.last_retention_at)) return false;
  if (typeof v.index_missing_recovery_required !== 'boolean') return false;
  if (!isObject(v.files)) return false;
  for (const entry of Object.values(v.files)) {
    if (!isFileEntry(entry)) return false;
  }
  return true;
}

export function parseLocalIndex(raw: unknown): LocalIndex {
  if (!isObject(raw)) throw configInvalid('index', 'expected object');
  if (raw.schema_version !== '1.0')
    throw configInvalid('index.schema_version', `expected "1.0", got ${JSON.stringify(raw.schema_version)}`);
  for (const field of [
    'last_full_snapshot_id',
    'last_inc_snapshot_id',
    'last_full_commit_at',
    'last_inc_commit_at',
    'last_retention_at',
  ] as const) {
    if (!isStringOrNull(raw[field]))
      throw configInvalid(`index.${field}`, 'expected string or null');
  }
  if (typeof raw.index_missing_recovery_required !== 'boolean')
    throw configInvalid('index.index_missing_recovery_required', 'expected boolean');
  if (!isObject(raw.files)) throw configInvalid('index.files', 'expected object');
  for (const [k, entry] of Object.entries(raw.files)) {
    if (!isFileEntry(entry))
      throw configInvalid(`index.files[${JSON.stringify(k)}]`, 'expected {hash,size,mtime}');
  }
  return raw as unknown as LocalIndex;
}

export function emptyLocalIndex(): LocalIndex {
  return {
    schema_version: '1.0',
    last_full_snapshot_id: null,
    last_inc_snapshot_id: null,
    last_full_commit_at: null,
    last_inc_commit_at: null,
    last_retention_at: null,
    index_missing_recovery_required: false,
    files: {},
  };
}
