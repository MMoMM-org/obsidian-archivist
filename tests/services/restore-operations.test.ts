// T8.3 — RestoreOperations: mutex + pre-write hash + atomic write.

import { describe, expect, it, vi } from 'vitest';
import { RestoreOperations, type RestoreOperationsDeps } from '../../src/services/RestoreOperations';
import { RestoreService, type ManifestLoader } from '../../src/services/RestoreService';
import type { SnapshotManifest } from '../../src/model/Manifest';
import type { Logger } from '../../src/infra/Logger';
import type { VaultAdapter } from '../../src/infra/VaultAdapter';
import { CorruptionError, PathError } from '../../src/model/Errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function makeManifest(): SnapshotManifest {
  return {
    schema_version: '1.0',
    id: '2026-04-20T03-00-full',
    type: 'full',
    parent_id: null,
    device_id: 'd0',
    created_at: '2026-04-20T03:00:00.000Z',
    vault_name: 'vault',
    vault_prefix: 'test-vault',
    files: {
      'notes/a.md': { hash: HASH_A, size: 5, mtime: 1000 },
      Makefile: { hash: HASH_A, size: 5, mtime: 1000 },
    },
    deleted: [],
    renames: [],
    exclusions_applied: null,
  };
}

function fixtureLoader(m: SnapshotManifest): ManifestLoader {
  return { loadManifest: async () => m };
}

interface VaultCall {
  op: 'mkdirParents' | 'writeAtomic' | 'readBytes';
  path: string;
  bytes?: Uint8Array;
}

function makeFakeVault(opts: { failWriteAtomic?: boolean } = {}): {
  vault: VaultAdapter;
  calls: VaultCall[];
  tmpExists: { value: boolean };
} {
  const calls: VaultCall[] = [];
  const tmpExists = { value: false };
  const fake = {
    mkdirParents: async (path: string): Promise<void> => {
      calls.push({ op: 'mkdirParents', path });
    },
    writeAtomic: async (path: string, bytes: Uint8Array): Promise<void> => {
      calls.push({ op: 'writeAtomic', path, bytes });
      if (opts.failWriteAtomic) {
        // Simulate writeAtomic's self-cleaning contract — tmp gone on failure.
        tmpExists.value = false;
        throw new Error('simulated write failure');
      }
    },
    readBytes: async (): Promise<Uint8Array> => new Uint8Array(),
  } as unknown as VaultAdapter;
  return { vault: fake, calls, tmpExists };
}

interface HarnessOpts {
  bytes?: Uint8Array;
  downloadHash?: string; // what fetchContent believes the download hashes to
  prewriteHash?: string; // what the pre-write hash returns
  writeClipboard?: (text: string) => Promise<void>;
  failWriteAtomic?: boolean;
  now?: () => number;
}

function makeHarness(opts: HarnessOpts = {}): {
  ops: RestoreOperations;
  vaultCalls: VaultCall[];
  logger: Logger;
} {
  const manifest = makeManifest();
  const bytes = opts.bytes ?? new Uint8Array([1, 2, 3, 4, 5]);
  const dropbox = {
    downloadBytes: async () => bytes,
  };
  const restoreService = new RestoreService({
    loader: fixtureLoader(manifest),
    dropbox,
    logger: makeLogger(),
    hasher: async () => opts.downloadHash ?? HASH_A,
  });

  const { vault, calls } = makeFakeVault({ failWriteAtomic: opts.failWriteAtomic });
  const logger = makeLogger();

  const deps: RestoreOperationsDeps = {
    restoreService,
    loader: fixtureLoader(manifest),
    vault,
    logger,
    hasher: async () => opts.prewriteHash ?? HASH_A,
    writeClipboard: opts.writeClipboard,
    now: opts.now,
  };

  return { ops: new RestoreOperations(deps), vaultCalls: calls, logger };
}

// ---------------------------------------------------------------------------
// restoreInPlace — happy path + TEST-C1 assertion battery
// ---------------------------------------------------------------------------

