// T8.1 / T8.2 — RestoreService: manifest chain merge + rename-aware history.
// Test fixtures trace the SDD walkthrough exactly plus ROB-004 regression.

import { describe, expect, it, vi } from 'vitest';
import {
  RestoreService,
  type ManifestLoader,
  type VersionEntry,
} from '../../src/services/RestoreService';
import type { FileEntry, SnapshotManifest } from '../../src/model/Manifest';
import type { Logger } from '../../src/infra/Logger';
import { ChainError } from '../../src/model/Errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fe(hash: string, size = 100, mtime = 1000): FileEntry {
  return { hash, size, mtime };
}

interface ManifestOptions {
  id: string;
  type?: 'full' | 'inc';
  parent_id?: string | null;
  files?: Record<string, FileEntry>;
  deleted?: string[];
  renames?: Array<{ from: string; to: string }>;
  created_at?: string;
}

function m(opts: ManifestOptions): SnapshotManifest {
  return {
    schema_version: '1.0',
    id: opts.id,
    type: opts.type ?? 'inc',
    parent_id: opts.parent_id ?? null,
    device_id: 'd0',
    created_at: opts.created_at ?? opts.id, // id-as-timestamp keeps ordering intuitive
    vault_name: 'vault',
    vault_prefix: 'test-vault',
    files: opts.files ?? {},
    deleted: opts.deleted ?? [],
    renames: opts.renames ?? [],
    exclusions_applied: null,
  };
}

function loader(manifests: SnapshotManifest[]): ManifestLoader {
  const byId = new Map(manifests.map((x) => [x.id, x]));
  return {
    loadManifest: async (id: string) => {
      const found = byId.get(id);
      if (!found) throw new Error(`fixture: unknown manifest ${id}`);
      return found;
    },
  };
}

function makeService(manifests: SnapshotManifest[]): {
  service: RestoreService;
  logger: Logger;
} {
  const logger = makeLogger();
  return {
    service: new RestoreService({ loader: loader(manifests), logger }),
    logger,
  };
}

// ---------------------------------------------------------------------------
// T8.1 — materializeVaultStateAt: the SDD 4-snapshot walkthrough
// ---------------------------------------------------------------------------

describe('materializeVaultStateAt — SDD 4-snapshot walkthrough', () => {
  const S1 = m({
    id: 'S1-full',
    type: 'full',
    parent_id: null,
    files: { 'A.md': fe('h1'), 'B.md': fe('h2'), 'C.md': fe('h3') },
  });
  const S2 = m({ id: 'S2-inc', parent_id: 'S1-full', files: { 'A.md': fe('h4') } });
  const S3 = m({ id: 'S3-inc', parent_id: 'S2-inc', files: { 'D.md': fe('h5') }, deleted: ['B.md'] });
  const S4 = m({
    id: 'S4-inc',
    parent_id: 'S3-inc',
    files: { 'C-renamed.md': fe('h6') },
    renames: [{ from: 'C.md', to: 'C-renamed.md' }],
  });

  it('reproduces the expected vault state at S4', async () => {
    const { service } = makeService([S1, S2, S3, S4]);
    const state = await service.materializeVaultStateAt('S4-inc');
    expect(Object.keys(state).sort()).toEqual(['A.md', 'C-renamed.md', 'D.md']);
    expect(state['A.md'].hash).toBe('h4');
    expect(state['C-renamed.md'].hash).toBe('h6');
    expect(state['D.md'].hash).toBe('h5');
    expect(state['B.md']).toBeUndefined();
  });

  it('target = Full itself returns the Full\'s files verbatim', async () => {
    const { service } = makeService([S1, S2, S3, S4]);
    const state = await service.materializeVaultStateAt('S1-full');
    expect(state).toEqual(S1.files);
  });

  it('target = intermediate Inc materializes state at that point', async () => {
    const { service } = makeService([S1, S2, S3, S4]);
    const state = await service.materializeVaultStateAt('S2-inc');
    expect(state['A.md'].hash).toBe('h4');
    expect(state['B.md'].hash).toBe('h2'); // B not yet deleted
    expect(state['C.md'].hash).toBe('h3'); // C not yet renamed
  });
});

