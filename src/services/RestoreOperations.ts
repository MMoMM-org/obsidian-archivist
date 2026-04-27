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
  ): Promise<RestoreResult> {
    const operation = writePath === sourcePath ? 'in_place' : 'as_copy';
    this.deps.logger.info(`Starting ${operation} restore`);

    // 1. Download + hash-verify (CONTENT_HASH_MISMATCH at this layer).
    const bytes = await this.deps.restoreService.fetchContent(snapshotId, sourcePath);

    // 2. Pre-write hash (SEC-M6). Guards against buffer mutation between
    //    fetch and write — unlikely but cheap insurance.
    await this.verifyPreWriteHash(bytes, sourcePath, snapshotId);

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
  ): Promise<void> {
    const state = await this.deps.restoreService.materializeVaultStateAt(snapshotId);
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

  private buildCopyPath(original: string): string {
    const ts = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const dot = original.lastIndexOf('.');
    if (dot === -1 || dot < original.lastIndexOf('/')) {
      return `${original}.restored-${ts}`;
    }
    const base = original.slice(0, dot);
    const ext = original.slice(dot);
    return `${base}.restored-${ts}${ext}`;
  }
}
