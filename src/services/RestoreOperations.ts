// RestoreOperations — user-facing restore actions (T8.3 / PRD F3).
//
// Three entry points wrap RestoreService.fetchContent with:
//   - Per-path mutex (ROB-010) to serialize concurrent restores of the same
//     file. Second caller throws PathError('RESTORE_IN_PROGRESS').
//   - Pre-write hash verification (SEC-M6). Even though fetchContent already
//     hash-verifies bytes against the manifest, we re-hash the in-memory
//     buffer here as defense-in-depth. Mismatch → CorruptionError(
//     'RESTORE_HASH_MISMATCH') with ZERO disk side-effects (no tmp, no
//     writeAtomic call).
//   - Atomic write via VaultAdapter.writeAtomic, which self-cleans its tmp
//     on any failure.
//
// copyToClipboard is similar but gated — text files only; binary throws
// PathError('BINARY_NOT_TEXT').

import { CorruptionError, PathError } from '../model/Errors';
import type { FileEntry } from '../model/Manifest';
import type { ManifestLoader } from './RestoreService';
import type { RestoreService } from './RestoreService';
import type { VaultAdapter } from '../infra/VaultAdapter';
import type { Logger } from '../infra/Logger';
import { sha256hex } from '../infra/Hasher';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RestoreOperationsDeps {
  restoreService: RestoreService;
  loader: ManifestLoader;
  vault: VaultAdapter;
  logger: Logger;
  /** Injectable hasher. Defaults to WebCrypto sha256hex. */
  hasher?: (bytes: Uint8Array) => Promise<string>;
  /** Clipboard writer for copyToClipboard. No default — production wires Obsidian's clipboard. */
  writeClipboard?: (text: string) => Promise<void>;
  /** Injectable for tests — defaults to Date.now(). */
  now?: () => number;
}

export interface RestoreResult {
  ok: true;
  path: string;
  snapshotId: string;
  bytesWritten: number;
}

export interface RestoreDirectoryResult {
  ok: number;
  failed: Array<{ path: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Binary detection (for copyToClipboard gate)
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.html',
  '.xml',
  '.js',
  '.ts',
  '.css',
  '.toml',
  '.ini',
]);