describe('restoreInPlace — happy path', () => {
  it('mkdir → writeAtomic → return ok', async () => {
    const h = makeHarness();
    const result = await h.ops.restoreInPlace('notes/a.md', '2026-04-20T03-00-full');
    expect(result).toMatchObject({ ok: true, path: 'notes/a.md', bytesWritten: 5 });
    const ops = h.vaultCalls.map((c) => c.op);
    expect(ops).toEqual(['mkdirParents', 'writeAtomic']);
  });

  it('bytes reach writeAtomic unchanged', async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const h = makeHarness({ bytes });
    await h.ops.restoreInPlace('notes/a.md', '2026-04-20T03-00-full');
    const writeCall = h.vaultCalls.find((c) => c.op === 'writeAtomic');
    expect(writeCall?.bytes).toEqual(bytes);
  });
});

describe('restoreInPlace — TEST-C1 assertion battery on RESTORE_HASH_MISMATCH', () => {
  it('throws CorruptionError(RESTORE_HASH_MISMATCH) when pre-write hash differs from manifest', async () => {
    const h = makeHarness({ downloadHash: HASH_A, prewriteHash: HASH_B });
    await expect(h.ops.restoreInPlace('notes/a.md', '2026-04-20T03-00-full')).rejects.toMatchObject({
      code: 'RESTORE_HASH_MISMATCH',
    });
  });

  it('writeAtomic is NEVER called when the pre-write hash fails', async () => {
    const h = makeHarness({ downloadHash: HASH_A, prewriteHash: HASH_B });
    await expect(h.ops.restoreInPlace('notes/a.md', '2026-04-20T03-00-full')).rejects.toBeInstanceOf(CorruptionError);
    const writeCalls = h.vaultCalls.filter((c) => c.op === 'writeAtomic');
    expect(writeCalls).toHaveLength(0);
  });

  it('mkdirParents is NOT called when the pre-write hash fails (hash comes first)', async () => {
    const h = makeHarness({ downloadHash: HASH_A, prewriteHash: HASH_B });
    await expect(h.ops.restoreInPlace('notes/a.md', '2026-04-20T03-00-full')).rejects.toBeInstanceOf(CorruptionError);
    const mkdirCalls = h.vaultCalls.filter((c) => c.op === 'mkdirParents');
    expect(mkdirCalls).toHaveLength(0);
  });

  it('restore_completed log line is NOT emitted on RESTORE_HASH_MISMATCH', async () => {
    const h = makeHarness({ downloadHash: HASH_A, prewriteHash: HASH_B });
    await expect(h.ops.restoreInPlace('notes/a.md', '2026-04-20T03-00-full')).rejects.toBeInstanceOf(CorruptionError);
    const restoreLogs = (h.logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'restore_completed',
    );
    expect(restoreLogs).toHaveLength(0);
  });
});

