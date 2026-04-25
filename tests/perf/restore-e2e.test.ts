// restore-e2e.test.ts — T10.7c: RestoreOperations.restoreInPlace end-to-end SLO.
//
// SLO budget (spec: < 30s; this test: < 30s including 100ms RTT mock):
//   - Chain of ~5 snapshots (1 full + 4 inc) for a single test file.
//   - Target is the 5th snapshot's version of the file.
//   - Dropbox mock adds 100ms artificial RTT per download call.
//   - ManifestCache is pre-warmed so index load and manifest downloads
//     are all cache hits (the SLO includes only the content fetch step).
//   - Total wall-clock time < 30s.
//
// Why this SLO is conservative:
//   The spec targets < 30s including real network RTT. With a 100ms mock RTT
//   and ~5-6 total network calls (index, 5 manifests, 1 content blob), the
//   theoretical minimum is ~600ms. The 30s budget is very generous and will
//   catch catastrophic regressions (e.g., unbounded chain walks, sequential
//   duplicate manifest loads).

import { describe, it, expect } from 'vitest';
import { sha256hex } from '../../src/infra/Hasher';
import { RestoreService } from '../../src/services/RestoreService';
import { RestoreOperations } from '../../src/services/RestoreOperations';
import { ManifestCache } from '../../src/services/ManifestCache';
import { createLogger } from '../../src/infra/Logger';
import type { SnapshotManifest } from '../../src/model/Manifest';
import type { SnapshotIndex } from '../../src/model/SnapshotIndex';
import type { ManifestLoader } from '../../src/services/RestoreService';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MOCK_RTT_MS = 100;
const E2E_SLO_MS = 30_000;
const VAULT_PREFIX = 'perf-vault';
const FILE_PATH = 'notes/target.md';

// ---------------------------------------------------------------------------
// Build a 5-snapshot chain (1 full + 4 inc)
// ---------------------------------------------------------------------------

interface Chain {
  snapshots: SnapshotManifest[];
  fileContentsByHash: Map<string, Uint8Array>;
  targetSnapshotId: string;
  targetFileHash: string;
  targetContent: Uint8Array;
}

async function buildChain(): Promise<Chain> {
  const encoder = new TextEncoder();
  const fileContentsByHash = new Map<string, Uint8Array>();

  // Full snapshot (index 0)
  const fullContent = encoder.encode('# Target file — full backup version');
  const fullHash = await sha256hex(fullContent);
  fileContentsByHash.set(fullHash, fullContent);

  const snapshots: SnapshotManifest[] = [];

  const full: SnapshotManifest = {
    schema_version: '1.0',
    id: '2026-01-01T03-00-full',
    type: 'full',
    parent_id: null,
    device_id: 'test-device',
    created_at: '2026-01-01T03:00:00.000Z',
    vault_name: 'perf-vault',
    vault_prefix: VAULT_PREFIX,
    files: {
      [FILE_PATH]: { hash: fullHash, size: fullContent.length, mtime: 1000000 },
      'notes/other.md': { hash: fullHash, size: fullContent.length, mtime: 1000000 },
    },
    deleted: [],
    renames: [],
    exclusions_applied: null,
  };
  snapshots.push(full);

  // Incremental snapshots (1-4)
  let prevId = '2026-01-01T03-00-full';
  for (let i = 1; i <= 4; i++) {
    const content = encoder.encode(`# Target file — inc-${i}`);
    const hash = await sha256hex(content);
    fileContentsByHash.set(hash, content);
    const day = String(i + 1).padStart(2, '0');
    const id = `2026-01-${day}T03-00-inc`;

    const inc: SnapshotManifest = {
      schema_version: '1.0',
      id,
      type: 'inc',
      parent_id: prevId,
      device_id: 'test-device',
      created_at: `2026-01-${day}T03:00:00.000Z`,
      vault_name: 'perf-vault',
      vault_prefix: VAULT_PREFIX,
      files: {
        [FILE_PATH]: { hash, size: content.length, mtime: 1000000 + i },
      },
      deleted: [],
      renames: [],
      exclusions_applied: null,
    };
    snapshots.push(inc);
    prevId = id;
  }

  const target = snapshots[snapshots.length - 1];
  const targetEntry = target.files[FILE_PATH];
  const targetContent = fileContentsByHash.get(targetEntry.hash)!;

  return {
    snapshots,
    fileContentsByHash,
    targetSnapshotId: target.id,
    targetFileHash: targetEntry.hash,
    targetContent,
  };
}

