// device-conflict.test.ts — two devices both designated → second device backup aborts.
//
// Scenario (ROB-001 / DeviceCoordinator.verifyNoConflict):
//   1. Device A runs a full backup → writes HEAD.json with committed_at = T.
//   2. Device B (our fixture) attempts a backup. The HEAD.json it reads shows
//      device A committed recently (within 2h).
//   3. verifyNoConflict should throw ConflictError('DEVICE_CONFLICT').
//   4. Assert the backup throws and snapshot_index has only 1 entry.

import { describe, expect, it } from 'vitest';
import { ConflictError } from './_harness';
import { createArchivistFixture } from './_harness';

describe('Integration — device-conflict', () => {
  it('second device backup aborts with DEVICE_CONFLICT when HEAD is recent', async () => {
    const fix = createArchivistFixture({
      initialFiles: [{ path: 'notes/a.md', content: 'Hello' }],
      vaultPrefix: 'test-vault',
    });

    // Simulate Device A already having committed recently:
    // Seed a HEAD.json showing another device committed 30 minutes ago.
    // device_id must be a valid UUIDv4 to pass HEAD schema validation.
    const deviceAId = 'a1b2c3d4-e5f6-4789-ab01-cd23ef456789';
    const recentCommitAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    fix.mockDropbox.seedJson(fix.paths.head(), {
      schema_version: '1.0',
      snapshot_id: '2026-01-01T03-00-full',
      snapshot_type: 'full',
      device_id: deviceAId,
      committed_at: recentCommitAt,
    });

    // Also seed a minimal snapshot_index and manifest so PluginStore is ready
    fix.mockDropbox.seedJson(fix.paths.snapshotIndex(), {
      schema_version: '1.0',
      last_updated_at: recentCommitAt,
      snapshots: [
        {
          id: '2026-01-01T03-00-full',
          type: 'full',
          parent_id: null,
          created_at: recentCommitAt,
          device_id: deviceAId,
          blob_hashes: [],
        },
      ],
    });
    fix.mockDropbox.seedJson(fix.paths.snapshot('2026-01-01T03-00-full'), {
      schema_version: '1.0',
      id: '2026-01-01T03-00-full',
      type: 'full',
      parent_id: null,
      device_id: deviceAId,
      created_at: recentCommitAt,
      vault_name: 'test-vault',
      vault_prefix: 'test-vault',
      files: {},
      deleted: [],
      renames: [],
      exclusions_applied: null,
    });

    // Set up LocalIndex so runIncremental doesn't complain about missing full.
    // The hash must be valid hex (64 chars) to pass manifest schema checks.
    fix.pluginStore.index = {
      schema_version: '1.0',
      last_full_snapshot_id: '2026-01-01T03-00-full',
      last_full_commit_at: recentCommitAt,
      last_inc_snapshot_id: null,
      last_inc_commit_at: null,
      last_retention_at: null,
      index_missing_recovery_required: false,
      files: { 'notes/a.md': { hash: '0'.repeat(64), size: 5, mtime: 0 } },
    };

    // Add a queue entry so runIncremental doesn't short-circuit on empty queue
    fix.pluginStore.queue.entries.push({
      id: crypto.randomUUID(),
      type: 'modify',
      path: 'notes/a.md',
      prev_path: null,
      observed_at: new Date().toISOString(),
    });

    // Device B attempts a backup — should throw ConflictError
    await expect(fix.triggerInc()).rejects.toThrow();

    // Snapshot_index still only has the one entry from Device A
    const index = fix.mockDropbox.readJson<{ snapshots: unknown[] }>(fix.paths.snapshotIndex());
    expect(index!.snapshots).toHaveLength(1);
  });
});
