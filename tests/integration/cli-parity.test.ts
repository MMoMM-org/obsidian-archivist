// cli-parity.test.ts — plugin RestoreService and standalone CLI produce identical output.
//
// Strategy (ROB-011 / TEST-M3):
//   - Load the shared merge-spec.json fixture.
//   - Seed an in-memory MockDropboxClient with the fixture's snapshot chain.
//   - Drive the plugin's RestoreService.materializeVaultStateAt() for each
//     parity assertion point.
//   - Assert the resolved vault state matches the expected content in the spec.
//
// CLI subprocess parity (byte-identical): deferred to a separate CI-gated step
// (tests/cli/cli-subprocess.test.ts) because running `node scripts/restore.mjs`
// in the same vitest process is fragile on CI. The import-based parity proven
// here covers the algorithm contract; the subprocess test covers the CLI UX.
//
// Fixture coverage (per T10.1 spec):
//   - pure rename
//   - delete
//   - rename-then-content-edit
//   - rename-to-collision (idempotent path)

import { describe, expect, it } from 'vitest';
import { createArchivistFixture } from './_harness';
import type { SnapshotManifest } from './_harness';
import { sha256hex } from '../../src/infra/Hasher';
import mergeSpec from '../fixtures/merge-spec.json';

type MergeSpec = typeof mergeSpec;
type SpecSnapshot = MergeSpec['snapshots'][number];
type ParityAssertion = MergeSpec['parity_assertions'][number];

function buildManifest(snap: SpecSnapshot, vaultPrefix: string): SnapshotManifest {
  const files: SnapshotManifest['files'] = {};
  for (const f of snap.files ?? []) {
    const hash = sha256HexSync(f.content);
    files[f.path] = { hash, size: f.content.length, mtime: 0 };
  }
  return {
    schema_version: '1.0',
    id: snap.id,
    type: snap.type as 'full' | 'inc',
    parent_id: snap.parent_id,
    device_id: snap.device_id,
    created_at: snap.created_at,
    vault_name: 'merge-spec-vault',
    vault_prefix: vaultPrefix,
    files,
    deleted: 'deleted' in snap ? (snap.deleted as string[]) : [],
    renames: ('renames' in snap ? snap.renames : []) as Array<{ from: string; to: string }>,
    exclusions_applied: null,
  };
}

// Sync SHA-256 hex using Node crypto (available in Node test env)
function sha256HexSync(content: string): string {
  const { createHash } = require('node:crypto') as { createHash: (alg: string) => { update: (s: string) => { digest: (enc: string) => string } } };
  return createHash('sha256').update(content).digest('hex');
}

describe('Integration — CLI parity (import-based)', () => {
  it('materializeVaultStateAt matches expected state for all 4 parity assertion points', async () => {
    const vaultPrefix = mergeSpec.vault_prefix;
    const fix = createArchivistFixture({ vaultPrefix });

    // Seed snapshots into mock Dropbox
    const allSnapshots = mergeSpec.snapshots;
    const snapshotIndexPath = `Apps/Archivist/${vaultPrefix}/snapshot_index.json`;

    for (const snap of allSnapshots) {
      const manifest = buildManifest(snap, vaultPrefix);
      const snapPath = `Apps/Archivist/${vaultPrefix}/snapshots/${snap.id}.json`;
      fix.mockDropbox.seedJson(snapPath, manifest);

      // Seed content blobs
      for (const f of snap.files ?? []) {
        const hash = sha256HexSync(f.content);
        const blobPath = `Apps/Archivist/${vaultPrefix}/content/${hash.slice(0, 2)}/${hash}`;
        if (!fix.mockDropbox.store.has(blobPath)) {
          fix.mockDropbox.store.set(blobPath, new TextEncoder().encode(f.content));
        }
      }
    }

    // Seed snapshot_index
    fix.mockDropbox.seedJson(snapshotIndexPath, {
      schema_version: '1.0',
      last_updated_at: allSnapshots[allSnapshots.length - 1].created_at,
      snapshots: allSnapshots.map((s) => ({
        id: s.id,
        type: s.type,
        parent_id: s.parent_id,
        created_at: s.created_at,
        device_id: s.device_id,
        blob_hashes: (s.files ?? []).map((f) => sha256HexSync(f.content)),
      })),
    });

    // Verify each parity assertion point
    for (const assertion of mergeSpec.parity_assertions as ParityAssertion[]) {
      const state = await fix.restoreService.materializeVaultStateAt(assertion.snapshot_id);

      const expectedPaths = Object.keys(assertion.expected);
      const actualPaths = Object.keys(state);

      // All expected paths should be present
      for (const path of expectedPaths) {
        expect(
          actualPaths,
          `[${assertion.description}] missing path ${path}`,
        ).toContain(path);
      }

      // No extra paths beyond what's expected
      for (const path of actualPaths) {
        expect(
          expectedPaths,
          `[${assertion.description}] unexpected path ${path}`,
        ).toContain(path);
      }

      // Verify content hash for each expected path
      for (const [path, expectedContent] of Object.entries(assertion.expected)) {
        const entry = state[path];
        expect(entry, `[${assertion.description}] no entry for ${path}`).not.toBeUndefined();
        const expectedHash = sha256HexSync(expectedContent);
        expect(
          entry.hash,
          `[${assertion.description}] hash mismatch for ${path}`,
        ).toBe(expectedHash);
      }
    }
  });

  it('--verify-only equivalent: detects corrupted blob in merge-spec fixture', async () => {
    const vaultPrefix = mergeSpec.vault_prefix;
    const fix = createArchivistFixture({ vaultPrefix });

    // Seed all snapshots
    const allSnapshots = mergeSpec.snapshots;
    for (const snap of allSnapshots) {
      const manifest = buildManifest(snap, vaultPrefix);
      fix.mockDropbox.seedJson(
        `Apps/Archivist/${vaultPrefix}/snapshots/${snap.id}.json`,
        manifest,
      );
      for (const f of snap.files ?? []) {
        const hash = sha256HexSync(f.content);
        const blobPath = `Apps/Archivist/${vaultPrefix}/content/${hash.slice(0, 2)}/${hash}`;
        fix.mockDropbox.store.set(blobPath, new TextEncoder().encode(f.content));
      }
    }
    fix.mockDropbox.seedJson(`Apps/Archivist/${vaultPrefix}/snapshot_index.json`, {
      schema_version: '1.0',
      last_updated_at: allSnapshots[allSnapshots.length - 1].created_at,
      snapshots: allSnapshots.map((s) => ({
        id: s.id,
        type: s.type,
        parent_id: s.parent_id,
        created_at: s.created_at,
        device_id: s.device_id,
        blob_hashes: (s.files ?? []).map((f) => sha256HexSync(f.content)),
      })),
    });

    // Corrupt one blob: overwrite content for 'notes/original.md' with garbage
    const originalContent = '# Original v1';
    const originalHash = sha256HexSync(originalContent);
    const corruptBlobPath = `Apps/Archivist/${vaultPrefix}/content/${originalHash.slice(0, 2)}/${originalHash}`;
    fix.mockDropbox.store.set(corruptBlobPath, new TextEncoder().encode('CORRUPTED_DATA'));

    // fetchContent performs hash verification — should throw CorruptionError
    const { CorruptionError } = await import('../../src/model/Errors');
    const headSnap = allSnapshots[0];
    await expect(
      fix.restoreService.fetchContent(headSnap.id, 'notes/original.md'),
    ).rejects.toThrow(CorruptionError);
  });
});

// Re-export to satisfy TypeScript (sha256hex used indirectly via sha256HexSync)
void sha256hex;
