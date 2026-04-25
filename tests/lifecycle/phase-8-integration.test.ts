// T8.6 — Phase 8 integration: 4-week synthetic history with renames +
// deletes, driven through listVersionsForPath + fetchContent + restore
// end-to-end.
//
// Also runs the CLI reconstruction against the same on-disk fixture and
// compares the result to what the in-plugin restore produces (subset of
// the Phase 10 `cli-parity.test.ts` contract).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RestoreService, type ManifestLoader } from '../../src/services/RestoreService';
import { RestoreOperations } from '../../src/services/RestoreOperations';
import { ManifestCache } from '../../src/services/ManifestCache';
import type { SnapshotManifest } from '../../src/model/Manifest';
import type { VaultAdapter } from '../../src/infra/VaultAdapter';
import type { Logger } from '../../src/infra/Logger';

// @ts-expect-error — JS module, no type declarations
import { materializeState as cliMaterializeState, reconstruct as cliReconstruct } from '../../scripts/restore.mjs';

// ---------------------------------------------------------------------------
// Synthetic history generator
// ---------------------------------------------------------------------------

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface StepSpec {
  id: string;
  type: 'full' | 'inc';
  created_at: string;
  writes?: Array<{ path: string; content: string }>;
  deleted?: string[];
  renames?: Array<{ from: string; to: string }>;
}

interface HistoryFixture {
  manifests: SnapshotManifest[];
  manifestsById: Map<string, SnapshotManifest>;
  contentsByHash: Map<string, string>;
  /** The final state — what the latest snapshot should materialize to. */
  expectedLatest: Record<string, string>;
}

/**
 * Build a 4-week synthetic history. Each step is an incremental (or the
 * initial full). Mix of creates, modifies, deletes, and renames.
 */
