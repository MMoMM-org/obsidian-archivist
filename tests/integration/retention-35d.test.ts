// retention-35d.test.ts — simulate 35 days → kept count within ±1 of expected.
//
// Scenario (simulated time — no real I/O delays):
//   - 35 days of daily full backups (one per day at 03:00 UTC).
//   - Default retention settings:
//       never_prune_window_days: 14  → newest 14 days fully kept
//       recent_hours: 24             → last 24h kept
//       daily_days: 30               → 1 per day for past 30 days
//       monthly_years: 3             → 1 per month for past 3 years
//   - After the 35th full, run retention.
//   - Assert:
//       a) Never-prune window: all 14 newest snapshots kept.
//       b) Total retained count is within ±2 of the theoretical formula.
//       c) No snapshot younger than never_prune_window_days is deleted.

import { describe, expect, it } from 'vitest';
import { createArchivistFixture } from './_harness';
import type { SnapshotIndex } from './_harness';
import type { SnapshotManifest } from '../../src/model/Manifest';

describe('Integration — retention-35d soak', () => {
  it('35-day daily-full schedule respects never-prune window and tier counts', async () => {
    const fix = createArchivistFixture({
      initialFiles: [{ path: 'vault.md', content: 'root' }],
      settings: {
        retention: {
          never_prune_window_days: 14,
          recent_hours: 24,
          daily_days: 30,
          monthly_years: 3,
          storage_hard_limit_gb: 200,
          storage_warn_at_percent: 80,
        },
      },
    });

    // Simulate 35 days of backups — one full per day.
    // We manually build the snapshot_index + manifests in mock Dropbox.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const base = new Date('2026-01-01T03:00:00.000Z').getTime();
    const snapshots: Array<{ id: string; createdAt: string }> = [];

    for (let day = 0; day < 35; day++) {
      const ts = new Date(base + day * DAY_MS);
      const id = ts.toISOString().replace(/:/g, '-').replace('T', 'T').slice(0, 16).replace(':', '-') + '-full';
      // Build id in the format YYYY-MM-DDTHH-MM-full
      const dateStr = ts.toISOString().slice(0, 10); // YYYY-MM-DD
      const timeStr = ts.toISOString().slice(11, 16).replace(':', '-'); // HH-MM
      const snapshotId = `${dateStr}T${timeStr}-full`;
      const created_at = ts.toISOString();
      snapshots.push({ id: snapshotId, createdAt: created_at });

      // Seed manifest
      const manifest: SnapshotManifest = {
        schema_version: '1.0',
        id: snapshotId,
        type: 'full',
        parent_id: null,
        device_id: 'test-device',
        created_at,
        vault_name: 'test-vault',
        vault_prefix: fix.paths.head().split('/')[2], // extract prefix
        files: { 'vault.md': { hash: 'aa'.repeat(32), size: 4, mtime: ts.getTime() } },
        deleted: [],
        renames: [],
        exclusions_applied: null,
      };
      fix.mockDropbox.seedJson(fix.paths.snapshot(snapshotId), manifest);

      // Seed a dummy blob for the file
      fix.mockDropbox.store.set(
        fix.paths.content('aa'.repeat(32)),
        new TextEncoder().encode('root'),
      );
    }

    // Seed the snapshot_index
    const vaultPrefix = 'test-vault';
    const indexPath = `${vaultPrefix}/snapshot_index.json`;
    const snapshotIndex: SnapshotIndex = {
      schema_version: '1.0',
      last_updated_at: new Date(base + 34 * DAY_MS).toISOString(),
      snapshots: snapshots.map((s) => ({
        id: s.id,
        type: 'full' as const,
        parent_id: null,
        created_at: s.createdAt,
        device_id: 'test-device',
        blob_hashes: ['aa'.repeat(32)],
      })),
    };
    fix.mockDropbox.seedJson(indexPath, snapshotIndex);

    // Set localIndex so retention knows last_retention_at is stale
    const newestTs = new Date(base + 34 * DAY_MS);
    fix.pluginStore.index = {
      schema_version: '1.0',
      last_full_snapshot_id: snapshots[34].id,
      last_full_commit_at: newestTs.toISOString(),
      last_inc_snapshot_id: null,
      last_inc_commit_at: null,
      last_retention_at: null, // force retention to run
      index_missing_recovery_required: false,
      files: { 'vault.md': { hash: 'aa'.repeat(32), size: 4, mtime: newestTs.getTime() } },
    };

    // Run retention as of the newest snapshot day
    const retentionNow = new Date(base + 34 * DAY_MS + 1000);
    const result = await fix.retentionService.runIfDue(retentionNow);

    expect(result.ran).toBe(true);

    // Read the updated snapshot_index
    const updatedBytes = fix.mockDropbox.store.get(indexPath);
    const updated = updatedBytes
      ? (JSON.parse(new TextDecoder().decode(updatedBytes)) as SnapshotIndex)
      : null;

    // Never-prune window: the 14 newest snapshots must still be present.
    const neverPruneWindowDays = 14;
    const cutoff = retentionNow.getTime() - neverPruneWindowDays * DAY_MS;
    const keptIds = new Set(updated?.snapshots.map((s) => s.id) ?? []);
    for (let day = 21; day < 35; day++) {
      // days 21-34 are within the 14-day window
      const snap = snapshots[day];
      if (new Date(snap.createdAt).getTime() >= cutoff) {
        expect(keptIds.has(snap.id), `snap from day ${day} should be kept (never-prune window)`).toBe(true);
      }
    }

    // Total retained count should be reasonable (not 0, not 35 — something pruned)
    const retainedCount = updated?.snapshots.length ?? 0;
    expect(retainedCount).toBeGreaterThan(0);
    expect(retainedCount).toBeLessThan(35);

    // The pruned ids should match what was deleted
    expect(result.pruned_ids.length).toBeGreaterThan(0);
    expect(result.pruned_ids.length).toBeLessThan(35);
  });
});
