// idle-tick.test.ts — T10.7b: SchedulerFSM idle-tick SLO.
//
// SLO budget (spec: p99 < 5ms per tick):
//   - 1000 ticks with an empty queue (getQueueSize: () => 0).
//   - Measures per-tick duration using performance.now().
//   - p99 must be < 5ms.
//
// The "idle tick" path in SchedulerFSM.tick() short-circuits at
// `if (this.deps.getQueueSize() === 0) return;` after checking the scheduled-
// full and catch-up conditions. This test verifies the scheduler overhead is
// negligible even in states that reach the queue check (READY / ERROR).

import { describe, it, expect } from 'vitest';
import { SchedulerFSM } from '../../src/services/SchedulerFSM';
import { createLogger } from '../../src/infra/Logger';
import { testSetTimeoutFn, testClearTimeoutFn } from '../fixtures/fsm-timers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TICK_COUNT = 1000;
const P99_SLO_MS = 5;

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('Perf — T10.7b idle-tick SLO', () => {
  it(`p99 of ${TICK_COUNT} idle ticks < ${P99_SLO_MS}ms`, () => {
    const logger = createLogger(() => false);

    // Use a fixed "now" far past any scheduled backup window so tick()
    // never triggers BACKUP_RUNNING (keeps the FSM in READY throughout).
    const fixedNow = new Date('2026-01-01T12:00:00Z').getTime();

    const fsm = new SchedulerFSM({
      schedule: {
        startup_grace_minutes: 0,
        quiet_after_event_minutes: 0,
        inc_interval_minutes: 60, // long interval so incremental is never triggered
        full_cadence: 'weekly',
        full_day_of_week: 0,
        full_time_of_day: '03:00',
      },
      isDesignated: () => true,
      getQueueSize: () => 0, // empty queue → idle tick
      getLastIncCommitAt: () => fixedNow - 1000,
      getLastFullCommitAt: () => fixedNow - 1000,
      getEarliestPendingObservedAt: () => null,
      preflightHost: { showPreflight: () => {} },
      logger,
      now: () => fixedNow,
      setTimeoutFn: testSetTimeoutFn,
      clearTimeoutFn: testClearTimeoutFn,
    });

    // Advance FSM to READY state so tick() is not a no-op from LOADING
    fsm.onLayoutReady();
    // LOADING → GRACE; we need to advance to READY manually
    // (GRACE → QUIET_WAIT → READY via timer; here we transition directly
    // since grace_minutes=0 and quiet_after=0, the timers fire synchronously
    // in tests or we can drive via setDesignated)
    // Easiest: setDesignated(false) + setDesignated(true) to reach READY
    fsm.setDesignated(false); // → PASSIVE
    fsm.setDesignated(true);  // → READY

    expect(fsm.getState()).toBe('READY');

    const durations: number[] = [];

    for (let i = 0; i < TICK_COUNT; i++) {
      const start = performance.now();
      fsm.tick();
      durations.push(performance.now() - start);
    }

    // FSM should still be READY (idle, no backup triggered)
    expect(fsm.getState()).toBe('READY');

    const p99 = percentile(durations, 99);
    expect(
      p99,
      `p99 tick duration ${p99.toFixed(3)}ms should be < ${P99_SLO_MS}ms`,
    ).toBeLessThan(P99_SLO_MS);
  });
});
