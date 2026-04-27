// Map a restore-pipeline error to a user-friendly toast string.
//
// Centralising this here lets multiple views (BackupBrowserView,
// FileVersionsView) surface the same wording for the same error code.
// The codebase's domain errors (ChainError, CorruptionError, PathError)
// all carry a `code` field; pattern-match on that and fall back to a
// generic message rather than leaking raw `err.message` text like
// "Path 'notes/secret.md' is not present at snapshot ..." into the toast.

import { ChainError, CorruptionError, PathError } from '../model/Errors';
import { S } from './strings';

export function mapRestoreErrorToToast(err: unknown): string {
  if (err instanceof ChainError && err.code === 'CHAIN_BROKEN') {
    return S.BROWSER_ERROR_CHAIN_BROKEN;
  }
  if (err instanceof CorruptionError && err.code === 'RESTORE_HASH_MISMATCH') {
    return S.ERROR_CONTENT_HASH_MISMATCH;
  }
  if (err instanceof CorruptionError && err.code === 'CONTENT_HASH_MISMATCH') {
    return S.ERROR_CONTENT_HASH_MISMATCH;
  }
  if (err instanceof PathError && err.code === 'RESTORE_IN_PROGRESS') {
    return S.RESTORE_IN_PROGRESS;
  }
  return S.TOAST_ERROR_GENERIC;
}
