// T8.5 — Standalone Restore CLI algorithm tests (import-based).
//
// Note: the plan calls for subprocess-based tests under tests/cli/ (excluded
// from the main vitest run). Those are implemented separately as a CI step
// (Phase 10 `cli-parity.test.ts` validates byte-identical output against the
// in-plugin restore). Here we exercise the CLI's pure functions directly to
// cover the algorithm without subprocess overhead.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error — JS module, no type declarations
import {
  parseArgs,
  sha256Hex,
  loadIndex,
  loadHead,
  loadManifest,
  resolveSnapshotId,
  loadChainToFull,
  mergeChain,
  materializeState,
  fetchBlob,
  verifyBlob,
  reconstruct,
  listSnapshots,
  main,
} from '../../scripts/restore.mjs';

// ---------------------------------------------------------------------------
// Fixture-dir helpers
// ---------------------------------------------------------------------------

interface FileSpec {
  path: string;
  content: string;
}

interface SnapshotSpec {
  id: string;
  type: 'full' | 'inc';
  parent_id: string | null;
  created_at: string;
  files: FileSpec[];
  deleted?: string[];
  renames?: Array<{ from: string; to: string }>;
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function writeFixture(
  root: string,
  snapshots: SnapshotSpec[],
  opts: { head?: string | null; corrupt?: string } = {},
): Promise<void> {
  await mkdir(join(root, 'snapshots'), { recursive: true });
  await mkdir(join(root, 'content'), { recursive: true });

  // Collect all file contents + hashes across the chain.
  const hashBytes = new Map<string, string>();
  for (const s of snapshots) {
    for (const f of s.files) {
      hashBytes.set(sha(f.content), f.content);
    }
  }

  // Write content blobs.
  for (const [hash, content] of hashBytes) {
    const bucket = hash.slice(0, 2);
    await mkdir(join(root, 'content', bucket), { recursive: true });
    const target = join(root, 'content', bucket, hash);
    if (opts.corrupt === hash) {
      await writeFile(target, 'CORRUPTED');
    } else {
      await writeFile(target, content);
    }
  }

  // Write manifest JSONs.
  for (const s of snapshots) {
    const manifest = {
      schema_version: '1.0',
      id: s.id,
      type: s.type,
      parent_id: s.parent_id,
      device_id: 'd0',
      created_at: s.created_at,
      vault_name: 'vault',
      vault_prefix: 'test-vault',
      files: Object.fromEntries(
        s.files.map((f) => [
          f.path,
          { hash: sha(f.content), size: Buffer.byteLength(f.content), mtime: 1000 },
        ]),
      ),
      deleted: s.deleted ?? [],
      renames: s.renames ?? [],
      exclusions_applied: null,
    };
    await writeFile(join(root, 'snapshots', `${s.id}.json`), JSON.stringify(manifest));
  }

  // Write snapshot_index.json.
  const indexDoc = {
    schema_version: '1.0',
    last_updated_at: '2026-04-24T00:00:00.000Z',
    snapshots: snapshots.map((s) => ({
      id: s.id,
      type: s.type,
      parent_id: s.parent_id,
      created_at: s.created_at,
      device_id: 'd0',
      blob_hashes: s.files.map((f) => sha(f.content)),
    })),
  };
  await writeFile(join(root, 'snapshot_index.json'), JSON.stringify(indexDoc));

  // Write HEAD.json unless opts.head === null (simulate missing HEAD).
  if (opts.head !== null) {
    const headId = opts.head ?? snapshots[snapshots.length - 1]?.id;
    if (headId) {
      const headDoc = {
        schema_version: '1.0',
        snapshot_id: headId,
        snapshot_type: snapshots.find((s) => s.id === headId)?.type ?? 'full',
        device_id: 'd0',
        committed_at: snapshots[snapshots.length - 1].created_at,
      };
      await writeFile(join(root, 'HEAD.json'), JSON.stringify(headDoc));
    }
  }
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses --input + --output + --at', () => {
    const opts = parseArgs(['--input', '/a', '--output', '/b', '--at', 'latest']);
    expect(opts.input).toBe('/a');
    expect(opts.output).toBe('/b');
    expect(opts.at).toBe('latest');
  });

  it('parses boolean flags', () => {
    const opts = parseArgs(['--list-snapshots', '--dry-run', '--verify-only']);
    expect(opts.listSnapshots).toBe(true);
    expect(opts.dryRun).toBe(true);
    expect(opts.verifyOnly).toBe(true);
  });

  it('throws on unknown arg', () => {
    expect(() => parseArgs(['--something-weird'])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// sha256Hex
// ---------------------------------------------------------------------------

describe('sha256Hex', () => {
  it('matches Node createHash', () => {
    expect(sha256Hex(Buffer.from('hello'))).toBe(
      createHash('sha256').update('hello').digest('hex'),
    );
  });
});

// ---------------------------------------------------------------------------
// resolveSnapshotId
// ---------------------------------------------------------------------------

describe('resolveSnapshotId', () => {
  const entries = [
    { id: '2026-04-10T03-00-full', type: 'full', parent_id: null, created_at: '2026-04-10T03:00:00.000Z' },
    { id: '2026-04-20T03-00-full', type: 'full', parent_id: null, created_at: '2026-04-20T03:00:00.000Z' },
    { id: '2026-04-20T09-00-inc', type: 'inc', parent_id: '2026-04-20T03-00-full', created_at: '2026-04-20T09:00:00.000Z' },
  ];

  it('latest with HEAD id returns HEAD', () => {
    expect(resolveSnapshotId(entries, 'latest', '2026-04-20T09-00-inc')).toBe('2026-04-20T09-00-inc');
  });

  it('latest without HEAD falls back to newest-by-created_at', () => {
    expect(resolveSnapshotId(entries, 'latest', null)).toBe('2026-04-20T09-00-inc');
  });

  it('exact id matches', () => {
    expect(resolveSnapshotId(entries, '2026-04-20T03-00-full', null)).toBe('2026-04-20T03-00-full');
  });

  it('date prefix picks latest on date', () => {
    expect(resolveSnapshotId(entries, '2026-04-20', null)).toBe('2026-04-20T09-00-inc');
  });

  it('date with no matches throws NO_SNAPSHOT_ON_DATE', () => {
    expect(() => resolveSnapshotId(entries, '2025-01-01', null)).toThrow(/NO_SNAPSHOT_ON_DATE/);
  });

  it('unique partial id matches', () => {
    // '09-00' only appears in the inc snapshot.
    expect(resolveSnapshotId(entries, '09-00', null)).toBe('2026-04-20T09-00-inc');
  });

  it('ambiguous partial id throws AMBIGUOUS_SNAPSHOT', () => {
    // '04-20' appears in two snapshots.
    expect(() => resolveSnapshotId(entries, '04-20', null)).toThrow(/AMBIGUOUS/);
  });

  it('unknown selector throws UNKNOWN_SNAPSHOT', () => {
    expect(() => resolveSnapshotId(entries, 'does-not-exist', null)).toThrow(/UNKNOWN/);
  });
});

// ---------------------------------------------------------------------------
// mergeChain — replay against the SDD walkthrough
// ---------------------------------------------------------------------------

describe('mergeChain — SDD 4-snapshot walkthrough', () => {
  it('produces {A.md=h4, C-renamed.md=h6, D.md=h5} at S4', async () => {
    const S1 = {
      schema_version: '1.0',
      id: 'S1',
      type: 'full',
      parent_id: null,
      files: { 'A.md': { hash: 'h1', size: 1, mtime: 0 }, 'B.md': { hash: 'h2', size: 1, mtime: 0 }, 'C.md': { hash: 'h3', size: 1, mtime: 0 } },
      deleted: [],
      renames: [],
    };
    const S2 = { ...S1, id: 'S2', type: 'inc', parent_id: 'S1', files: { 'A.md': { hash: 'h4', size: 1, mtime: 0 } } };
    const S3 = { ...S1, id: 'S3', type: 'inc', parent_id: 'S2', files: { 'D.md': { hash: 'h5', size: 1, mtime: 0 } }, deleted: ['B.md'] };
    const S4 = { ...S1, id: 'S4', type: 'inc', parent_id: 'S3', files: { 'C-renamed.md': { hash: 'h6', size: 1, mtime: 0 } }, renames: [{ from: 'C.md', to: 'C-renamed.md' }] };
    const chain = [S4, S3, S2, S1]; // newest→oldest
    const state = mergeChain(chain);
    expect(Object.keys(state).sort()).toEqual(['A.md', 'C-renamed.md', 'D.md']);
    expect(state['A.md'].hash).toBe('h4');
    expect(state['C-renamed.md'].hash).toBe('h6');
    expect(state['D.md'].hash).toBe('h5');
  });
});

// ---------------------------------------------------------------------------
// End-to-end fixture tests
// ---------------------------------------------------------------------------

describe('CLI end-to-end (fixture dirs)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'archivist-cli-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makeChain(corrupt?: string): Promise<void> {
    await writeFixture(
      root,
      [
        {
          id: '2026-04-10T03-00-full',
          type: 'full',
          parent_id: null,
          created_at: '2026-04-10T03:00:00.000Z',
          files: [
            { path: 'A.md', content: 'apples' },
            { path: 'B.md', content: 'bananas' },
          ],
        },
        {
          id: '2026-04-20T03-00-inc',
          type: 'inc',
          parent_id: '2026-04-10T03-00-full',
          created_at: '2026-04-20T03:00:00.000Z',
          files: [{ path: 'A.md', content: 'avocados' }],
          deleted: ['B.md'],
        },
        {
          id: '2026-04-22T03-00-inc',
          type: 'inc',
          parent_id: '2026-04-20T03-00-inc',
          created_at: '2026-04-22T03:00:00.000Z',
          files: [{ path: 'C.md', content: 'cherries' }],
        },
      ],
      corrupt !== undefined ? { corrupt } : {},
    );
  }

  it('listSnapshots returns newest-first', async () => {
    await makeChain();
    const list = await listSnapshots(root);
    expect(list.map((s: { id: string }) => s.id)).toEqual([
      '2026-04-22T03-00-inc',
      '2026-04-20T03-00-inc',
      '2026-04-10T03-00-full',
    ]);
  });

  it('materializeState at latest gives the final tree', async () => {
    await makeChain();
    const state = await materializeState(root, '2026-04-22T03-00-inc');
    expect(Object.keys(state).sort()).toEqual(['A.md', 'C.md']);
    // A.md was overwritten in S2; B.md was deleted; C.md added in S3.
  });

  it('fetchBlob returns bytes when hash matches', async () => {
    await makeChain();
    const bytes = await fetchBlob(root, sha('apples'));
    expect(Buffer.from(bytes).toString()).toBe('apples');
  });

  it('fetchBlob throws CONTENT_HASH_MISMATCH on corrupt blob', async () => {
    await makeChain(sha('avocados'));
    await expect(fetchBlob(root, sha('avocados'))).rejects.toThrow(/CONTENT_HASH_MISMATCH/);
  });

  it('verifyBlob reports failure instead of throwing', async () => {
    await makeChain(sha('avocados'));
    const r = await verifyBlob(root, sha('avocados'));
    expect(r.ok).toBe(false);
  });

  it('reconstruct --dry-run returns a plan without writing', async () => {
    await makeChain();
    const state = await materializeState(root, '2026-04-22T03-00-inc');
    const r = await reconstruct(root, state, null, { dryRun: true });
    expect(r.plan.map((p: { path: string }) => p.path).sort()).toEqual(['A.md', 'C.md']);
  });

  it('reconstruct --verify-only scans blobs; reports failures', async () => {
    await makeChain(sha('avocados'));
    const state = await materializeState(root, '2026-04-22T03-00-inc');
    const r = await reconstruct(root, state, null, { verifyOnly: true });
    expect(r.failures.length).toBeGreaterThan(0);
  });

  it('reconstruct writes the expected tree with atomic-dir pattern', async () => {
    await makeChain();
    const output = join(root, 'out');
    const state = await materializeState(root, '2026-04-22T03-00-inc');
    await reconstruct(root, state, output, {});
    // Tmp dir should be renamed to output; verify files.
    const a = await readFile(join(output, 'A.md'), 'utf8');
    const c = await readFile(join(output, 'C.md'), 'utf8');
    expect(a).toBe('avocados');
    expect(c).toBe('cherries');
    // No B.md (deleted).
    await expect(stat(join(output, 'B.md'))).rejects.toThrow();
  });

  it('reconstruct cleans up tmp dir if a blob is corrupt mid-restore', async () => {
    await makeChain(sha('cherries'));
    const output = join(root, 'out2');
    const state = await materializeState(root, '2026-04-22T03-00-inc');
    await expect(reconstruct(root, state, output, {})).rejects.toThrow(/CONTENT_HASH_MISMATCH/);
    // Output dir not created (tmp renamed away only on success).
    await expect(stat(output)).rejects.toThrow();
    // Tmp dir cleaned.
    await expect(stat(`${output}.tmp`)).rejects.toThrow();
  });

  it('loadChainToFull surfaces CHAIN_BROKEN on missing parent', async () => {
    // Write an orphan inc manifest with no parent on disk.
    await writeFixture(root, [
      {
        id: '2026-04-10T03-00-full',
        type: 'full',
        parent_id: null,
        created_at: '2026-04-10T03:00:00.000Z',
        files: [{ path: 'A.md', content: 'a' }],
      },
    ]);
    // Hand-craft a manifest file that references a non-existent parent.
    const orphan = {
      schema_version: '1.0',
      id: '2026-04-11T03-00-inc',
      type: 'inc',
      parent_id: 'does-not-exist',
      device_id: 'd0',
      created_at: '2026-04-11T03:00:00.000Z',
      vault_name: 'vault',
      vault_prefix: 'test-vault',
      files: {},
      deleted: [],
      renames: [],
      exclusions_applied: null,
    };
    await writeFile(join(root, 'snapshots', '2026-04-11T03-00-inc.json'), JSON.stringify(orphan));
    await expect(loadChainToFull(root, '2026-04-11T03-00-inc')).rejects.toThrow(/CHAIN_BROKEN/);
  });
});

// ---------------------------------------------------------------------------
// main() — integration pass with captured IO
// ---------------------------------------------------------------------------

describe('main() — integration', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'archivist-cli-main-'));
    await writeFixture(root, [
      {
        id: '2026-04-10T03-00-full',
        type: 'full',
        parent_id: null,
        created_at: '2026-04-10T03:00:00.000Z',
        files: [{ path: 'A.md', content: 'a' }],
      },
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function captureIo(): {
    io: { stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } };
    stdout: string[];
    stderr: string[];
  } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      io: {
        stdout: { write: (s: string) => stdout.push(s) },
        stderr: { write: (s: string) => stderr.push(s) },
      },
      stdout,
      stderr,
    };
  }

  it('--list-snapshots prints entries and exits 0', async () => {
    const cap = captureIo();
    const code = await main(['node', 'restore.mjs', '--input', root, '--list-snapshots'], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.join('')).toContain('2026-04-10T03-00-full');
  });

  it('--at latest --output OUT restores to OUT and exits 0', async () => {
    const cap = captureIo();
    const out = join(root, 'restored');
    const code = await main(
      ['node', 'restore.mjs', '--input', root, '--at', 'latest', '--output', out],
      cap.io,
    );
    expect(code).toBe(0);
    expect(await readFile(join(out, 'A.md'), 'utf8')).toBe('a');
  });

  it('missing --input exits 2 with an error message', async () => {
    const cap = captureIo();
    const code = await main(['node', 'restore.mjs', '--list-snapshots'], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.join('')).toContain('--input');
  });

  it('--dry-run prints a plan without writing', async () => {
    const cap = captureIo();
    const code = await main(
      ['node', 'restore.mjs', '--input', root, '--at', 'latest', '--dry-run'],
      cap.io,
    );
    expect(code).toBe(0);
    expect(cap.stdout.join('')).toContain('Would write');
  });

  it('--verify-only exits 0 on a clean chain', async () => {
    const cap = captureIo();
    const code = await main(['node', 'restore.mjs', '--input', root, '--verify-only'], cap.io);
    expect(code).toBe(0);
  });

  it('missing HEAD.json produces a WARN but still restores', async () => {
    // Remove HEAD.json and re-run.
    await rm(join(root, 'HEAD.json'));
    const cap = captureIo();
    const out = join(root, 'restored');
    const code = await main(
      ['node', 'restore.mjs', '--input', root, '--at', 'latest', '--output', out],
      cap.io,
    );
    expect(code).toBe(0);
    expect(cap.stderr.join('')).toContain('HEAD.json missing');
  });
});

// ---------------------------------------------------------------------------
// Zero-dep invariant (grep-based)
// ---------------------------------------------------------------------------

describe('zero-dep invariant', () => {
  it('scripts/restore.mjs imports only from node: built-ins', async () => {
    const src = await readFile(
      new URL('../../scripts/restore.mjs', import.meta.url),
      'utf8',
    );
    const importLines = src.match(/^import[^;]+;/gm) ?? [];
    for (const line of importLines) {
      const fromMatch = /from\s+['"]([^'"]+)['"]/.exec(line);
      if (!fromMatch) continue;
      const specifier = fromMatch[1];
      expect(specifier.startsWith('node:')).toBe(true);
    }
  });
});

// Touch `loadHead`, `loadManifest`, `loadIndex` as imports to silence
// unused-import noise — they're part of the public module surface even when
// the fixture-based tests above use them transitively via materializeState.
void loadHead;
void loadManifest;
void loadIndex;
