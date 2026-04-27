// first-run.test.ts — install → first full backup → manifests + HEAD + index consistent.
//
// Scenario: fresh install with no prior backups on Dropbox.
// The vault has 3 files. We call triggerFull() and verify:
//   1. HEAD.json written with the new snapshot id.
//   2. snapshot_index.json has exactly one entry (the full).
//   3. The manifest (snapshots/<id>.json) lists all 3 files.
//   4. Content blobs were uploaded for all 3 files.
//   5. LocalIndex has files matching the manifest.

import { describe, expect, it } from 'vitest';
import { sha256hex } from '../../src/infra/Hasher';
import { createArchivistFixture } from './_harness';
import type { SnapshotManifest } from './_harness';

describe('Integration — first-run', () => {
  it('first full backup produces consistent HEAD + snapshot_index + manifest', async () => {
    const files = [
      { path: 'daily/2026-01-01.md', content: '# January 1' },
      { path: 'daily/2026-01-02.md', content: '# January 2' },
      { path: 'projects/alpha.md', content: '# Alpha' },
    ];

    const fix = await createArchivistFixture({ initialFiles: files });

    await fix.triggerFull();

    // --- HEAD.json ---
    const head = fix.mockDropbox.readJson<{
      snapshot_id: string;
      snapshot_type: string;
      committed_at: string;
    }>(fix.paths.head());
    expect(head).not.toBeNull();
    expect(head!.snapshot_type).toBe('full');
    expect(head!.snapshot_id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-full$/);

    const snapshotId = head!.snapshot_id;

    // --- snapshot_index.json ---
    const index = fix.mockDropbox.readJson<{ snapshots: Array<{ id: string; type: string }> }>(
      fix.paths.snapshotIndex(),
    );
    expect(index).not.toBeNull();
    expect(index!.snapshots).toHaveLength(1);
    expect(index!.snapshots[0].id).toBe(snapshotId);
    expect(index!.snapshots[0].type).toBe('full');

    // --- manifest ---
    const manifest = fix.mockDropbox.readJson<SnapshotManifest>(fix.paths.snapshot(snapshotId));
    expect(manifest).not.toBeNull();
    expect(manifest!.type).toBe('full');
    expect(manifest!.parent_id).toBeNull();
    const manifestPaths = Object.keys(manifest!.files);
    expect(manifestPaths).toHaveLength(files.length);
    for (const f of files) {
      expect(manifestPaths).toContain(f.path);
    }

    // --- content blobs ---
    for (const f of files) {
      const hash = await sha256hex(new TextEncoder().encode(f.content));
      const blobPath = fix.paths.content(hash);
      const stored = fix.mockDropbox.store.get(blobPath);
      expect(stored, `blob for ${f.path} not found`).not.toBeUndefined();
      const text = new TextDecoder().decode(stored!);
      expect(text).toBe(f.content);
    }

    // --- LocalIndex consistent with manifest ---
    const localIndex = await fix.pluginStore.loadIndex();
    expect(localIndex).not.toBeNull();
    expect(localIndex!.last_full_snapshot_id).toBe(snapshotId);
    expect(Object.keys(localIndex!.files)).toHaveLength(files.length);
  });
});
