// restoreDirectory — sequential per-file restore over a snapshot prefix.
//
// Covers:
//   - prefix filter inclusion/exclusion (foo vs foobar collision guard)
//   - trailing-slash normalization
//   - root-level rejection (empty prefix)
//   - partial failure (loop continues past a file-level error)
//   - shared timestamp for as-copy mode (no sibling-name collisions)

import { describe, expect, it, vi } from 'vitest';
import { RestoreOperations, type RestoreOperationsDeps } from '../../src/services/RestoreOperations';
import { RestoreService, type ManifestLoader } from '../../src/services/RestoreService';
import type { SnapshotManifest } from '../../src/model/Manifest';
import type { Logger } from '../../src/infra/Logger';
import type { VaultAdapter } from '../../src/infra/VaultAdapter';
import { PathError } from '../../src/model/Errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HASH_A = 'a'.repeat(64);

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Manifest with files spread across two near-named directories — used to
 *  prove the prefix filter does not match `foo` against `foobar/`. */
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
      'foo/a.md': { hash: HASH_A, size: 5, mtime: 1000 },
      'foo/b.md': { hash: HASH_A, size: 5, mtime: 1000 },
      'foo/sub/c.md': { hash: HASH_A, size: 5, mtime: 1000 },
      'foobar/x.md': { hash: HASH_A, size: 5, mtime: 1000 },
      'other/y.md': { hash: HASH_A, size: 5, mtime: 1000 },
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
  op: 'mkdirParents' | 'writeAtomic';
  path: string;
}

function makeFakeVault(opts: { failPaths?: Set<string> } = {}): {
  vault: VaultAdapter;
  calls: VaultCall[];
} {
  const calls: VaultCall[] = [];
  const fake = {
    mkdirParents: async (path: string): Promise<void> => {
      calls.push({ op: 'mkdirParents', path });
    },
    writeAtomic: async (path: string): Promise<void> => {
      calls.push({ op: 'writeAtomic', path });
      if (opts.failPaths?.has(path)) {
        throw new Error(`simulated failure for ${path}`);
      }
    },
    readBytes: async (): Promise<Uint8Array> => new Uint8Array(),
  } as unknown as VaultAdapter;
  return { vault: fake, calls };
}

interface HarnessOpts {
  failPaths?: Set<string>;
  now?: () => number;
}

function makeHarness(opts: HarnessOpts = {}): {
  ops: RestoreOperations;
  vaultCalls: VaultCall[];
  logger: Logger;
} {
  const manifest = makeManifest();
  const dropbox = {
    downloadBytes: async () => new Uint8Array([1, 2, 3, 4, 5]),
  };
  const restoreService = new RestoreService({
    loader: fixtureLoader(manifest),
    dropbox,
    logger: makeLogger(),
    hasher: async () => HASH_A,
  });

  const { vault, calls } = makeFakeVault({ failPaths: opts.failPaths });
  const logger = makeLogger();

  const deps: RestoreOperationsDeps = {
    restoreService,
    loader: fixtureLoader(manifest),
    vault,
    logger,
    hasher: async () => HASH_A,
    now: opts.now,
  };

  return { ops: new RestoreOperations(deps), vaultCalls: calls, logger };
}

// ---------------------------------------------------------------------------
// Prefix filter
// ---------------------------------------------------------------------------

describe('restoreDirectory — prefix filter', () => {
  it('matches files directly under the prefix', async () => {
    const h = makeHarness();
    const result = await h.ops.restoreDirectory('foo', '2026-04-20T03-00-full', 'in_place');
    expect(result.ok).toBe(3); // foo/a.md, foo/b.md, foo/sub/c.md
    expect(result.failed).toEqual([]);
    const writes = h.vaultCalls.filter((c) => c.op === 'writeAtomic').map((c) => c.path);
    expect(writes).toEqual(expect.arrayContaining(['foo/a.md', 'foo/b.md', 'foo/sub/c.md']));
  });

  it('does NOT match a sibling directory whose name shares a prefix (foo vs foobar/)', async () => {
    const h = makeHarness();
    const result = await h.ops.restoreDirectory('foo', '2026-04-20T03-00-full', 'in_place');
    const writes = h.vaultCalls.filter((c) => c.op === 'writeAtomic').map((c) => c.path);
    expect(writes).not.toContain('foobar/x.md');
    expect(result.ok).toBe(3);
  });

  it('normalizes a trailing slash on the input prefix', async () => {
    const h = makeHarness();
    const result = await h.ops.restoreDirectory('foo/', '2026-04-20T03-00-full', 'in_place');
    expect(result.ok).toBe(3);
  });

  it('returns an empty result (no exception) when the prefix matches no files', async () => {
    const h = makeHarness();
    const result = await h.ops.restoreDirectory('nope', '2026-04-20T03-00-full', 'in_place');
    expect(result).toEqual({ ok: 0, failed: [] });
  });
});

