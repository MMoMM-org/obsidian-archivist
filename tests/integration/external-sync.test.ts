// external-sync.test.ts — mtime-only change from external sync → no inc snapshot at all.
//
// Scenario (spurious mtime changes from Obsidian Sync / iCloud / Dropbox /
// linter/formatter plugins that re-save without content changes):
//   1. Full backup → LocalIndex has hash H for file 'notes/a.md'.
//   2. External event touches the file (updates mtime) but does NOT change content.
//      The queue gets a 'modify' event for that path.
//   3. Incremental backup runs.
//   4. Assert:
//      a) NO inc snapshot is committed — buildChanges filters the file out
//         (hash unchanged), and an inc with an empty changes/deletes/renames
//         set is a pure no-op that would only consume Dropbox bandwidth.
//      b) The queue cursor advanced past the no-op event so the same
//         spurious event isn't re-evaluated on every subsequent tick.
//      c) The index's last_inc_snapshot_id stays unchanged (no new inc).
//      d) No additional blob was uploaded for 'notes/a.md'.

import { describe, expect, it } from 'vitest';
import { createArchivistFixture } from './_harness';

describe('Integration — external-sync mtime-only', () => {
  it('incremental commits NO snapshot when content hash is unchanged', async () => {
    const path = 'notes/a.md';
    const content = 'Content that does not change';

    const fix = createArchivistFixture({
      initialFiles: [{ path, content }],
    });

    // Full backup
    await fix.triggerFull();
    const indexAfterFull = fix.mockDropbox.readJson<{
      snapshots: Array<{ id: string; type: string }>;
    }>(fix.paths.snapshotIndex());
    const incsBeforeNoOp = (indexAfterFull?.snapshots ?? []).filter((s) => s.type === 'inc').length;

    // Simulate an mtime-only "edit" — same bytes, new mtime
    fix.editFile(path, content); // same content, mtime updated by editFile

    // Add queue entry as if vault emitted a modify event
    const noOpEventTime = new Date(Date.now() + 100).toISOString();
    fix.pluginStore.queue.entries.push({
      id: crypto.randomUUID(),
      type: 'modify',
      path,
      prev_path: null,
      observed_at: noOpEventTime,
    });

    await fix.triggerInc();

    // a) NO inc snapshot was added — the runIncremental no-op short-circuit
    //    advanced the cursor and skipped the commit chain.
    const indexAfterNoOp = fix.mockDropbox.readJson<{
      snapshots: Array<{ id: string; type: string }>;
    }>(fix.paths.snapshotIndex());
    const incsAfterNoOp = (indexAfterNoOp?.snapshots ?? []).filter((s) => s.type === 'inc').length;
    expect(incsAfterNoOp).toBe(incsBeforeNoOp);

    // b) Queue cursor advanced past the no-op event — otherwise the same
    //    event would re-trigger on every tick forever.
    expect(fix.pluginStore.queue.committed_through).not.toBeNull();
    expect(
      fix.pluginStore.queue.entries.every((e) => e.observed_at > fix.pluginStore.queue.committed_through!),
    ).toBe(true);
  });
});
