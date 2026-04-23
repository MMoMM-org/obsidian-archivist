import { configInvalid } from './Errors';
import type { SnapshotType } from './Manifest';

export interface SnapshotIndexEntry {
  id: string;
  type: SnapshotType;
  parent_id: string | null;
  created_at: string;
  device_id: string;
  blob_hashes: string[];
}

export interface SnapshotIndex {
  schema_version: '1.0';
  last_updated_at: string;
  snapshots: SnapshotIndexEntry[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isSnapshotIndexEntry(v: unknown): v is SnapshotIndexEntry {
  if (!isObject(v)) return false;
  if (typeof v.id !== 'string') return false;
  if (v.type !== 'full' && v.type !== 'inc') return false;
  if (v.parent_id !== null && typeof v.parent_id !== 'string') return false;
  if (typeof v.created_at !== 'string') return false;
  if (typeof v.device_id !== 'string') return false;
  if (!Array.isArray(v.blob_hashes)) return false;
  if (v.blob_hashes.some((h) => typeof h !== 'string')) return false;
  return true;
}

export function isSnapshotIndex(v: unknown): v is SnapshotIndex {
  if (!isObject(v)) return false;
  if (v.schema_version !== '1.0') return false;
  if (typeof v.last_updated_at !== 'string') return false;
  if (!Array.isArray(v.snapshots)) return false;
  return v.snapshots.every(isSnapshotIndexEntry);
}

export function parseSnapshotIndex(raw: unknown): SnapshotIndex {
  if (!isObject(raw)) throw configInvalid('snapshot_index', 'expected object');
  if (raw.schema_version !== '1.0')
    throw configInvalid('snapshot_index.schema_version', `expected "1.0", got ${JSON.stringify(raw.schema_version)}`);
  if (typeof raw.last_updated_at !== 'string')
    throw configInvalid('snapshot_index.last_updated_at', 'expected string');
  if (!Array.isArray(raw.snapshots))
    throw configInvalid('snapshot_index.snapshots', 'expected array');
  raw.snapshots.forEach((entry, i) => {
    if (!isObject(entry))
      throw configInvalid(`snapshot_index.snapshots[${i}]`, 'expected object');
    if (typeof entry.id !== 'string')
      throw configInvalid(`snapshot_index.snapshots[${i}].id`, 'expected string');
    if (entry.type !== 'full' && entry.type !== 'inc')
      throw configInvalid(`snapshot_index.snapshots[${i}].type`, 'expected "full" | "inc"');
    if (entry.parent_id !== null && typeof entry.parent_id !== 'string')
      throw configInvalid(`snapshot_index.snapshots[${i}].parent_id`, 'expected string or null');
    if (typeof entry.created_at !== 'string')
      throw configInvalid(`snapshot_index.snapshots[${i}].created_at`, 'expected string');
    if (typeof entry.device_id !== 'string')
      throw configInvalid(`snapshot_index.snapshots[${i}].device_id`, 'expected string');
    if (!Array.isArray(entry.blob_hashes))
      throw configInvalid(`snapshot_index.snapshots[${i}].blob_hashes`, 'expected string[]');
    entry.blob_hashes.forEach((h, j) => {
      if (typeof h !== 'string')
        throw configInvalid(`snapshot_index.snapshots[${i}].blob_hashes[${j}]`, 'expected string');
    });
  });
  return raw as unknown as SnapshotIndex;
}