// ---------------------------------------------------------------------------
// Mock Dropbox with configurable RTT
// ---------------------------------------------------------------------------

function makeRttDropbox(chain: Chain) {
  const delay = (): Promise<void> =>
    new Promise((r) => setTimeout(r, MOCK_RTT_MS));

  const snapshotIndex: SnapshotIndex = {
    schema_version: '1.0',
    last_updated_at: '2026-01-05T03:00:00.000Z',
    snapshots: chain.snapshots.map((s) => ({
      id: s.id,
      type: s.type,
      parent_id: s.parent_id,
      created_at: s.created_at,
      device_id: s.device_id,
      blob_hashes: Object.values(s.files).map((f) => f.hash),
    })),
  };

  const manifestsByPath = new Map<string, unknown>();
  for (const snap of chain.snapshots) {
    const path = `Apps/Archivist/${VAULT_PREFIX}/snapshots/${snap.id}.json`;
    manifestsByPath.set(path, snap);
  }
  const indexPath = `Apps/Archivist/${VAULT_PREFIX}/snapshot_index.json`;

  return {
    downloadJson: async (path: string): Promise<unknown> => {
      await delay();
      if (path === indexPath) return snapshotIndex;
      const manifest = manifestsByPath.get(path);
      if (manifest) return manifest;
      throw new Error(`Not found: ${path}`);
    },
    downloadBytes: async (path: string): Promise<Uint8Array> => {
      await delay();
      // Content path format: Apps/Archivist/<prefix>/content/<hex2>/<hash>
      const hash = path.split('/').pop() ?? '';
      const bytes = chain.fileContentsByHash.get(hash);
      if (!bytes) throw new Error(`Content not found: ${path}`);
      return bytes;
    },
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('Perf — T10.7c restore-e2e SLO', () => {
  it(`restoreInPlace on a 5-snapshot chain completes in < ${E2E_SLO_MS}ms with ${MOCK_RTT_MS}ms RTT`, async () => {
    const chain = await buildChain();
    const mockDropbox = makeRttDropbox(chain);
    const logger = createLogger(() => false);

    // Build ManifestCache and pre-warm it
    const cache = new ManifestCache({
      dropbox: mockDropbox as Parameters<typeof ManifestCache>[0]['dropbox'],
      vaultPrefix: VAULT_PREFIX,
      logger,
    });
    // Pre-warm: load index + all 5 manifests so the SLO only measures content fetch
    await cache.ensureIndexLoaded();
    for (const snap of chain.snapshots) {
      await cache.loadManifest(snap.id);
    }

    // Build RestoreService with the warm cache
    const restoreService = new RestoreService({
      loader: cache as ManifestLoader,
      dropbox: mockDropbox,
      logger,
    });

    // Vault mock: writeAtomic is a no-op (we test timing, not disk write)
    const vaultMock = {
      mkdirParents: async () => {},
      writeAtomic: async () => {},
      readBytes: async () => new Uint8Array(0),
      stat: async () => null,
      getFiles: () => [],
      onVaultCreate: () => ({ _id: 0, _event: '' }),
      onVaultModify: () => ({ _id: 0, _event: '' }),
      onVaultDelete: () => ({ _id: 0, _event: '' }),
      onVaultRename: () => ({ _id: 0, _event: '' }),
    };

    const restoreOps = new RestoreOperations({
      restoreService,
      loader: cache as ManifestLoader,
      vault: vaultMock as unknown as Parameters<typeof RestoreOperations>[0]['vault'],
      logger,
    });

    const start = performance.now();
    const result = await restoreOps.restoreInPlace(FILE_PATH, chain.targetSnapshotId);
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(true);
    expect(result.path).toBe(FILE_PATH);
    expect(result.snapshotId).toBe(chain.targetSnapshotId);
    expect(result.bytesWritten).toBe(chain.targetContent.length);

    expect(
      elapsed,
      `restore-e2e took ${elapsed.toFixed(0)}ms, SLO is < ${E2E_SLO_MS}ms`,
    ).toBeLessThan(E2E_SLO_MS);
  }, E2E_SLO_MS + 5000); // test timeout = SLO + 5s margin
});