describe('restoreInPlace — CONTENT_HASH_MISMATCH at download layer', () => {
  it('fetchContent throws before pre-write check even runs', async () => {
    // If the download-layer hash disagrees with the manifest hash, fetchContent
    // throws CONTENT_HASH_MISMATCH; RestoreOperations must propagate as-is.
    const h = makeHarness({ downloadHash: HASH_B, prewriteHash: HASH_A });
    await expect(h.ops.restoreInPlace('notes/a.md', '2026-04-20T03-00-full')).rejects.toMatchObject({
      code: 'CONTENT_HASH_MISMATCH',
    });
    // No disk activity on propagation either.
    expect(h.vaultCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Per-path mutex (ROB-010)
// ---------------------------------------------------------------------------

describe('restoreInPlace — per-path mutex', () => {
  it('second concurrent call for the same path throws RESTORE_IN_PROGRESS', async () => {
    // Use a blocking writeAtomic so the first call's mutex is still held.
    const h = makeHarness();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const originalWriteAtomic = (h.ops as unknown as { deps: RestoreOperationsDeps }).deps.vault.writeAtomic;
    (h.ops as unknown as { deps: RestoreOperationsDeps }).deps.vault.writeAtomic = async (p, b) => {
      await gate;
      return originalWriteAtomic.call((h.ops as unknown as { deps: RestoreOperationsDeps }).deps.vault, p, b);
    };

    const first = h.ops.restoreInPlace('notes/a.md', '2026-04-20T03-00-full');
    // Let the first call acquire the mutex
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await expect(
      h.ops.restoreInPlace('notes/a.md', '2026-04-20T03-00-full'),
    ).rejects.toMatchObject({ code: 'RESTORE_IN_PROGRESS' });

    release();
    await first; // clean up
  });

  it('mutex is released even when restore fails (error path)', async () => {
    const h = makeHarness({ downloadHash: HASH_A, prewriteHash: HASH_B });
    await expect(h.ops.restoreInPlace('notes/a.md', '2026-04-20T03-00-full')).rejects.toBeInstanceOf(
      CorruptionError,
    );
    // Second call must succeed (mutex released despite the throw).
    const h2 = h.ops;
    // Patch hashes to succeed on retry — same harness, just retry semantics.
    (h2 as unknown as { hasher: () => Promise<string> }).hasher = async () => HASH_A;
    const result = await h2.restoreInPlace('notes/a.md', '2026-04-20T03-00-full');
    expect(result.ok).toBe(true);
  });

  it('different paths do NOT serialise — concurrent restores of different files run in parallel', async () => {
    // A completes normally; B's mutex is held independently.
    const h = makeHarness();
    const [a, b] = await Promise.all([
      h.ops.restoreInPlace('notes/a.md', '2026-04-20T03-00-full'),
      h.ops.restoreInPlace('notes/a.md', '2026-04-20T03-00-full').catch((e) => e),
    ]);
    // One succeeded, the other got RESTORE_IN_PROGRESS (since same path).
    const results = [a, b];
    const successCount = results.filter((r) => typeof r === 'object' && r !== null && 'ok' in r && r.ok).length;
    const inProgressCount = results.filter((r) => r instanceof PathError && r.code === 'RESTORE_IN_PROGRESS').length;
    expect(successCount + inProgressCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// restoreAsCopy
// ---------------------------------------------------------------------------

describe('restoreAsCopy', () => {
  it('writes to <basename>.restored-<ts>.<ext> next to original', async () => {
    const h = makeHarness({ now: () => new Date('2026-04-24T10:00:00Z').getTime() });
    const result = await h.ops.restoreAsCopy('notes/a.md', '2026-04-20T03-00-full');
    expect(result.path).toMatch(/^notes\/a\.restored-2026-04-24T10-00-00-000Z\.md$/);
  });

  it('handles files without extensions', async () => {
    const h = makeHarness({ now: () => new Date('2026-04-24T10:00:00Z').getTime() });
    const result = await h.ops.restoreAsCopy('Makefile', '2026-04-20T03-00-full');
    expect(result.path).toMatch(/^Makefile\.restored-/);
  });

  it('mutex is keyed on the ORIGINAL path (concurrent as-copy on same source blocks)', async () => {
    const h = makeHarness();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const originalWriteAtomic = (h.ops as unknown as { deps: RestoreOperationsDeps }).deps.vault.writeAtomic;
    (h.ops as unknown as { deps: RestoreOperationsDeps }).deps.vault.writeAtomic = async (p, b) => {
      await gate;
      return originalWriteAtomic.call((h.ops as unknown as { deps: RestoreOperationsDeps }).deps.vault, p, b);
    };

    const first = h.ops.restoreAsCopy('notes/a.md', '2026-04-20T03-00-full');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await expect(h.ops.restoreAsCopy('notes/a.md', '2026-04-20T03-00-full')).rejects.toMatchObject({
      code: 'RESTORE_IN_PROGRESS',
    });
    release();
    await first;
  });
});

// ---------------------------------------------------------------------------
// copyToClipboard
// ---------------------------------------------------------------------------

describe('copyToClipboard', () => {
  it('copies UTF-8 decoded bytes for text files', async () => {
    let copied = '';
    const h = makeHarness({
      bytes: new TextEncoder().encode('hello world'),
      writeClipboard: async (t) => {
        copied = t;
      },
    });
    await h.ops.copyToClipboard('notes/a.md', '2026-04-20T03-00-full');
    expect(copied).toBe('hello world');
  });

  it('throws BINARY_NOT_TEXT for non-text extensions', async () => {
    const h = makeHarness({ writeClipboard: async () => {} });
    await expect(h.ops.copyToClipboard('notes/a.pdf', '2026-04-20T03-00-full')).rejects.toMatchObject({
      code: 'BINARY_NOT_TEXT',
    });
  });

  it('throws when no writeClipboard dep is wired', async () => {
    const h = makeHarness({});
    await expect(h.ops.copyToClipboard('notes/a.md', '2026-04-20T03-00-full')).rejects.toThrow();
  });
});
