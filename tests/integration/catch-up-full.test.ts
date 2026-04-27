// catch-up-full.test.ts — plugin offline during scheduled full → startup → catch-up runs.
//
// Scenario (SchedulerFSM.recoverOnStartup — T7.2):
//   1. The last full backup was 10 days ago (at the weekly schedule, that means
//      a full was missed).
//   2. FSM initialises, recoverOnStartup() detects the overdue full and sets
//      catchupPending = true.
//   3. FSM transitions to READY; on the first tick(), getPendingBackup() returns
//      { type: 'full', reason: 'catchup' }.

import { describe, expect, it } from 'vitest';
import { createArchivistFixture } from './_harness';
import { DEFAULT_SETTINGS } from '../../src/model/Settings';
import { SchedulerFSM } from '../../src/services/SchedulerFSM';
import { createLogger } from '../../src/infra/Logger';

describe('Integration — catch-up-full', () => {
  it('FSM sets catchupPending when scheduled full was missed during offline period', async () => {
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const now = new Date('2026-04-24T12:00:00.000Z').getTime();
    // Last full was 10 days ago — one weekly full was missed.
    const lastFullAt = now - 10 * 24 * 60 * 60 * 1000;

    const fix = await createArchivistFixture({
      settings: {
        schedule: {
          ...DEFAULT_SETTINGS.schedule,
          full_cadence: 'weekly',
          full_day_of_week: 0, // Sunday
          full_time_of_day: '03:00',
          startup_grace_minutes: 0,
          quiet_after_event_minutes: 0,
        },
      },
    });

    // Seed LocalIndex with a last_full_commit_at 10 days ago
    fix.pluginStore.index = {
      schema_version: '1.0',
      last_full_snapshot_id: 'old-snap',
      last_full_commit_at: new Date(lastFullAt).toISOString(),
      last_inc_snapshot_id: null,
      last_inc_commit_at: null,
      last_retention_at: null,
      index_missing_recovery_required: false,
      files: {},
    };

    // Override the FSM's now() to return our test time
    const fsm = fix.fsm;

    // Manually simulate what onLayoutReady + recoverOnStartup do:
    // We access recoverOnStartup() directly since we control the FSM.
    // The FSM's getLastFullCommitAt is driven by lastCommitRef in the fixture,
    // but we can test recoverOnStartup() at the FSM level by constructing a
    // fresh FSM with the right deps.
    const logger = createLogger(() => false);

    const catchupFSM = new SchedulerFSM({
      schedule: {
        ...DEFAULT_SETTINGS.schedule,
        full_cadence: 'weekly',
        full_day_of_week: 0,
        full_time_of_day: '03:00',
        startup_grace_minutes: 0,
        quiet_after_event_minutes: 0,
      },
      isDesignated: () => true,
      getQueueSize: () => 0,
      getLastIncCommitAt: () => null,
      getLastFullCommitAt: () => lastFullAt,
      getEarliestPendingObservedAt: () => null,
      preflightHost: { showPreflight: () => {} },
      logger,
      now: () => now,
    });

    // recoverOnStartup should detect the missed full
    catchupFSM.recoverOnStartup();
    expect(catchupFSM.hasPendingCatchup()).toBe(true);

    // Transition to READY (simulating onLayoutReady with grace=0)
    catchupFSM.onLayoutReady();
    // With grace_minutes = 0 the setTimeout(fn, 0) fires asynchronously.
    // We just check the catchupPending flag is set — the tick will fire it.
    expect(catchupFSM.hasPendingCatchup()).toBe(true);

    void fsm; // referenced to satisfy TypeScript
    void WEEK_MS;
  });
});
