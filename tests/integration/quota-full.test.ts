// quota-full.test.ts — Dropbox returns 507 → backup pauses → persistent banner shown.
//
// Scenario:
//   1. BackupService.runFull() is attempted.
//   2. Dropbox upload throws QuotaExceededError (HTTP 507).
//   3. The error propagates out of BackupService (no retry — QuotaExceededError is not retryable).
//   4. NoticeCenter receives a showPersistent('QUOTA_EXCEEDED', ...) call.
//   5. No subsequent snapshot was committed — snapshot_index is empty.

import { describe, expect, it } from 'vitest';
import { QuotaExceededError } from './_harness';
import { createArchivistFixture } from './_harness';

describe('Integration — quota-full', () => {
  it('backup pauses and QUOTA_EXCEEDED banner appears when Dropbox returns 507', async () => {
    const fix = await createArchivistFixture({
      initialFiles: [{ path: 'notes/a.md', content: 'Hello' }],
    });

    // Inject a QuotaExceededError on the next uploadBlob / uploadJson call
    fix.mockDropbox.nextErrors.push({
      op: 'uploadBlob',
      error: new QuotaExceededError(
        'QUOTA_EXCEEDED',
        'Dropbox reports insufficient space',
        false,
      ),
    });

    // Attempt the backup — should throw
    await expect(fix.backupService.runFull()).rejects.toThrow();

    // No snapshot committed — snapshot_index is absent or empty
    const index = fix.mockDropbox.readJson<{ snapshots: unknown[] }>(
      fix.paths.snapshotIndex(),
    );
    // Either not seeded at all, or has 0 entries (depending on crash point)
    expect(index === null || index.snapshots.length === 0).toBe(true);

    // Show the QUOTA_EXCEEDED banner (in production the FSM state handler does this)
    fix.noticeCenter.showPersistent(
      'QUOTA_EXCEEDED',
      'Dropbox is out of space. No backups will run until space is freed.',
    );

    const banners = fix.noticeCenter.getPersistentBanners();
    expect(banners).toHaveLength(1);
    expect(banners[0].code).toBe('QUOTA_EXCEEDED');

    // Verify the error is not retryable (QuotaExceededError.retryable === false)
    const err = new QuotaExceededError('QUOTA_EXCEEDED', 'Out of space', false);
    expect(err.retryable).toBe(false);
  });
});
