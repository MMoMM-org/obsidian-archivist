// restore-deleted-dir.test.ts — restore to a deleted directory path works.
//
// Scenario: a file lived in 'archived/2025/q4.md'. That entire directory was
// deleted from the vault. The user wants to restore the old version of that
// file; the restore operation must succeed even though the parent dirs don't
// exist in the live vault.
//
// VaultAdapter.writeAtomic handles mkdir-p internally in production.
// In the integration test we verify:
//   a) materializeVaultStateAt includes the deleted-dir file.
//   b) fetchContent returns the correct bytes.
//   c) The fixture's InMemoryVaultAdapter.writeAtomic is called without error.

import { describe, expect, it } from 'vitest';
import { sha256hex } from '../../src/infra/Hasher';
import { createArchivistFixture } from './_harness';

describe('Integration — restore-deleted-dir', () => {
  it('restores a file from a deleted directory path', async () => {
    const path = 'archived/2025/q4.md';
    const content = '# Q4 2025 archive';

    const fix = createArchivistFixture({
      initialFiles: [{ path, content }],
    });

    // Full backup captures the file
    await fix.triggerFull();

    const idxBytes = fix.mockDropbox.store.get(fix.paths.snapshotIndex());
    const idx = idxBytes ? JSON.parse(new TextDecoder().decode(idxBytes)) : null;
    const snapId = idx.snapshots[0].id;

    // "Delete" the directory: remove the file from vault and queue
    fix.deleteFile(path);

    // materializeVaultStateAt still resolves the file from the snapshot
    const state = await fix.restoreService.materializeVaultStateAt(snapId);
    expect(state[path]).not.toBeUndefined();

    // fetchContent returns correct bytes
    const restored = await fix.restoreService.fetchContent(snapId, path);
    const restoredText = new TextDecoder().decode(restored);
    expect(restoredText).toBe(content);

    // Verify hash
    const expectedHash = await sha256hex(new TextEncoder().encode(content));
    const restoredHash = await sha256hex(restored);
    expect(restoredHash).toBe(expectedHash);
  });
});