describe('restoreDirectory — root-level rejection', () => {
  it('throws PathError(INVALID_DIR_PREFIX) for an empty prefix', async () => {
    const h = makeHarness();
    await expect(
      h.ops.restoreDirectory('', '2026-04-20T03-00-full', 'in_place'),
    ).rejects.toMatchObject({ code: 'INVALID_DIR_PREFIX' });
  });

  it('throws PathError(INVALID_DIR_PREFIX) for a slash-only prefix', async () => {
    const h = makeHarness();
    await expect(
      h.ops.restoreDirectory('/', '2026-04-20T03-00-full', 'in_place'),
    ).rejects.toBeInstanceOf(PathError);
  });
});

// ---------------------------------------------------------------------------
// Partial failure
// ---------------------------------------------------------------------------

describe('restoreDirectory — partial failure', () => {
  it('continues past a file-level write failure and reports it in `failed`', async () => {
    const h = makeHarness({ failPaths: new Set(['foo/b.md']) });
    const result = await h.ops.restoreDirectory('foo', '2026-04-20T03-00-full', 'in_place');
    expect(result.ok).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe('foo/b.md');
    expect(result.failed[0]?.error).toMatch(/simulated failure/);
    // Writes were attempted on every file (loop didn't bail).
    const writes = h.vaultCalls.filter((c) => c.op === 'writeAtomic').map((c) => c.path);
    expect(writes).toEqual(expect.arrayContaining(['foo/a.md', 'foo/b.md', 'foo/sub/c.md']));
  });
});

// ---------------------------------------------------------------------------
// As-copy: shared batch timestamp prevents sibling-name collisions
// ---------------------------------------------------------------------------

describe('restoreDirectory — as-copy timestamp sharing', () => {
  it('all files in a batch share the same `.restored-<ts>.<ext>` suffix', async () => {
    let calls = 0;
    // Simulate Date.now ticking forward by 1ms each call — without batch
    // sharing, every file would get a different ts (which is fine), but we
    // want to prove the batch DOES share one ts.
    const h = makeHarness({
      now: (): number => {
        calls += 1;
        return new Date('2026-04-24T10:00:00Z').getTime() + calls;
      },
    });
    const result = await h.ops.restoreDirectory('foo', '2026-04-20T03-00-full', 'as_copy');
    expect(result.ok).toBe(3);
    const writes = h.vaultCalls.filter((c) => c.op === 'writeAtomic').map((c) => c.path);
    // Extract the timestamp portion of each copy path — must be identical.
    const tsPattern = /\.restored-([0-9TZ:.-]+)\./;
    const tsValues = new Set(writes.map((p) => p.match(tsPattern)?.[1]));
    expect(tsValues.size).toBe(1);
    // Confirm the ISO shape of the shared ts looks right.
    const ts = [...tsValues][0];
    expect(ts).toMatch(/^2026-04-24T10-00-00-\d+Z$/);
  });

  it('single-file restoreAsCopy is unaffected (still uses its own now())', async () => {
    const h = makeHarness({ now: () => new Date('2026-04-24T10:00:00Z').getTime() });
    const result = await h.ops.restoreAsCopy('foo/a.md', '2026-04-20T03-00-full');
    expect(result.path).toMatch(/^foo\/a\.restored-2026-04-24T10-00-00-000Z\.md$/);
  });
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

describe('restoreDirectory — logging', () => {
  it('emits dir_restore_started + dir_restore_done with counts', async () => {
    const h = makeHarness({ failPaths: new Set(['foo/b.md']) });
    await h.ops.restoreDirectory('foo', '2026-04-20T03-00-full', 'in_place');
    const infoCalls = (h.logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const started = infoCalls.find((c) => c[0] === 'dir_restore_started');
    const done = infoCalls.find((c) => c[0] === 'dir_restore_done');
    expect(started?.[1]).toMatchObject({ dir: 'foo', count: 3, mode: 'in_place' });
    expect(done?.[1]).toMatchObject({ dir: 'foo', ok: 2, failed: 1 });
  });
});
