// T5.2 — Pure functions for building SnapshotManifest objects.
// No I/O, no logging, no timers. All inputs explicit, all outputs fresh.

import type { SnapshotManifest, RenameEntry } from '../model/Manifest';

export interface BuildFullManifestInput {
  vaultFiles: Array<{ path: string; mtime: number; size: number }>;
  hashes: Map<string, string>;
  vaultName: string;
  vaultPrefix: string;
  deviceId: string;
  createdAt: string;
  exclusionsApplied?: string[] | null;
}

export interface IncChange {
  /** CURRENT path (post-rename) where the content-state is recorded. */
  path: string;
  hash: string;
  size: number;
  mtime: number;
}

export interface BuildIncManifestInput {
  parentId: string;
  changes: IncChange[];
  deleted: string[];
  renames: RenameEntry[];
  vaultName: string;
  vaultPrefix: string;
  deviceId: string;
  createdAt: string;
  exclusionsApplied?: string[] | null;
}

/**
 * Derives a filesystem-safe snapshot id from an ISO-8601 createdAt string.
 * '2026-04-23T14:00:00.000Z' + 'full' → '2026-04-23T14-00-full'
 * Pattern: YYYY-MM-DDTHH-MM-(full|inc)
 */
function deriveId(createdAt: string, type: 'full' | 'inc'): string {
  // Capture date and HH:MM, ignore seconds and fractional/timezone
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(createdAt);
  if (!match) throw new Error(`ManifestBuilder: invalid createdAt format: ${createdAt}`);
  return `${match[1]}T${match[2]}-${match[3]}-${type}`;
}

export function buildFullManifest(input: BuildFullManifestInput): SnapshotManifest {
  const { vaultFiles, hashes, vaultName, vaultPrefix, deviceId, createdAt } = input;
  const exclusionsApplied = input.exclusionsApplied ?? null;

  const files: Record<string, { hash: string; size: number; mtime: number }> = {};
  for (const f of vaultFiles) {
    const hash = hashes.get(f.path);
    if (hash === undefined) throw new Error(`ManifestBuilder: missing hash for "${f.path}"`);
    files[f.path] = { hash, size: f.size, mtime: f.mtime };
  }

  return {
    schema_version: '1.0',
    id: deriveId(createdAt, 'full'),
    type: 'full',
    parent_id: null,
    device_id: deviceId,
    created_at: createdAt,
    vault_name: vaultName,
    vault_prefix: vaultPrefix,
    files,
    deleted: [],
    renames: [],
    exclusions_applied: exclusionsApplied,
  };
}

export function buildIncManifest(input: BuildIncManifestInput): SnapshotManifest {
  const { parentId, changes, deleted, renames, vaultName, vaultPrefix, deviceId, createdAt } = input;
  const exclusionsApplied = input.exclusionsApplied ?? null;

  const files: Record<string, { hash: string; size: number; mtime: number }> = {};
  for (const c of changes) {
    files[c.path] = { hash: c.hash, size: c.size, mtime: c.mtime };
  }

  return {
    schema_version: '1.0',
    id: deriveId(createdAt, 'inc'),
    type: 'inc',
    parent_id: parentId,
    device_id: deviceId,
    created_at: createdAt,
    vault_name: vaultName,
    vault_prefix: vaultPrefix,
    files,
    deleted: [...deleted],
    // Deep-copy renames so caller mutations after the call can't corrupt the
    // returned manifest. [...renames] would only shallow-copy the array.
    renames: renames.map((r) => ({ from: r.from, to: r.to })),
    exclusions_applied: exclusionsApplied,
  };
}
