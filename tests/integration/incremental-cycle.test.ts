// incremental-cycle.test.ts — edit 5 files → trigger inc → 1 inc with exactly 5 paths.
//
// Scenario: vault has 10 files. User edits 5. An incremental backup runs.
// Assert:
//   1. Exactly one new snapshot in snapshot_index (inc type).
//   2. The manifest lists exactly the 5 changed paths.
//   3. HEAD updated to the new inc snapshot.
//   4. LocalIndex.last_inc_snapshot_id matches the new snapshot.

import { describe, expect, it } from 'vitest';
import { createArchivistFixture } from './_harness';
import type { SnapshotManifest } from './_harness';

describe('Integration — incremental-cycle', () => {
  it('incremental backup captures exactly 5 edited files', async () => {
    const allFiles = Array.from({ length: 10 }, (_, i) => ({
      path: `notes/file-${i}.md`,
      content: `# Note ${i} v1`,
    }));

    const fix = await createArchivistFixture({ initialFiles: allFiles });

    // Run a full backup first (incremental requires a prior full)
    await fix.triggerFull();

    const fullIndex = fix.mockDropbox.readJson<{ snapshots: unknown[] }>(fix.paths.snapshotIndex());
    expect(fullIndex!.snapshots).toHaveLength(1);

    // Edit 5 files — add them to the queue as modify events
    const editedPaths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const path = `notes/file-${i}.md`;
      const newContent = `# Note ${i} v2 — edited`;
      fix.editFile(path, newContent);
      editedPaths.push(path);
      // Manually add queue entries (normally done by ChangeDetector via vault events)
      fix.pluginStore.queue.entries.push({
        id: crypto.randomUUID(),
        type: 'modify',
        path,
        prev_path: null,
        observed_at: new Date(Date.now() + i).toISOString(),
      });
    }

    await fix.triggerInc();

    // --- snapshot_index has exactly 2 entries (full + inc) ---
    const indexAfterInc = fix.mockDropbox.readJson<{
      snapshots: Array<{ id: string; type: string }>;
    }>(fix.paths.snapshotIndex());
    expect(indexAfterInc!.snapshots).toHaveLength(2);
    const incEntry = indexAfterInc!.snapshots.find((s) => s.type === 'inc');
    expect(incEntry).not.toBeUndefined();

    // --- manifest lists exactly the 5 changed paths ---
    const manifest = fix.mockDropbox.readJson<SnapshotManifest>(
      fix.paths.snapshot(incEntry!.id),
    );
    expect(manifest).not.toBeNull();
    expect(manifest!.type).toBe('inc');
    const changedInManifest = Object.keys(manifest!.files);
    expect(changedInManifest).toHaveLength(5);
    for (const p of editedPaths) {
      expect(changedInManifest).toContain(p);
    }

    // --- HEAD updated to inc snapshot ---
    const head = fix.mockDropbox.readJson<{ snapshot_id: string; snapshot_type: string }>(
      fix.paths.head(),
    );
    expect(head!.snapshot_id).toBe(incEntry!.id);
    expect(head!.snapshot_type).toBe('inc');

    // --- LocalIndex updated ---
    const localIndex = await fix.pluginStore.loadIndex();
    expect(localIndex!.last_inc_snapshot_id).toBe(incEntry!.id);
  });
});