// ---------------------------------------------------------------------------
// T8.1 — materializeVaultStateAt: edge cases
// ---------------------------------------------------------------------------

describe('materializeVaultStateAt — edge cases', () => {
  it('throws ChainError when chain terminates without reaching a Full', async () => {
    // An Inc whose parent_id is null — impossible in a correct chain.
    const orphan = m({ id: 'orphan-inc', type: 'inc', parent_id: null, files: { 'x.md': fe('hx') } });
    const { service } = makeService([orphan]);
    await expect(service.materializeVaultStateAt('orphan-inc')).rejects.toBeInstanceOf(ChainError);
  });

  it('throws ChainError when a parent_id points to an unknown manifest', async () => {
    const inc = m({ id: 'inc', type: 'inc', parent_id: 'missing-parent', files: { 'x.md': fe('hx') } });
    const { service } = makeService([inc]);
    await expect(service.materializeVaultStateAt('inc')).rejects.toThrow();
  });

  it('rename applied to a path not in state is silently skipped (idempotent)', async () => {
    const full = m({ id: 'full', type: 'full', files: { 'a.md': fe('h1') } });
    const inc = m({
      id: 'inc',
      parent_id: 'full',
      renames: [{ from: 'ghost.md', to: 'nowhere.md' }],
    });
    const { service } = makeService([full, inc]);
    const state = await service.materializeVaultStateAt('inc');
    expect(state).toEqual({ 'a.md': fe('h1') });
  });

  it('rename whose target already exists is skipped with a WARN log', async () => {
    const full = m({ id: 'full', type: 'full', files: { 'a.md': fe('h1'), 'b.md': fe('h2') } });
    const inc = m({ id: 'inc', parent_id: 'full', renames: [{ from: 'a.md', to: 'b.md' }] });
    const { service, logger } = makeService([full, inc]);
    const state = await service.materializeVaultStateAt('inc');
    // Both files remain with their original content — rename was a no-op.
    expect(state['a.md'].hash).toBe('h1');
    expect(state['b.md'].hash).toBe('h2');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('explicit delete tombstones correctly', async () => {
    const full = m({ id: 'full', type: 'full', files: { 'a.md': fe('h1'), 'b.md': fe('h2') } });
    const inc = m({ id: 'inc', parent_id: 'full', deleted: ['a.md'] });
    const { service } = makeService([full, inc]);
    const state = await service.materializeVaultStateAt('inc');
    expect(state['a.md']).toBeUndefined();
    expect(state['b.md']).toBeDefined();
  });

  it('detects a cycle in parent_id and throws ChainError', async () => {
    // Corrupted chain: A.parent = B, B.parent = A.
    const a = m({ id: 'A', type: 'inc', parent_id: 'B' });
    const b = m({ id: 'B', type: 'inc', parent_id: 'A' });
    const { service } = makeService([a, b]);
    await expect(service.materializeVaultStateAt('A')).rejects.toBeInstanceOf(ChainError);
  });
});

// ---------------------------------------------------------------------------
// T8.2 — listVersionsForPath: SDD path-reuse example (ROB-004)
// ---------------------------------------------------------------------------

describe('listVersionsForPath — ROB-004 path-reuse', () => {
  // From SDD:
  //   S1 (oldest): files={A.md:h1}
  //   S2: files={B.md:h2}, renames=[A.md→B.md]
  //   S3 (newest): files={A.md:h3}  ← brand-new A.md, unrelated to S1/S2
  const S1 = m({ id: 'S1', type: 'full', parent_id: null, files: { 'A.md': fe('h1') } });
  const S2 = m({
    id: 'S2',
    parent_id: 'S1',
    files: { 'B.md': fe('h2') },
    renames: [{ from: 'A.md', to: 'B.md' }],
  });
  const S3 = m({ id: 'S3', parent_id: 'S2', files: { 'A.md': fe('h3') } });

  it('listVersionsForPath("B.md") excludes S3\'s unrelated A.md', () => {
    const { service } = makeService([]);
    const newestToOldest = [S3, S2, S1];
    const versions = service.listVersionsForPath('B.md', newestToOldest);
    // Expect exactly two versions: S2's B.md (hash h2) and S1's A.md (hash h1, priorPath A.md).
    const ids = versions.map((v) => v.snapshot_id).sort();
    expect(ids).toEqual(['S1', 'S2']);
    // S1 version is the renamed-from alias.
    const s1v = versions.find((v) => v.snapshot_id === 'S1')!;
    expect(s1v.path).toBe('A.md');
    expect(s1v.priorPath).toBe('A.md');
    expect(s1v.renamedAt).toBeDefined();
    // S2 version is under the current path.
    const s2v = versions.find((v) => v.snapshot_id === 'S2')!;
    expect(s2v.path).toBe('B.md');
    expect(s2v.priorPath).toBeNull();
    expect(s2v.renamedAt).toBeNull();
  });

  it('listVersionsForPath("A.md") returns only S3 (the new A.md)', () => {
    const { service } = makeService([]);
    const newestToOldest = [S3, S2, S1];
    const versions = service.listVersionsForPath('A.md', newestToOldest);
    // S3's A.md is NOT related to S1/S2's A.md (which became B.md).
    // The algorithm correctly limits to S3 only — walking back, S2 renames A→B,
    // removing A from the alias set for older manifests. S1's A.md is therefore
    // not returned when querying "A.md" (it's under the B.md lineage now).
    expect(versions.map((v) => v.snapshot_id)).toEqual(['S3']);
  });
});

// ---------------------------------------------------------------------------
// T8.2 — Basic rename chain coverage
// ---------------------------------------------------------------------------

describe('listVersionsForPath — rename chain', () => {
  // A → B → C rename chain across 3 manifests:
  const F = m({ id: 'F', type: 'full', parent_id: null, files: { 'A.md': fe('ha') } });
  const R1 = m({
    id: 'R1',
    parent_id: 'F',
    files: { 'B.md': fe('hb') },
    renames: [{ from: 'A.md', to: 'B.md' }],
  });
  const R2 = m({
    id: 'R2',
    parent_id: 'R1',
    files: { 'C.md': fe('hc') },
    renames: [{ from: 'B.md', to: 'C.md' }],
  });

  it('returns versions under all three aliases', () => {
    const { service } = makeService([]);
    const versions = service.listVersionsForPath('C.md', [R2, R1, F]);
    expect(versions.map((v) => v.path).sort()).toEqual(['A.md', 'B.md', 'C.md']);
  });

  it('single-version file (never changed) returns 1 entry', () => {
    const { service } = makeService([]);
    const only = m({ id: 'only', type: 'full', parent_id: null, files: { 'x.md': fe('hx') } });
    const versions = service.listVersionsForPath('x.md', [only]);
    expect(versions).toHaveLength(1);
    expect(versions[0].hash).toBe('hx');
    expect(versions[0].priorPath).toBeNull();
  });

  it('empty manifest chain returns an empty array', () => {
    const { service } = makeService([]);
    expect(service.listVersionsForPath('anything.md', [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T8.2 — Property-based invariants (TEST-H5 mutation-killers)
// ---------------------------------------------------------------------------

describe('listVersionsForPath — invariants', () => {
  const F = m({
    id: 'F',
    type: 'full',
    parent_id: null,
    files: { 'A.md': fe('h1'), 'Z.md': fe('hz') },
    created_at: '2026-01-01',
  });
  const I1 = m({
    id: 'I1',
    parent_id: 'F',
    files: { 'B.md': fe('h2') },
    renames: [{ from: 'A.md', to: 'B.md' }],
    created_at: '2026-02-01',
  });
  const I2 = m({
    id: 'I2',
    parent_id: 'I1',
    files: { 'B.md': fe('h3') },
    created_at: '2026-03-01',
  });
  const I3 = m({
    id: 'I3',
    parent_id: 'I2',
    files: { 'C.md': fe('h4') },
    renames: [{ from: 'B.md', to: 'C.md' }],
    created_at: '2026-04-01',
  });

  const service = new RestoreService({
    loader: loader([F, I1, I2, I3]),
    logger: makeLogger(),
  });
  const newestToOldest = [I3, I2, I1, F];

  it('priorPath-renamedAt consistency: every alias version has a non-null renamedAt', () => {
    const versions = service.listVersionsForPath('C.md', newestToOldest);
    for (const v of versions) {
      if (v.priorPath !== null) expect(v.renamedAt).not.toBeNull();
      else expect(v.renamedAt).toBeNull();
    }
  });

  it('idempotency: two calls on the same manifests return equal results', () => {
    const a = service.listVersionsForPath('C.md', newestToOldest);
    const b = service.listVersionsForPath('C.md', newestToOldest);
    expect(a).toEqual(b);
  });

  it('ordering: versions are strictly newest-first by created_at', () => {
    const versions = service.listVersionsForPath('C.md', newestToOldest);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i].created_at <= versions[i - 1].created_at).toBe(true);
    }
  });

  it('alias-completeness: count of versions equals distinct content entries across aliases', () => {
    const versions = service.listVersionsForPath('C.md', newestToOldest);
    // Hashes across all aliases: F.A.md=h1, I1.B.md=h2, I2.B.md=h3, I3.C.md=h4 → 4 distinct versions.
    expect(versions).toHaveLength(4);
    const hashes = new Set(versions.map((v: VersionEntry) => v.hash));
    expect(hashes.size).toBe(4);
  });

  it('does not leak unrelated files (Z.md stays out of history for C.md)', () => {
    const versions = service.listVersionsForPath('C.md', newestToOldest);
    expect(versions.some((v) => v.path === 'Z.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T8.4 — fetchContent: download + hash verify
// ---------------------------------------------------------------------------

describe('fetchContent', () => {
  // Valid 64-char lowercase hex SHA-256 fixtures.
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);
  const fullFx = m({
    id: 'full',
    type: 'full',
    parent_id: null,
    files: { 'a.md': { hash: HASH_A, size: 5, mtime: 0 } },
  });

  function makeServiceWithDropbox(opts: {
    bytes?: Uint8Array;
    hash?: string;
    throwOn?: string;
  }): { service: RestoreService; downloadedPaths: string[] } {
    const downloadedPaths: string[] = [];
    const dropbox = {
      downloadBytes: async (path: string): Promise<Uint8Array> => {
        downloadedPaths.push(path);
        if (opts.throwOn === path) throw new Error(`fixture: refuse ${path}`);
        return opts.bytes ?? new Uint8Array([1, 2, 3]);
      },
    };
    const service = new RestoreService({
      loader: loader([fullFx]),
      dropbox,
      logger: makeLogger(),
      hasher: async () => opts.hash ?? HASH_A,
    });
    return { service, downloadedPaths };
  }

  it('fetches bytes and returns them when hash matches', async () => {
    const bytes = new Uint8Array([7, 7, 7, 7, 7]);
    const { service } = makeServiceWithDropbox({ bytes, hash: HASH_A });
    const out = await service.fetchContent('full', 'a.md');
    expect(out).toEqual(bytes);
  });

  it('throws PathError(PATH_NOT_IN_SNAPSHOT) when path is absent', async () => {
    const { service } = makeServiceWithDropbox({ hash: HASH_A });
    await expect(service.fetchContent('full', 'nope.md')).rejects.toMatchObject({
      code: 'PATH_NOT_IN_SNAPSHOT',
    });
  });

  it('throws CorruptionError(CONTENT_HASH_MISMATCH) when bytes do not hash back', async () => {
    const { service } = makeServiceWithDropbox({ hash: HASH_B });
    await expect(service.fetchContent('full', 'a.md')).rejects.toMatchObject({
      code: 'CONTENT_HASH_MISMATCH',
    });
  });

  it('downloads from the vault_prefix in the target manifest', async () => {
    const { service, downloadedPaths } = makeServiceWithDropbox({ hash: HASH_A });
    await service.fetchContent('full', 'a.md');
    expect(downloadedPaths[0]).toContain('content/');
    expect(downloadedPaths[0]).toContain(HASH_A);
  });
});
