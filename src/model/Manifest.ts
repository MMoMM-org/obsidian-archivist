import { configInvalid } from './Errors';

export type SnapshotType = 'full' | 'inc';

export interface FileEntry {
  hash: string;
  size: number;
  mtime: number;
}

export interface RenameEntry {
  from: string;
  to: string;
}

export interface SnapshotManifest {
  schema_version: '1.0';
  id: string;
  type: SnapshotType;
  parent_id: string | null;
  device_id: string;
  created_at: string;
  vault_name: string;
  vault_prefix: string;
  files: Record<string, FileEntry>;
  deleted: string[];
  renames: RenameEntry[];
  exclusions_applied: string[] | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isFileEntry(v: unknown): v is FileEntry {
  return (
    isObject(v) &&
    typeof v.hash === 'string' &&
    typeof v.size === 'number' &&
    typeof v.mtime === 'number'
  );
}

export function isRenameEntry(v: unknown): v is RenameEntry {
  return isObject(v) && typeof v.from === 'string' && typeof v.to === 'string';
}

export function isSnapshotManifest(v: unknown): v is SnapshotManifest {
  if (!isObject(v)) return false;
  if (v.schema_version !== '1.0') return false;
  if (typeof v.id !== 'string') return false;
  if (v.type !== 'full' && v.type !== 'inc') return false;
  if (v.parent_id !== null && typeof v.parent_id !== 'string') return false;
  if (typeof v.device_id !== 'string') return false;
  if (typeof v.created_at !== 'string') return false;
  if (typeof v.vault_name !== 'string') return false;
  if (typeof v.vault_prefix !== 'string') return false;
  if (!isObject(v.files)) return false;
  for (const [k, entry] of Object.entries(v.files)) {
    if (typeof k !== 'string' || !isFileEntry(entry)) return false;
  }
  if (!Array.isArray(v.deleted) || v.deleted.some((p) => typeof p !== 'string')) return false;
  if (!Array.isArray(v.renames) || v.renames.some((r) => !isRenameEntry(r))) return false;
  if (v.exclusions_applied !== null) {
    if (!Array.isArray(v.exclusions_applied)) return false;
    if (v.exclusions_applied.some((p) => typeof p !== 'string')) return false;
  }
  return true;
}

export function parseSnapshotManifest(raw: unknown): SnapshotManifest {
  if (!isObject(raw)) throw configInvalid('manifest', 'expected object');
  if (raw.schema_version !== '1.0')
    throw configInvalid('manifest.schema_version', `expected "1.0", got ${JSON.stringify(raw.schema_version)}`);
  if (typeof raw.id !== 'string') throw configInvalid('manifest.id', 'expected string');
  if (raw.type !== 'full' && raw.type !== 'inc')
    throw configInvalid('manifest.type', `expected "full" | "inc", got ${JSON.stringify(raw.type)}`);
  if (raw.parent_id !== null && typeof raw.parent_id !== 'string')
    throw configInvalid('manifest.parent_id', 'expected string or null');
  if (typeof raw.device_id !== 'string') throw configInvalid('manifest.device_id', 'expected string');
  if (typeof raw.created_at !== 'string') throw configInvalid('manifest.created_at', 'expected string');
  if (typeof raw.vault_name !== 'string') throw configInvalid('manifest.vault_name', 'expected string');
  if (typeof raw.vault_prefix !== 'string') throw configInvalid('manifest.vault_prefix', 'expected string');
  if (!isObject(raw.files)) throw configInvalid('manifest.files', 'expected object');
  for (const [k, entry] of Object.entries(raw.files)) {
    if (!isFileEntry(entry))
      throw configInvalid(`manifest.files[${JSON.stringify(k)}]`, 'expected {hash,size,mtime}');
  }
  if (!Array.isArray(raw.deleted))
    throw configInvalid('manifest.deleted', 'expected string[]');
  raw.deleted.forEach((p, i) => {
    if (typeof p !== 'string') throw configInvalid(`manifest.deleted[${i}]`, 'expected string');
  });
  if (!Array.isArray(raw.renames))
    throw configInvalid('manifest.renames', 'expected {from,to}[]');
  raw.renames.forEach((r, i) => {
    if (!isRenameEntry(r)) throw configInvalid(`manifest.renames[${i}]`, 'expected {from,to}');
  });
  if (raw.exclusions_applied !== null) {
    if (!Array.isArray(raw.exclusions_applied))
      throw configInvalid('manifest.exclusions_applied', 'expected string[] or null');
    raw.exclusions_applied.forEach((p, i) => {
      if (typeof p !== 'string')
        throw configInvalid(`manifest.exclusions_applied[${i}]`, 'expected string');
    });
  }
  return raw as unknown as SnapshotManifest;
}
