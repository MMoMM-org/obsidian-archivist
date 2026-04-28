import { PathError } from '../model/Errors';
import type { SnapshotManifest } from '../model/Manifest';

// Dropbox paths produced by the builders below are RELATIVE to the OAuth
// app folder. Dropbox auto-prepends `/Apps/<AppName>/` server-side because
// the app is registered with App-Folder permission scope (NOT Full Dropbox).
// We must NOT include `Apps/Archivist/` in the paths we send — earlier
// versions did, which produced data stored at
// `/Apps/Archivist/Apps/Archivist/<vault_prefix>/...` (visible double prefix
// in the Dropbox web UI). Fixed: paths are now `/<vault_prefix>/...` only.

// Kept as an exported empty string so external callers that want to refer
// to "the app folder root" semantically still have a name; concatenation
// with a prefix produces the leading-slash form Dropbox expects.
export const APP_FOLDER_ROOT = '';

// SEC-M7 — vault prefix format. Lowercase, alnum + dash/underscore, 2–64 chars,
// must start with alnum. Rejects anything that could escape the App Folder or
// be case-normalized by Dropbox in surprising ways (ADR-18).
export const VAULT_PREFIX_REGEX = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/**
 * Path-traversal guard. With App-Folder scope, Dropbox itself enforces that
 * paths cannot escape the app folder, so the historic `Apps/Archivist/`
 * prefix-check is gone — but `..` segments would still be a programmer
 * mistake worth catching client-side.
 */
export function assertInAppFolder(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new PathError('INVALID_PATH', 'path must be a non-empty string', false);
  }
  const normalized = path.replace(/^\/+/, '');
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
// Returned paths are app-folder-relative (Dropbox prepends `/Apps/Archivist/`
// on the server because the OAuth app is App-Folder scoped).
export function vaultRoot(prefix: string): string {
  validateVaultPrefix(prefix);
  return prefix;
}

export function headPath(prefix: string): string {
  return `${vaultRoot(prefix)}/HEAD.json`;
}

export function snapshotIndexPath(prefix: string): string {
  return `${vaultRoot(prefix)}/snapshot_index.json`;
}

export function vaultMetaPath(prefix: string): string {
  return `${vaultRoot(prefix)}/vault_meta.json`;
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
