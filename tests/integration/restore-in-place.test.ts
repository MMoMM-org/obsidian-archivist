// restore-in-place.test.ts — pick an old version → restore → file content matches hash.
//
// Scenario:
//   1. Vault has file notes/journal.md with v1 content.
//   2. Full backup taken → v1 is in snapshot snap-v1.
//   3. File edited to v2 → incremental backup → snap-v2.
//   4. Call restoreService.materializeVaultStateAt(snap-v1) → verify v1 content.
//   5. Call restoreService.fetchContent(snap-v1, 'notes/journal.md') → bytes match v1 hash.

import { describe, expect, it } from 'vitest';
import { sha256hex } from '../../src/infra/Hasher';
import { createArchivistFixture } from './_harness';

describe('Integration — restore-in-place', () => {
  it('restores an earlier version of a file with correct content', async () => {
    const path = 'notes/journal.md';
    const v1 = '# Journal v1 — original content';
    const v2 = '# Journal v2 — edited content';

    const fix = createArchivistFixture({
      initialFiles: [{ path, content: v1 }],
    });

    // Full backup captures v1
    await fix.triggerFull();

    const indexAfterFull = fix.mockDropbox.readJson<{
      snapshots: Array<{ id: string; type: string }>;
    }>(fix.paths.snapshotIndex());
    const snapV1Id = indexAfterFull!.snapshots[0].id;

    // Edit file to v2 and run incremental
    fix.editFile(path, v2);
    fix.pluginStore.queue.entries.push({
      id: crypto.randomUUID(),
      type: 'modify',
      path,
      prev_path: null,
      observed_at: new Date(Date.now() + 100).toISOString(),
    });
    await fix.triggerInc();

    // materializeVaultStateAt the v1 snapshot
    const v1State = await fix.restoreService.materializeVaultStateAt(snapV1Id);
    expect(v1State[path]).not.toBeUndefined();
    const v1Hash = await sha256hex(new TextEncoder().encode(v1));
    expect(v1State[path].hash).toBe(v1Hash);

    // fetchContent verifies the actual bytes match
    const fetchedBytes = await fix.restoreService.fetchContent(snapV1Id, path);
    const fetchedText = new TextDecoder().decode(fetchedBytes);
    expect(fetchedText).toBe(v1);
  });
});