function buildHistory(): HistoryFixture {
  const steps: StepSpec[] = [
    // Week 1 — initial Full
    {
      id: '2026-04-01T03-00-full',
      type: 'full',
      created_at: '2026-04-01T03:00:00.000Z',
      writes: [
        { path: 'journal/2026-04-01.md', content: 'day 1 entry' },
        { path: 'projects/launch.md', content: 'launch v1' },
        { path: 'ideas/inbox.md', content: 'raw thoughts' },
        { path: 'references/style.md', content: 'writing style guide' },
        { path: 'README.md', content: 'vault overview' },
      ],
    },
    // Week 1 — inc with modify + new file
    {
      id: '2026-04-03T03-00-inc',
      type: 'inc',
      created_at: '2026-04-03T03:00:00.000Z',
      writes: [
        { path: 'journal/2026-04-01.md', content: 'day 1 entry + edit' },
        { path: 'ideas/project-x.md', content: 'new project sketch' },
      ],
    },
    // Week 2 — rename ideas/inbox → ideas/inbox-archive
    {
      id: '2026-04-08T03-00-inc',
      type: 'inc',
      created_at: '2026-04-08T03:00:00.000Z',
      renames: [{ from: 'ideas/inbox.md', to: 'ideas/inbox-archive.md' }],
      writes: [
        { path: 'ideas/inbox.md', content: 'fresh inbox' }, // path reused!
        { path: 'journal/2026-04-08.md', content: 'day 8' },
      ],
    },
    // Week 2 — delete launch + modify inbox
    {
      id: '2026-04-10T03-00-inc',
      type: 'inc',
      created_at: '2026-04-10T03:00:00.000Z',
      deleted: ['projects/launch.md'],
      writes: [{ path: 'ideas/inbox.md', content: 'inbox v2' }],
    },
    // Week 3 — another Full (acts as new baseline)
    {
      id: '2026-04-15T03-00-full',
      type: 'full',
      created_at: '2026-04-15T03:00:00.000Z',
      // Full re-lists the current state. Compute from prior chain below.
    },
    // Week 4 — final inc with rename chain
    {
      id: '2026-04-22T03-00-inc',
      type: 'inc',
      created_at: '2026-04-22T03:00:00.000Z',
      renames: [{ from: 'references/style.md', to: 'references/style-guide.md' }],
      writes: [{ path: 'references/style-guide.md', content: 'style guide v2' }],
    },
  ];

  // Replay to compute the expected latest state AND populate each Full's files.
  const manifests: SnapshotManifest[] = [];
  const contentsByHash = new Map<string, string>();
  let state: Record<string, { hash: string; size: number; mtime: number }> = {};
  let lastId: string | null = null;

  for (const step of steps) {
    const fileEntries: Record<string, { hash: string; size: number; mtime: number }> = {};

    if (step.type === 'full' && step.id !== '2026-04-01T03-00-full') {
      // Re-bake the full from current state: every file is re-listed as a full snapshot entry.
      for (const [p, e] of Object.entries(state)) fileEntries[p] = e;
    }

    // Apply renames first (shift existing entries, do NOT add to fileEntries).
    for (const { from, to } of step.renames ?? []) {
      if (!state[from] || state[to]) continue;
      state[to] = state[from];
      delete state[from];
    }

    // Apply writes → they produce FileEntry rows in the manifest AND update state.
    for (const { path, content } of step.writes ?? []) {
      const hash = sha(content);
      contentsByHash.set(hash, content);
      const entry = { hash, size: Buffer.byteLength(content), mtime: 1000 };
      fileEntries[path] = entry;
      state[path] = entry;
    }

    // Apply deletes → tombstone in manifest + remove from state.
    for (const p of step.deleted ?? []) {
      delete state[p];
    }

    manifests.push({
      schema_version: '1.0',
      id: step.id,
      type: step.type,
      parent_id: lastId,
      device_id: 'd0',
      created_at: step.created_at,
      vault_name: 'vault',
      vault_prefix: 'test-vault',
      files: fileEntries,
      deleted: step.deleted ?? [],
      renames: step.renames ?? [],
      exclusions_applied: null,
    });

    // The new Full starts its own chain — its parent_id is null.
    if (step.type === 'full' && step.id !== '2026-04-01T03-00-full') {
      manifests[manifests.length - 1].parent_id = null;
    }

    lastId = step.id;
  }

  const expectedLatest: Record<string, string> = {};
  for (const [p, e] of Object.entries(state)) {
    expectedLatest[p] = contentsByHash.get(e.hash)!;
  }

  return {
    manifests,
    manifestsById: new Map(manifests.map((m) => [m.id, m])),
    contentsByHash,
    expectedLatest,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fixtureLoader(fx: HistoryFixture): ManifestLoader {
  return {
    loadManifest: async (id: string) => {
      const found = fx.manifestsById.get(id);
      if (!found) throw new Error(`fixture: unknown manifest ${id}`);
      return found;
    },
  };
}

function fixtureDropbox(fx: HistoryFixture): { downloadBytes: (p: string) => Promise<Uint8Array> } {
  return {
    downloadBytes: async (path: string): Promise<Uint8Array> => {
      // path layout: test-vault/content/<bucket>/<hash>
      const match = /content\/[0-9a-f]{2}\/([0-9a-f]{64})$/.exec(path);
      if (!match) throw new Error(`fixture: bad content path ${path}`);
      const hash = match[1];
      const content = fx.contentsByHash.get(hash);
      if (content === undefined) throw new Error(`fixture: unknown blob ${hash}`);
      return new TextEncoder().encode(content);
    },
  };
}

/** Writes a HistoryFixture to disk as a Dropbox-mirrored folder. */
async function writeFixtureToDisk(fx: HistoryFixture, root: string): Promise<void> {
  await mkdir(join(root, 'snapshots'), { recursive: true });
  for (const m of fx.manifests) {
    await writeFile(join(root, 'snapshots', `${m.id}.json`), JSON.stringify(m));
  }
  for (const [hash, content] of fx.contentsByHash) {
    const bucket = hash.slice(0, 2);
    await mkdir(join(root, 'content', bucket), { recursive: true });
    await writeFile(join(root, 'content', bucket, hash), content);
  }
  const indexDoc = {
    schema_version: '1.0',
    last_updated_at: fx.manifests[fx.manifests.length - 1].created_at,
    snapshots: fx.manifests.map((m) => ({
      id: m.id,
      type: m.type,
      parent_id: m.parent_id,
      created_at: m.created_at,
      device_id: m.device_id,
      blob_hashes: Object.values(m.files).map((e) => e.hash),
    })),
  };
  await writeFile(join(root, 'snapshot_index.json'), JSON.stringify(indexDoc));

  const head = fx.manifests[fx.manifests.length - 1];
  await writeFile(
    join(root, 'HEAD.json'),
    JSON.stringify({
      schema_version: '1.0',
      snapshot_id: head.id,
      snapshot_type: head.type,
      device_id: head.device_id,
      committed_at: head.created_at,
    }),
  );
}

// ---------------------------------------------------------------------------
// Fake VaultAdapter collecting atomic writes
// ---------------------------------------------------------------------------

function makeFakeVault(): {
  vault: VaultAdapter;
  written: Map<string, Uint8Array>;
} {
  const written = new Map<string, Uint8Array>();
  const vault = {
    mkdirParents: async (_path: string): Promise<void> => {},
    writeAtomic: async (path: string, bytes: Uint8Array): Promise<void> => {
      written.set(path, bytes);
    },
  } as unknown as VaultAdapter;
  return { vault, written };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase 8 integration — 4-week synthetic history', () => {
  let fx: HistoryFixture;
  let service: RestoreService;

  beforeEach(() => {
    fx = buildHistory();
    service = new RestoreService({
      loader: fixtureLoader(fx),
      dropbox: fixtureDropbox(fx),
      logger: makeLogger(),
    });
  });

  it('materializeVaultStateAt(HEAD) reproduces the expected final state', async () => {
    const head = fx.manifests[fx.manifests.length - 1].id;
    const state = await service.materializeVaultStateAt(head);
    expect(Object.keys(state).sort()).toEqual(Object.keys(fx.expectedLatest).sort());
  });

  it('fetchContent returns the expected bytes for every file at HEAD', async () => {
    const head = fx.manifests[fx.manifests.length - 1].id;
    const state = await service.materializeVaultStateAt(head);
    for (const path of Object.keys(state)) {
      const bytes = await service.fetchContent(head, path);
      const text = new TextDecoder().decode(bytes);
      expect(text).toBe(fx.expectedLatest[path]);
    }
  });

  it('listVersionsForPath("references/style-guide.md") traces the rename chain', () => {
    // The file was once references/style.md, renamed in the last inc.
    const newestToOldest = fx.manifests.slice().reverse();
    const versions = service.listVersionsForPath('references/style-guide.md', newestToOldest);
    const paths = versions.map((v) => v.path);
    expect(paths).toContain('references/style-guide.md');
    expect(paths).toContain('references/style.md');
    expect(versions.filter((v) => v.priorPath !== null)).toHaveLength(paths.filter((p) => p === 'references/style.md').length);
  });

  it('listVersionsForPath("ideas/inbox.md") — path-reuse safety: only the fresh inbox lineage is returned', () => {
    // The original ideas/inbox.md was renamed to ideas/inbox-archive.md, then a NEW ideas/inbox.md was created.
    // listVersionsForPath("ideas/inbox.md") must return ONLY the new lineage (from the rename-point onwards).
    const newestToOldest = fx.manifests.slice().reverse();
    const versions = service.listVersionsForPath('ideas/inbox.md', newestToOldest);
    // Every returned version must be FROM or AFTER the create-new-inbox snapshot.
    for (const v of versions) {
      expect(v.created_at >= '2026-04-08T03:00:00.000Z').toBe(true);
    }
    // And none should be before (the original A→B rename boundary).
    expect(versions.find((v) => v.snapshot_id === '2026-04-01T03-00-full')).toBeUndefined();
  });

  it('restoreInPlace round-trip: restore 5 paths and every one matches expected content', async () => {
    const head = fx.manifests[fx.manifests.length - 1].id;
    const { vault, written } = makeFakeVault();
    const ops = new RestoreOperations({
      restoreService: service,
      loader: fixtureLoader(fx),
      vault,
      logger: makeLogger(),
    });

    const paths = [
      'journal/2026-04-01.md',
      'journal/2026-04-08.md',
      'ideas/inbox.md',
      'ideas/inbox-archive.md',
      'references/style-guide.md',
    ];
    for (const p of paths) {
      await ops.restoreInPlace(p, head);
    }
    for (const p of paths) {
      const bytes = written.get(p);
      expect(bytes).toBeDefined();
      expect(new TextDecoder().decode(bytes!)).toBe(fx.expectedLatest[p]);
    }
  });
});

// ---------------------------------------------------------------------------
// CLI parity: plugin state vs CLI state at HEAD
// ---------------------------------------------------------------------------

describe('Phase 8 integration — CLI parity', () => {
  let fx: HistoryFixture;
  let root: string;

  beforeEach(async () => {
    fx = buildHistory();
    root = await mkdtemp(join(tmpdir(), 'archivist-phase8-'));
    await writeFixtureToDisk(fx, root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('CLI reconstruct at HEAD matches the plugin\'s materialized state file-for-file', async () => {
    const head = fx.manifests[fx.manifests.length - 1].id;

    // Plugin-side materialization.
    const service = new RestoreService({
      loader: fixtureLoader(fx),
      dropbox: fixtureDropbox(fx),
      logger: makeLogger(),
    });
    const pluginState = await service.materializeVaultStateAt(head);

    // CLI-side materialization from disk.
    const cliState = await cliMaterializeState(root, head);

    expect(Object.keys(pluginState).sort()).toEqual(Object.keys(cliState).sort());
    // Hashes match across both paths.
    for (const path of Object.keys(pluginState)) {
      expect(pluginState[path].hash).toBe(cliState[path].hash);
    }

    // CLI reconstruct — write the tree to a tmp dir, read each back, compare.
    const out = join(root, 'reconstructed');
    await cliReconstruct(root, cliState, out, {});
    for (const path of Object.keys(pluginState)) {
      const disk = await readFile(join(out, path), 'utf8');
      expect(disk).toBe(fx.expectedLatest[path]);
    }
  });

  it('ManifestCache wired to the on-disk fixture fetches + caches correctly', async () => {
    const downloadJson = vi.fn(async (path: string): Promise<unknown> => {
      const rel = path.replace(/^test-vault\//, '');
      return JSON.parse(await readFile(join(root, rel), 'utf8'));
    });
    const cache = new ManifestCache({
      dropbox: { downloadJson },
      vaultPrefix: 'test-vault',
      logger: makeLogger(),
    });
    const list = await cache.listSnapshotsNewestFirst();
    expect(list[0].id).toBe(fx.manifests[fx.manifests.length - 1].id);

    const head = fx.manifests[fx.manifests.length - 1];
    const m = await cache.loadManifest(head.id);
    expect(m.id).toBe(head.id);
    // Second call hits cache.
    const callsBefore = downloadJson.mock.calls.length;
    await cache.loadManifest(head.id);
    expect(downloadJson.mock.calls.length).toBe(callsBefore);
  });
});