function looksTextByExtension(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

// ---------------------------------------------------------------------------
// RestoreOperations
// ---------------------------------------------------------------------------

export class RestoreOperations {
  private readonly activeMutexes = new Set<string>();
  private readonly hasher: (bytes: Uint8Array) => Promise<string>;
  private readonly now: () => number;

  constructor(private readonly deps: RestoreOperationsDeps) {
    this.hasher = deps.hasher ?? sha256hex;
    this.now = deps.now ?? ((): number => Date.now());
  }

  async restoreInPlace(path: string, snapshotId: string): Promise<RestoreResult> {
    return this.runWithMutex(path, () => this.writeRestore(path, snapshotId, path));
  }

  async restoreAsCopy(path: string, snapshotId: string): Promise<RestoreResult> {
    const copyPath = this.buildCopyPath(path);
    // Mutex keyed on the ORIGINAL path — prevents two copies racing if the
    // user clicks restore-as-copy twice quickly. Copy paths themselves carry
    // a timestamp so they won't collide.
    return this.runWithMutex(path, () => this.writeRestore(path, snapshotId, copyPath));
  }

  /**
   * Restore every file under a directory prefix from a snapshot.
   *
   * Sequential per-file restore via the same hash-verified pipeline as
   * single-file restores — no all-or-nothing atomicity. Failed files are
   * collected and reported; the loop continues past a failure so the user
   * gets a partial result instead of a half-done restore aborting mid-way.
   *
   * For `as_copy` mode a single timestamp is computed once at the start of
   * the batch and shared across every per-file copy path. This guarantees
   * unique sibling names for batches of more than one file even when
   * `Date.now()` would otherwise return the same millisecond for all of
   * them.
   */
  async restoreDirectory(
    dirPrefix: string,
    snapshotId: string,
    mode: 'in_place' | 'as_copy',
  ): Promise<RestoreDirectoryResult> {
    const normalized = dirPrefix.replace(/\/+$/, '');
    if (normalized === '') {
      throw new PathError(
        'INVALID_DIR_PREFIX',
        'Directory prefix must not be empty (root-level restore is not supported)',
        false,
      );
    }

    const state = await this.deps.restoreService.materializeVaultStateAt(snapshotId);
    const prefix = normalized + '/';
    const matches = Object.keys(state)
      .filter((p) => p === normalized || p.startsWith(prefix))
      .sort();

    this.deps.logger.info('dir_restore_started', {
      dir: normalized,
      snapshotId,
      mode,
      count: matches.length,
    });

    // Compute the timestamp once for as-copy batches so every file shares
    // the same `.restored-<ts>.<ext>` suffix. Use undefined (not 0) on the
    // in_place branch to flow through the buildCopyPath fallback contract.
    const sharedTs = mode === 'as_copy' ? this.now() : undefined;
    let ok = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const path of matches) {
      try {
        if (mode === 'in_place') {
          await this.restoreInPlaceWithState(path, snapshotId, state);
        } else {
          // sharedTs is defined here — narrowed by the mode check above.
          await this.restoreAsCopyAt(path, snapshotId, sharedTs!, state);
        }
        ok++;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failed.push({ path, error });
      }
    }

    this.deps.logger.info('dir_restore_done', {
      dir: normalized,
      ok,
      failed: failed.length,
    });

    return { ok, failed };
  }

  /**
   * Restore a single file as a copy using a caller-supplied timestamp.
   * Used by `restoreDirectory` so every file in a batch shares the same
   * `<basename>.restored-<ts>.<ext>` suffix. The pre-materialized state is
   * threaded through so the per-file pre-write hash check skips a
   * redundant chain merge.
   */
  private async restoreAsCopyAt(
    path: string,
    snapshotId: string,
    sharedTs: number,
    precomputedState?: Record<string, FileEntry>,
  ): Promise<RestoreResult> {
    const copyPath = this.buildCopyPath(path, sharedTs);
    return this.runWithMutex(path, () =>
      this.writeRestore(path, snapshotId, copyPath, precomputedState),
    );
  }

  /**
   * Internal in-place restore that accepts the pre-materialized state, so
   * the dir-restore loop's first materialize can be reused for every
   * file's pre-write hash check.
   */
  private async restoreInPlaceWithState(
    path: string,
    snapshotId: string,
    precomputedState: Record<string, FileEntry>,
  ): Promise<RestoreResult> {
    return this.runWithMutex(path, () =>
      this.writeRestore(path, snapshotId, path, precomputedState),
    );
  }

  async copyToClipboard(path: string, snapshotId: string): Promise<void> {
    if (!looksTextByExtension(path)) {
      throw new PathError(
        'BINARY_NOT_TEXT',
        `Cannot copy binary file to clipboard: ${path}`,
        false,
      );
    }
    if (!this.deps.writeClipboard) {
      throw new Error('copyToClipboard requires a writeClipboard dependency');
    }

    const bytes = await this.deps.restoreService.fetchContent(snapshotId, path);
    await this.verifyPreWriteHash(bytes, path, snapshotId);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    await this.deps.writeClipboard(text);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async runWithMutex<T>(path: string, op: () => Promise<T>): Promise<T> {
    if (this.activeMutexes.has(path)) {
      throw new PathError(
        'RESTORE_IN_PROGRESS',
        `A restore is already in progress for ${path}`,
        false,
      );
    }
    this.activeMutexes.add(path);
    try {
      return await op();
    } finally {
      this.activeMutexes.delete(path);
    }
  }

  private async writeRestore(
    sourcePath: string,
    snapshotId: string,
    writePath: string,
    /**
     * Optional pre-materialized vault state for the snapshot. When
     * `restoreDirectory` orchestrates a batch, it materializes once and
     * passes the same map to every per-file write — saving O(N) full
     * chain-merge replays. Single-file callers omit it; verifyPreWriteHash
     * falls back to materializing on demand.
     */
    precomputedState?: Record<string, FileEntry>,
  ): Promise<RestoreResult> {
    const operation = writePath === sourcePath ? 'in_place' : 'as_copy';
    this.deps.logger.info(`Starting ${operation} restore`);

    // 1. Download + hash-verify (CONTENT_HASH_MISMATCH at this layer).
    const bytes = await this.deps.restoreService.fetchContent(snapshotId, sourcePath);

    // 2. Pre-write hash (SEC-M6). Guards against buffer mutation between
    //    fetch and write — unlikely but cheap insurance.
    await this.verifyPreWriteHash(bytes, sourcePath, snapshotId, precomputedState);

    // 3. Recreate missing parent directories (PRD F4 AC-4).
    await this.deps.vault.mkdirParents(writePath);

    // 4. Atomic write — VaultAdapter.writeAtomic self-cleans tmp on failure.
    await this.deps.vault.writeAtomic(writePath, bytes);

    // Per-path debug line, gated by diagnostic_logging — same pattern as
    // BackupService's "wrote" lines.
    this.deps.logger.debug('wrote', { path: writePath });
    this.deps.logger.info(`${operation} restore done`);
    this.deps.logger.info('1 file restored');

    return { ok: true, path: writePath, snapshotId, bytesWritten: bytes.length };
  }

  private async verifyPreWriteHash(
    bytes: Uint8Array,
    sourcePath: string,
    snapshotId: string,
    precomputedState?: Record<string, FileEntry>,
  ): Promise<void> {
    const state =
      precomputedState ??
      (await this.deps.restoreService.materializeVaultStateAt(snapshotId));
    const entry = state[sourcePath];
    if (!entry) {
      // Defensive — fetchContent would have caught this, but order-independence
      // is cheap and catches future refactors that change call order.
      throw new PathError(
        'PATH_NOT_IN_SNAPSHOT',
        `Path "${sourcePath}" is not present at snapshot ${snapshotId}`,
        false,
      );
    }
    const actual = await this.hasher(bytes);
    if (actual !== entry.hash) {
      throw new CorruptionError(
        'RESTORE_HASH_MISMATCH',
        `Pre-write hash mismatch for ${sourcePath}@${snapshotId}: expected ${entry.hash}, got ${actual}`,
        false,
      );
    }
  }

  private buildCopyPath(original: string, sharedTs?: number): string {
    // Defensive against `0` being passed as a "don't-care" sentinel — `??`
    // would also accept 0 here, but a future caller passing 0 explicitly
    // would silently get the epoch path. The undefined-aware check makes
    // the contract explicit: only undefined falls back to now().
    const ts = new Date(sharedTs !== undefined ? sharedTs : this.now())
      .toISOString()
      .replace(/[:.]/g, '-');
    const dot = original.lastIndexOf('.');
    if (dot === -1 || dot < original.lastIndexOf('/')) {
      return `${original}.restored-${ts}`;
    }
    const base = original.slice(0, dot);
    const ext = original.slice(dot);
    return `${base}.restored-${ts}${ext}`;
  }
}
