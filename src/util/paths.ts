import { PathError } from '../model/Errors';
import type { SnapshotManifest } from '../model/Manifest';

// All Dropbox paths live under `Apps/Archivist/` — enforced by the App-Folder
// permission in the OAuth app itself. `assertInAppFolder` is a belt-and-braces
// client-side guard so programmer mistakes can't send a request for a path
// outside that scope.

export const APP_FOLDER_ROOT = 'Apps/Archivist';

// SEC-M7 — vault prefix format. Lowercase, alnum + dash/underscore, 2–64 chars,
// must start with alnum. Rejects anything that could escape the App Folder or
// be case-normalized by Dropbox in surprising ways (ADR-18).
export const VAULT_PREFIX_REGEX = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export function assertInAppFolder(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new PathError('INVALID_PATH', 'path must be a non-empty string', false);
  }
  const normalized = path.replace(/^\/+/, '');
  if (!normalized.startsWith(APP_FOLDER_ROOT + '/') && normalized !== APP_FOLDER_ROOT) {
    throw new PathError('PATH_OUTSIDE_APP_FOLDER', `path is not under ${APP_FOLDER_ROOT}/: ${path}`, false);
  }
  if (normalized.includes('..')) {
    throw new PathError('PATH_TRAVERSAL', `path contains '..': ${path}`, false);
  }
}

export function validateVaultPrefix(prefix: string): string {
  if (typeof prefix !== 'string' || !VAULT_PREFIX_REGEX.test(prefix)) {
    throw new PathError(
      'INVALID_VAULT_PREFIX',
      `vault prefix must match ${VAULT_PREFIX_REGEX} (lowercase alnum + - _, 2–64 chars): ${String(prefix)}`,
      false,
    );
  }
  return prefix;
}

export function slugifyVaultName(name: string): string {
  // NFKD normalize then strip combining diacritics (U+0300..U+036F) so "Ëtude"
  // becomes "etude" rather than an empty slug. The follow-up `[^a-z0-9]+`
  // sweep catches any remaining non-ASCII.
  const stripped = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  let slug = stripped.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length === 0) slug = 'vault';
  if (slug.length < 2) slug = slug + '-vault';
  if (slug.length > 64) slug = slug.slice(0, 64).replace(/-+$/, '');
  return slug;
}

// Remote-path builders. Callers pass the already-validated vault prefix; these
// functions never attempt to re-slugify, to avoid double-normalization bugs.
export function vaultRoot(prefix: string): string {
  validateVaultPrefix(prefix);
  return `${APP_FOLDER_ROOT}/${prefix}`;
}

export function headPath(prefix: string): string {
  return `${vaultRoot(prefix)}/HEAD.json`;
}

export function snapshotIndexPath(prefix: string): string {
  return `${vaultRoot(prefix)}/snapshot_index.json`;
}

export function gcLockPath(prefix: string): string {
  return `${vaultRoot(prefix)}/gc_lock`;
}

export function snapshotsDir(prefix: string): string {
  return `${vaultRoot(prefix)}/snapshots`;
}

export function snapshotPath(manifest: Pick<SnapshotManifest, 'vault_prefix' | 'id'>): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-(full|inc)$/.test(manifest.id)) {
    throw new PathError(
      'INVALID_SNAPSHOT_ID',
      `manifest id must be ISO-with-dashes form (YYYY-MM-DDThh-mm-<type>): ${manifest.id}`,
      false,
    );
  }
  return `${snapshotsDir(manifest.vault_prefix)}/${manifest.id}.json`;
}

export function contentFolderPath(prefix: string): string {
  return `${vaultRoot(prefix)}/content`;
}

export function contentPath(prefix: string, sha256hex: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256hex)) {
    throw new PathError('INVALID_CONTENT_HASH', `content hash must be 64 lowercase hex chars: ${sha256hex}`, false);
  }
  const bucket = sha256hex.slice(0, 2);
  return `${vaultRoot(prefix)}/content/${bucket}/${sha256hex}`;
}
