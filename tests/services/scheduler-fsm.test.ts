// T7.1 — SchedulerFSM: finite-state machine for backup cadence.
//
// Test surface covers every documented transition from plan/phase-7.md §T7.1
// plus no-op ticks in non-tickable states and timer cleanup on onunload.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SchedulerFSM,
  type FSMState,
  type PendingBackup,
  type PreflightActions,
  type PreflightHost,
  type SchedulerFSMDeps,
} from '../../src/services/SchedulerFSM';
import type { ScheduleSettings } from '../../src/model/Settings';
import type { Logger } from '../../src/infra/Logger';
import { testSetTimeoutFn, testClearTimeoutFn } from '../fixtures/fsm-timers';

// ---------------------------------------------------------------------------
// Fakes and factories
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeSchedule(overrides: Partial<ScheduleSettings> = {}): ScheduleSettings {
  return {
    full_cadence: 'weekly',
    full_day_of_week: 0,
    full_time_of_day: '03:00',
    inc_interval_minutes: 15,
    active_window_enabled: false,
    active_window_start: '08:00',
    active_window_end: '22:00',
    startup_grace_minutes: 10,
    quiet_after_event_minutes: 2,
    ...overrides,
  };
}

function makePreflightHost(): PreflightHost & {
  shown: PreflightActions[];
  shownAt: number[];
  dismissCalls: number;
} {
  const shown: PreflightActions[] = [];
  const shownAt: number[] = [];
  const host = {
    shown,
    shownAt,
    dismissCalls: 0,
    showPreflight(actions: PreflightActions, scheduledAt: number): void {
      shown.push(actions);
      shownAt.push(scheduledAt);
    },
    dismissPreflight(): void {
      host.dismissCalls += 1;
    },
  };
  return host;
}

interface HarnessOpts {
  designated?: boolean;
  queueSize?: number;
  lastIncCommitAt?: number | null;
  lastFullCommitAt?: number | null;
  /** Earliest still-uncommitted vault event timestamp. Defaults to 0 (epoch
   *  start) so any non-empty queue + a positive inc_interval reads as
   *  "interval already elapsed" — matches the pre-batch-window default that
   *  most tests want. Tests exercising the "interval NOT elapsed" path set
   *  this explicitly to a recent timestamp. */
  earliestPendingObservedAt?: number | null;
  schedule?: Partial<ScheduleSettings>;
  now?: () => number;
  preflightHost?: PreflightHost;
}

function makeFSM(opts: HarnessOpts = {}): {
  fsm: SchedulerFSM;
  deps: SchedulerFSMDeps;
  setDesignated: (v: boolean) => void;
  setQueueSize: (n: number) => void;
  setLastIncCommitAt: (ms: number | null) => void;
  setLastFullCommitAt: (ms: number | null) => void;
  setEarliestPendingObservedAt: (ms: number | null) => void;
  logger: Logger;
  preflightHost: PreflightHost & {
    shown: PreflightActions[];
    shownAt: number[];
    dismissCalls: number;
  };
} {
  let designated = opts.designated ?? true;
  let queueSize = opts.queueSize ?? 0;
  let lastIncCommitAt: number | null = opts.lastIncCommitAt ?? null;
  let lastFullCommitAt: number | null = opts.lastFullCommitAt ?? null;
  let earliestPendingObservedAt: number | null = opts.earliestPendingObservedAt ?? 0;
  const logger = makeLogger();
  const preflightHost = (opts.preflightHost ?? makePreflightHost()) as PreflightHost & {
    shown: PreflightActions[];
    shownAt: number[];
    dismissCalls: number;
  };

  const deps: SchedulerFSMDeps = {
    schedule: makeSchedule(opts.schedule),
    isDesignated: () => designated,
    getQueueSize: () => queueSize,
    getLastIncCommitAt: () => lastIncCommitAt,
    getLastFullCommitAt: () => lastFullCommitAt,
    getEarliestPendingObservedAt: () => earliestPendingObservedAt,
    preflightHost,
    logger,
    now: opts.now,
    setTimeoutFn: testSetTimeoutFn,
    clearTimeoutFn: testClearTimeoutFn,
  };

  return {
    fsm: new SchedulerFSM(deps),
    deps,
    setDesignated: (v) => {
      designated = v;
    },
    setQueueSize: (n) => {
      queueSize = n;
    },
    setLastIncCommitAt: (ms) => {
      lastIncCommitAt = ms;
    },
    setLastFullCommitAt: (ms) => {
      lastFullCommitAt = ms;
    },
    setEarliestPendingObservedAt: (ms) => {
      earliestPendingObservedAt = ms;
    },
    logger,
    preflightHost,
  };
}

// ---------------------------------------------------------------------------
// Tests — initial state
// ---------------------------------------------------------------------------

describe('SchedulerFSM — initial state', () => {
  it('starts in LOADING', () => {
    const { fsm } = makeFSM();
    expect(fsm.getState()).toBe('LOADING');
  });
});

// ---------------------------------------------------------------------------
// Tests — LOADING → GRACE / LOADING → PASSIVE (ROB-013)
// ---------------------------------------------------------------------------

describe('SchedulerFSM — onLayoutReady', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('LOADING + onLayoutReady + designated → GRACE', () => {
    const { fsm } = makeFSM({ designated: true });
    fsm.onLayoutReady();
    expect(fsm.getState()).toBe('GRACE');
  });

  it('LOADING + onLayoutReady + !designated → PASSIVE directly (ROB-013)', () => {
    const { fsm } = makeFSM({ designated: false });
    fsm.onLayoutReady();
    expect(fsm.getState()).toBe('PASSIVE');
  });

  it('LOADING + onLayoutReady + !designated does NOT start grace timer', () => {
    const { fsm } = makeFSM({ designated: false, schedule: { startup_grace_minutes: 10 } });
    fsm.onLayoutReady();
    // Advance well past the would-be grace window
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(fsm.getState()).toBe('PASSIVE');
  });

  it('is idempotent — a second onLayoutReady is a no-op', () => {
    const { fsm } = makeFSM({ designated: true });
    fsm.onLayoutReady();
    fsm.onLayoutReady();
    expect(fsm.getState()).toBe('GRACE');
  });
});

// ---------------------------------------------------------------------------
// Tests — GRACE → QUIET_WAIT
// ---------------------------------------------------------------------------

describe('SchedulerFSM — GRACE → QUIET_WAIT', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('transitions after startup_grace_minutes elapses', () => {
    const { fsm } = makeFSM({ schedule: { startup_grace_minutes: 10 } });
    fsm.onLayoutReady();
    expect(fsm.getState()).toBe('GRACE');

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fsm.getState()).toBe('QUIET_WAIT');
  });

  it('does not transition before the grace timer fires', () => {
    const { fsm } = makeFSM({ schedule: { startup_grace_minutes: 10 } });
    fsm.onLayoutReady();
    vi.advanceTimersByTime(9 * 60 * 1000);
    expect(fsm.getState()).toBe('GRACE');
  });
});

// ---------------------------------------------------------------------------
// Tests — QUIET_WAIT behavior
// ---------------------------------------------------------------------------

describe('SchedulerFSM — QUIET_WAIT', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function intoQuietWait(
    opts: HarnessOpts = {},
  ): ReturnType<typeof makeFSM> {
    const h = makeFSM({ schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 2 }, ...opts });
    h.fsm.onLayoutReady();
    vi.advanceTimersByTime(1 * 60 * 1000); // clear grace
    return h;
  }

  it('enters QUIET_WAIT after GRACE completes', () => {
    const { fsm } = intoQuietWait();
    expect(fsm.getState()).toBe('QUIET_WAIT');
  });

  it('onVaultEvent resets the quiet timer', () => {
    const { fsm } = intoQuietWait();

    // Advance 1 min (half the quiet period)
    vi.advanceTimersByTime(1 * 60 * 1000);
    expect(fsm.getState()).toBe('QUIET_WAIT');

    // Vault event resets — now we need a fresh 2 min of silence
    fsm.onVaultEvent();

    // Advance another 1 min — still waiting
    vi.advanceTimersByTime(1 * 60 * 1000);
    expect(fsm.getState()).toBe('QUIET_WAIT');

    // Another 1 min (total 2 min since reset) — now READY
    vi.advanceTimersByTime(1 * 60 * 1000);
    expect(fsm.getState()).toBe('READY');
  });

  it('transitions to READY after quiet_after_event_minutes with no events', () => {
    const { fsm } = intoQuietWait();
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(fsm.getState()).toBe('READY');
  });

  it('onVaultEvent in non-QUIET_WAIT states is a no-op', () => {
    const { fsm } = makeFSM();
    expect(() => fsm.onVaultEvent()).not.toThrow();
    expect(fsm.getState()).toBe('LOADING');
  });
});

// ---------------------------------------------------------------------------
// Tests — designated-toggle → PASSIVE
// ---------------------------------------------------------------------------

describe('SchedulerFSM — designated toggle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('setDesignated(false) from READY → PASSIVE', () => {
    const { fsm, setDesignated } = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 },
    });
    fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000); // → READY
    expect(fsm.getState()).toBe('READY');

    setDesignated(false);
    fsm.setDesignated(false);
    expect(fsm.getState()).toBe('PASSIVE');
  });

  it('setDesignated(false) from GRACE → PASSIVE (clears grace timer)', () => {
    const { fsm, setDesignated } = makeFSM();
    fsm.onLayoutReady();
    expect(fsm.getState()).toBe('GRACE');

    setDesignated(false);
    fsm.setDesignated(false);
    expect(fsm.getState()).toBe('PASSIVE');

    // Advancing past grace window must not re-enter QUIET_WAIT
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(fsm.getState()).toBe('PASSIVE');
  });

  it('setDesignated(false) from BACKUP_RUNNING is ignored (cannot interrupt an in-flight upload)', () => {
    const { fsm, setQueueSize, setDesignated } = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 },
    });
    fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);
    setQueueSize(1);
    fsm.tick();
    expect(fsm.getState()).toBe('BACKUP_RUNNING');

    setDesignated(false);
    fsm.setDesignated(false);
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
  });

  it('setDesignated(true) from PASSIVE → READY', () => {
    const { fsm, setDesignated } = makeFSM({ designated: false });
    fsm.onLayoutReady();
    expect(fsm.getState()).toBe('PASSIVE');

    setDesignated(true);
    fsm.setDesignated(true);
    expect(fsm.getState()).toBe('READY');
  });
});

// ---------------------------------------------------------------------------
// Tests — tick behavior
// ---------------------------------------------------------------------------

describe('SchedulerFSM — tick', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function intoReady(opts: HarnessOpts = {}): ReturnType<typeof makeFSM> {
    const h = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 },
      ...opts,
    });
    h.fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);
    return h;
  }

  it('READY + tick + non-empty queue + designated + interval elapsed → BACKUP_RUNNING', () => {
    const { fsm, setQueueSize } = intoReady();
    setQueueSize(3);
    fsm.tick();
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
  });

  it('READY + tick + empty queue → no transition (zero Dropbox cost)', () => {
    const { fsm, setQueueSize } = intoReady();
    setQueueSize(0);
    fsm.tick();
    expect(fsm.getState()).toBe('READY');
  });

  it('READY + tick + batch window NOT elapsed → no transition', () => {
    const now = Date.now();
    const { fsm, setQueueSize, setEarliestPendingObservedAt } = intoReady({
      now: () => now,
      schedule: { inc_interval_minutes: 15, startup_grace_minutes: 1, quiet_after_event_minutes: 1 },
    });
    // Earliest pending edit was only 5 min ago — 15-min batch window has not
    // elapsed yet, so the inc must wait even though the queue is non-empty.
    setEarliestPendingObservedAt(now - 5 * 60 * 1000);
    setQueueSize(3);
    fsm.tick();
    expect(fsm.getState()).toBe('READY');
  });

  it('tick in GRACE is a no-op', () => {
    const { fsm, setQueueSize } = makeFSM();
    fsm.onLayoutReady();
    setQueueSize(3);
    fsm.tick();
    expect(fsm.getState()).toBe('GRACE');
  });

  it('tick in QUIET_WAIT is a no-op', () => {
    const { fsm, setQueueSize } = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 2 },
    });
    fsm.onLayoutReady();
    vi.advanceTimersByTime(1 * 60 * 1000);
    expect(fsm.getState()).toBe('QUIET_WAIT');
    setQueueSize(3);
    fsm.tick();
    expect(fsm.getState()).toBe('QUIET_WAIT');
  });

  it('tick in PASSIVE is a no-op', () => {
    const { fsm, setQueueSize } = makeFSM({ designated: false });
    fsm.onLayoutReady();
    setQueueSize(3);
    fsm.tick();
    expect(fsm.getState()).toBe('PASSIVE');
  });

  it('tick in BACKUP_RUNNING is a no-op', () => {
    const { fsm, setQueueSize } = intoReady();
    setQueueSize(3);
    fsm.tick();
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
    // Another tick while backup is running — no change
    fsm.tick();
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
  });

  it('tick in AUTH_LOST is a no-op', () => {
    const { fsm, setQueueSize } = intoReady();
    fsm.setAuthLost();
    expect(fsm.getState()).toBe('AUTH_LOST');
    setQueueSize(3);
    fsm.tick();
    expect(fsm.getState()).toBe('AUTH_LOST');
  });

  it('tick in ERROR WITH queue non-empty → BACKUP_RUNNING (ERROR is not a no-op tick state)', () => {
    const { fsm, setQueueSize } = intoReady();
    setQueueSize(1);
    fsm.tick();
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
    fsm.onBackupFailure();
    expect(fsm.getState()).toBe('ERROR');

    setQueueSize(1);
    // After inc_interval has elapsed again — simulate by null last-commit
    fsm.tick();
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
  });

  it('batch window anchors on earliest pending edit, not on last commit', () => {
    // Regression guard for the "inc fires immediately after a long-idle
    // edit" surprise: pre-change, the inc interval was measured from
    // last_commit, so a fresh edit after a 1h idle would tick over within
    // ~60s (interval already exhausted on idle time). Now the interval
    // anchors on the earliest pending edit, giving the user a predictable
    // batch window.
    const now = Date.now();
    const { fsm, setQueueSize, setLastIncCommitAt, setEarliestPendingObservedAt } = intoReady({
      now: () => now,
      schedule: { inc_interval_minutes: 15, startup_grace_minutes: 1, quiet_after_event_minutes: 1 },
    });
    // Last inc was 1h ago — under the OLD logic this alone would fire.
    setLastIncCommitAt(now - 60 * 60 * 1000);
    // But the earliest pending edit is only 5 min old → batch window NOT
    // elapsed → no transition.
    setEarliestPendingObservedAt(now - 5 * 60 * 1000);
    setQueueSize(2);
    fsm.tick();
    expect(fsm.getState()).toBe('READY');

    // Push the earliest pending edit past the 15-min window → fires.
    setEarliestPendingObservedAt(now - 16 * 60 * 1000);
    fsm.tick();
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
  });

  it('tick in READY with old earliest-pending treats batch window as elapsed', () => {
    const { fsm, setQueueSize } = intoReady();
    // earliestPendingObservedAt defaults to 0 (epoch start) — interval is
    // trivially exceeded, so a non-empty queue fires immediately.
    setQueueSize(1);
    fsm.tick();
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
  });
});

// ---------------------------------------------------------------------------
// Tests — BACKUP_RUNNING outcome
// ---------------------------------------------------------------------------

describe('SchedulerFSM — backup outcomes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function intoRunning(): ReturnType<typeof makeFSM> {
    const h = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 },
    });
    h.fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);
    h.setQueueSize(1);
    h.fsm.tick();
    return h;
  }

  it('BACKUP_RUNNING + onBackupSuccess → READY', () => {
    const { fsm } = intoRunning();
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
    fsm.onBackupSuccess();
    expect(fsm.getState()).toBe('READY');
  });

  it('BACKUP_RUNNING + onBackupFailure → ERROR', () => {
    const { fsm } = intoRunning();
    fsm.onBackupFailure();
    expect(fsm.getState()).toBe('ERROR');
  });

  it('onBackupSuccess outside BACKUP_RUNNING is a no-op', () => {
    const { fsm } = makeFSM();
    fsm.onBackupSuccess();
    expect(fsm.getState()).toBe('LOADING');
  });
});

// ---------------------------------------------------------------------------
// Tests — AUTH_LOST
// ---------------------------------------------------------------------------

describe('SchedulerFSM — AUTH_LOST', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('setAuthLost from READY → AUTH_LOST', () => {
    const { fsm } = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 },
    });
    fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(fsm.getState()).toBe('READY');

    fsm.setAuthLost();
    expect(fsm.getState()).toBe('AUTH_LOST');
  });

  it('setAuthLost clears pending grace timer', () => {
    const { fsm } = makeFSM();
    fsm.onLayoutReady();
    expect(fsm.getState()).toBe('GRACE');

    fsm.setAuthLost();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(fsm.getState()).toBe('AUTH_LOST');
  });

  it('setAuthRestored from AUTH_LOST → READY', () => {
    const { fsm } = makeFSM();
    fsm.setAuthLost();
    fsm.setAuthRestored();
    expect(fsm.getState()).toBe('READY');
  });

  it('setAuthRestored outside AUTH_LOST is a no-op', () => {
    const { fsm } = makeFSM();
    fsm.setAuthRestored();
    expect(fsm.getState()).toBe('LOADING');
  });
});

// ---------------------------------------------------------------------------
// Tests — observer pattern
// ---------------------------------------------------------------------------

describe('SchedulerFSM — onStateChange', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('notifies subscribers on each transition with (next, prev)', () => {
    const { fsm } = makeFSM();
    const events: Array<{ next: FSMState; prev: FSMState }> = [];
    fsm.onStateChange((next, prev) => events.push({ next, prev }));

    fsm.onLayoutReady();
    expect(events).toEqual([{ next: 'GRACE', prev: 'LOADING' }]);
  });

  it('unsubscribe stops further notifications', () => {
    const { fsm } = makeFSM();
    const handler = vi.fn();
    const unsubscribe = fsm.onStateChange(handler);

    fsm.onLayoutReady();
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    vi.advanceTimersByTime(60 * 60 * 1000);
    // Even if more transitions happen internally, unsubscribed handler stays put
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not notify when the target state equals the current state', () => {
    const { fsm } = makeFSM();
    const handler = vi.fn();
    fsm.onStateChange(handler);

    fsm.onBackupSuccess(); // LOADING + onBackupSuccess is a no-op
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — onunload cleanup
// ---------------------------------------------------------------------------

describe('SchedulerFSM — onunload', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('clears grace timer; subsequent advance does not transition', () => {
    const { fsm } = makeFSM();
    fsm.onLayoutReady();
    expect(fsm.getState()).toBe('GRACE');

    fsm.onunload();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(fsm.getState()).toBe('GRACE'); // frozen
  });

  it('clears quiet timer', () => {
    const { fsm } = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 5 },
    });
    fsm.onLayoutReady();
    vi.advanceTimersByTime(1 * 60 * 1000);
    expect(fsm.getState()).toBe('QUIET_WAIT');

    fsm.onunload();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(fsm.getState()).toBe('QUIET_WAIT'); // frozen
  });

  it('leaves no lingering setTimeout handles (vi.getTimerCount === 0)', () => {
    const { fsm } = makeFSM();
    fsm.onLayoutReady();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    fsm.onunload();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T7.2 — Scheduled full computation
// ---------------------------------------------------------------------------

describe('SchedulerFSM — getNextScheduledFullAt', () => {
  it('returns weekly Sunday 03:00 given default schedule', () => {
    const now = new Date('2026-04-23T12:00:00'); // Thursday
    const { fsm } = makeFSM({ now: () => now.getTime() });
    const nextMs = fsm.getNextScheduledFullAt();
    const next = new Date(nextMs);
    expect(next.getDay()).toBe(0); // Sunday
    expect(next.getHours()).toBe(3);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('returns biweekly anchored to lastFullAt', () => {
    const lastFull = new Date('2026-04-19T03:00:00').getTime();
    const now = new Date('2026-04-20T12:00:00').getTime();
    const { fsm } = makeFSM({
      schedule: { full_cadence: 'biweekly' },
      lastFullCommitAt: lastFull,
      now: () => now,
    });
    const nextMs = fsm.getNextScheduledFullAt();
    const expected = new Date('2026-05-03T03:00:00').getTime();
    expect(nextMs).toBe(expected);
  });

  it('returns monthly first-Sunday for monthly cadence', () => {
    const now = new Date('2026-04-01T00:00:00').getTime();
    const { fsm } = makeFSM({
      schedule: { full_cadence: 'monthly' },
      now: () => now,
    });
    const nextMs = fsm.getNextScheduledFullAt();
    const next = new Date(nextMs);
    expect(next.getDate()).toBe(5); // first Sunday of April 2026
  });
});

// ---------------------------------------------------------------------------
// T7.2 — Pre-flight notice window
// ---------------------------------------------------------------------------

describe('SchedulerFSM — pre-flight notice', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fsmAtReady(
    nowRef: { value: number },
    schedule: Partial<ScheduleSettings> = {},
  ): ReturnType<typeof makeFSM> {
    const h = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1, ...schedule },
      now: () => nowRef.value,
    });
    h.fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);
    return h;
  }

  it('fires exactly once at scheduled - 5 min', () => {
    const scheduled = new Date('2026-04-26T03:00:00').getTime();
    const nowRef = { value: scheduled - 5 * 60 * 1000 };
    const { fsm, preflightHost } = fsmAtReady(nowRef);

    fsm.tick();
    expect(preflightHost.shown.length).toBe(1);

    // Another tick inside the same window — must NOT re-fire
    fsm.tick();
    expect(preflightHost.shown.length).toBe(1);
  });

  it('does NOT fire before the 5-minute window opens', () => {
    const scheduled = new Date('2026-04-26T03:00:00').getTime();
    const nowRef = { value: scheduled - 6 * 60 * 1000 };
    const { fsm, preflightHost } = fsmAtReady(nowRef);

    fsm.tick();
    expect(preflightHost.shown.length).toBe(0);
  });

  it('"Start now" advances scheduled full to now (next tick fires BACKUP_RUNNING full)', () => {
    const scheduled = new Date('2026-04-26T03:00:00').getTime();
    const nowRef = { value: scheduled - 5 * 60 * 1000 };
    const { fsm, preflightHost } = fsmAtReady(nowRef);

    fsm.tick();
    preflightHost.shown[0].onStartNow();

    fsm.tick();
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
    expect(fsm.getPendingBackup()).toEqual({ type: 'full', reason: 'scheduled' });
  });

  it('"Postpone 1h" advances scheduled by 1 hour; preflight re-fires before new time', () => {
    const scheduled = new Date('2026-04-26T03:00:00').getTime();
    const nowRef = { value: scheduled - 5 * 60 * 1000 };
    const { fsm, preflightHost } = fsmAtReady(nowRef);

    fsm.tick();
    expect(preflightHost.shown.length).toBe(1);
    preflightHost.shown[0].onPostpone1h();

    // At original scheduled time — should NOT fire backup (postponed)
    nowRef.value = scheduled;
    fsm.tick();
    expect(fsm.getState()).toBe('READY');

    // At (scheduled + 1h) - 5min — pre-flight re-fires
    nowRef.value = scheduled + 60 * 60 * 1000 - 5 * 60 * 1000;
    fsm.tick();
    expect(preflightHost.shown.length).toBe(2);
  });

  it('"Skip" marks this cycle as skipped; next scheduled is next cycle', () => {
    const scheduled = new Date('2026-04-26T03:00:00').getTime();
    const nextScheduled = new Date('2026-05-03T03:00:00').getTime();
    const nowRef = { value: scheduled - 5 * 60 * 1000 };
    const { fsm, preflightHost } = fsmAtReady(nowRef);

    fsm.tick();
    preflightHost.shown[0].onSkip();

    expect(fsm.getNextScheduledFullAt()).toBe(nextScheduled);
  });

  it('FSM always calls preflightHost in the window — notice gating lives in NoticeCenter, not FSM', () => {
    const scheduled = new Date('2026-04-26T03:00:00').getTime();
    const nowRef = { value: scheduled - 5 * 60 * 1000 };
    const { fsm, preflightHost } = fsmAtReady(nowRef);

    fsm.tick();
    expect(preflightHost.shown.length).toBe(1);
  });

  it('passes the scheduled timestamp to showPreflight so the host can render HH:MM', () => {
    const scheduled = new Date('2026-04-26T03:00:00').getTime();
    const nowRef = { value: scheduled - 5 * 60 * 1000 };
    const { fsm, preflightHost } = fsmAtReady(nowRef);

    fsm.tick();
    expect(preflightHost.shownAt[0]).toBe(scheduled);
  });

  it('dismisses the preflight after the full backup completes', () => {
    const scheduled = new Date('2026-04-26T03:00:00').getTime();
    const nowRef = { value: scheduled - 5 * 60 * 1000 };
    const { fsm, preflightHost } = fsmAtReady(nowRef);

    fsm.tick();
    preflightHost.shown[0].onStartNow();
    fsm.tick(); // → BACKUP_RUNNING (full / scheduled)
    expect(fsm.getState()).toBe('BACKUP_RUNNING');

    fsm.onBackupSuccess();
    expect(preflightHost.dismissCalls).toBe(1);
  });

  it('does NOT dismiss preflight when the completed backup was not a full', () => {
    // Show the preflight, then complete a non-full backup. The preflight
    // should still be visible because the full it warned about hasn't run.
    const scheduled = new Date('2026-04-26T03:00:00').getTime();
    const nowRef = { value: scheduled - 5 * 60 * 1000 };
    const { fsm, preflightHost } = fsmAtReady(nowRef);

    fsm.tick();
    expect(preflightHost.shown.length).toBe(1);

    // No pendingBackup (or an inc) → onBackupSuccess must not dismiss.
    fsm.onBackupSuccess();
    expect(preflightHost.dismissCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T7.2 — Scheduled full triggers BACKUP_RUNNING
// ---------------------------------------------------------------------------

describe('SchedulerFSM — scheduled full trigger', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('tick at or past scheduled full time → BACKUP_RUNNING with pending=full/scheduled', () => {
    const scheduled = new Date('2026-04-26T03:00:00').getTime();
    const h = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 },
      now: () => scheduled,
    });
    h.fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(h.fsm.getState()).toBe('READY');

    h.fsm.tick();
    expect(h.fsm.getState()).toBe('BACKUP_RUNNING');
    expect(h.fsm.getPendingBackup()).toEqual({ type: 'full', reason: 'scheduled' });
  });

  it('scheduled full takes priority over incremental when both are due', () => {
    const scheduled = new Date('2026-04-26T03:00:00').getTime();
    const h = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 },
      queueSize: 3,
      now: () => scheduled,
    });
    h.fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);
    h.setQueueSize(5); // inc also pending
    h.fsm.tick();
    expect(h.fsm.getPendingBackup()?.type).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// T7.2 — Catch-up on startup
// ---------------------------------------------------------------------------

describe('SchedulerFSM — recoverOnStartup catch-up', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('enqueues catch-up full when scheduled time passed while unloaded', () => {
    // lastFull was 10 days ago; schedule is weekly Sunday 03:00 — at least one
    // scheduled full has passed without being run.
    const now = new Date('2026-04-23T12:00:00').getTime();
    const lastFull = now - 10 * 24 * 3600 * 1000;
    const h = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 },
      lastFullCommitAt: lastFull,
      now: () => now,
    });

    h.fsm.recoverOnStartup();
    expect(h.fsm.hasPendingCatchup()).toBe(true);

    h.fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(h.fsm.getState()).toBe('READY');

    h.fsm.tick();
    expect(h.fsm.getState()).toBe('BACKUP_RUNNING');
    expect(h.fsm.getPendingBackup()).toEqual({ type: 'full', reason: 'catchup' });
  });

  it('multiple overdue scheduled fulls collapse to ONE catch-up', () => {
    const now = new Date('2026-04-23T12:00:00').getTime();
    const lastFull = now - 60 * 24 * 3600 * 1000; // 60 days ago — many cycles missed
    const h = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 },
      lastFullCommitAt: lastFull,
      now: () => now,
    });

    h.fsm.recoverOnStartup();
    h.fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);

    h.fsm.tick();
    expect(h.fsm.getPendingBackup()).toEqual({ type: 'full', reason: 'catchup' });

    // After success, no lingering catch-up — should go back to inc/idle logic.
    h.fsm.onBackupSuccess();
    expect(h.fsm.hasPendingCatchup()).toBe(false);
  });

  it('flags catch-up on fresh install (lastFull === null) — first FULL runs after grace+quiet', () => {
    // requirements.md User-Journey 5 — "10 minutes later, quiet-period
    // expires; first full backup runs silently". Without this catch-up, the
    // first FULL would wait until the next scheduled slot (up to a week),
    // contradicting the spec scenario.
    const h = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 },
      lastFullCommitAt: null,
    });
    h.fsm.recoverOnStartup();
    expect(h.fsm.hasPendingCatchup()).toBe(true);

    h.fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000); // grace + quiet (1 + 1 min)
    h.fsm.tick();
    expect(h.fsm.getState()).toBe('BACKUP_RUNNING');
    expect(h.fsm.getPendingBackup()).toEqual({ type: 'full', reason: 'catchup' });
  });

  it('does NOT flag catch-up when lastFull < one cadence cycle ago', () => {
    const now = new Date('2026-04-23T12:00:00').getTime();
    const lastFull = now - 3 * 24 * 3600 * 1000; // 3 days ago, weekly cadence
    const h = makeFSM({
      lastFullCommitAt: lastFull,
      now: () => now,
    });
    h.fsm.recoverOnStartup();
    expect(h.fsm.hasPendingCatchup()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T7.2 — Pending backup tracking
// ---------------------------------------------------------------------------

describe('SchedulerFSM — getPendingBackup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is null initially', () => {
    const { fsm } = makeFSM();
    expect(fsm.getPendingBackup()).toBeNull();
  });

  it('is {type:"inc"} when incremental triggers', () => {
    const h = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 },
    });
    h.fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);
    h.setQueueSize(3);
    h.fsm.tick();
    expect(h.fsm.getPendingBackup()).toEqual({ type: 'inc' });
  });

  it('is cleared after onBackupSuccess', () => {
    const h = makeFSM({
      schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 },
    });
    h.fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);
    h.setQueueSize(3);
    h.fsm.tick();
    expect(h.fsm.getPendingBackup()).not.toBeNull();
    h.fsm.onBackupSuccess();
    expect(h.fsm.getPendingBackup()).toBeNull();
  });

  // Satisfies unused-import lint for the PendingBackup type.
  it('type alias is exported', () => {
    const p: PendingBackup = { type: 'inc' };
    expect(p.type).toBe('inc');
  });
});

// ---------------------------------------------------------------------------
// T7.5 — triggerBackupNow (manual "Back up now")
// ---------------------------------------------------------------------------

describe('SchedulerFSM — triggerBackupNow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns "started" and transitions to BACKUP_RUNNING with pending=inc from LOADING', () => {
    const { fsm } = makeFSM();
    const result = fsm.triggerBackupNow();
    expect(result).toBe('started');
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
    expect(fsm.getPendingBackup()).toEqual({ type: 'inc' });
  });

  it('clears pending grace timer when bypassing GRACE', () => {
    const { fsm } = makeFSM();
    fsm.onLayoutReady();
    expect(fsm.getState()).toBe('GRACE');

    fsm.triggerBackupNow();
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
    // Advance past original grace window — must not transition to QUIET_WAIT.
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
  });

  it('returns "already_running" without transitioning', () => {
    const { fsm } = makeFSM();
    fsm.triggerBackupNow();
    expect(fsm.getState()).toBe('BACKUP_RUNNING');

    const result = fsm.triggerBackupNow();
    expect(result).toBe('already_running');
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
  });

  it('returns "not_designated" without transitioning', () => {
    const { fsm } = makeFSM({ designated: false });
    const result = fsm.triggerBackupNow();
    expect(result).toBe('not_designated');
    expect(fsm.getState()).not.toBe('BACKUP_RUNNING');
  });

  it('returns "auth_lost" when FSM is in AUTH_LOST', () => {
    const { fsm } = makeFSM();
    fsm.setAuthLost();
    const result = fsm.triggerBackupNow();
    expect(result).toBe('auth_lost');
    expect(fsm.getState()).toBe('AUTH_LOST');
  });

  it('returns "blocked" when FSM is in BLOCKED — manual trigger refuses to retry permanent errors', () => {
    const { fsm } = makeFSM({ designated: true });
    fsm.setBlocked('VAULT_ID_MISMATCH');
    const result = fsm.triggerBackupNow();
    expect(result).toBe('blocked');
    expect(fsm.getState()).toBe('BLOCKED');
  });
});

// ---------------------------------------------------------------------------
// Tests — BLOCKED (permanent-error lock)
// ---------------------------------------------------------------------------

describe('SchedulerFSM — BLOCKED', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('setBlocked from READY → BLOCKED', () => {
    const { fsm } = makeFSM();
    fsm.onLayoutReady();
    vi.advanceTimersByTime(10 * 60 * 1000); // GRACE
    vi.advanceTimersByTime(2 * 60 * 1000); // QUIET_WAIT → READY
    expect(fsm.getState()).toBe('READY');
    fsm.setBlocked('VAULT_ID_MISMATCH');
    expect(fsm.getState()).toBe('BLOCKED');
  });

  it('setBlocked from ERROR → BLOCKED — escalating a transient retry into a permanent block', () => {
    const { fsm } = makeFSM();
    fsm.onLayoutReady();
    vi.advanceTimersByTime(10 * 60 * 1000);
    vi.advanceTimersByTime(2 * 60 * 1000);
    fsm.triggerBackupNow();
    fsm.onBackupFailure();
    expect(fsm.getState()).toBe('ERROR');
    fsm.setBlocked('VAULT_META_CORRUPT');
    expect(fsm.getState()).toBe('BLOCKED');
  });

  it('setBlocked from BACKUP_RUNNING is a no-op — cannot interrupt an in-flight upload', () => {
    const { fsm } = makeFSM();
    fsm.onLayoutReady();
    vi.advanceTimersByTime(10 * 60 * 1000);
    vi.advanceTimersByTime(2 * 60 * 1000);
    fsm.triggerBackupNow();
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
    fsm.setBlocked('VAULT_ID_MISMATCH');
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
  });

  it('onBackupBlocked from BACKUP_RUNNING → BLOCKED — variant of onBackupFailure for permanent failures', () => {
    const { fsm } = makeFSM();
    fsm.onLayoutReady();
    vi.advanceTimersByTime(10 * 60 * 1000);
    vi.advanceTimersByTime(2 * 60 * 1000);
    fsm.triggerBackupNow();
    expect(fsm.getState()).toBe('BACKUP_RUNNING');
    fsm.onBackupBlocked('VAULT_ID_MISMATCH');
    expect(fsm.getState()).toBe('BLOCKED');
    expect(fsm.getPendingBackup()).toBeNull();
  });

  it('tick is a no-op while in BLOCKED — the central anti-loop guarantee', () => {
    const { fsm, setQueueSize } = makeFSM();
    fsm.onLayoutReady();
    vi.advanceTimersByTime(10 * 60 * 1000);
    vi.advanceTimersByTime(2 * 60 * 1000);
    fsm.setBlocked('VAULT_ID_MISMATCH');
    setQueueSize(5);
    fsm.tick();
    fsm.tick();
    fsm.tick();
    // Three ticks in BLOCKED produce zero re-entries into BACKUP_RUNNING.
    // This is the regression guard for the retry loop the user reported.
    expect(fsm.getState()).toBe('BLOCKED');
  });

  it('clearBlock from BLOCKED → READY', () => {
    const { fsm } = makeFSM();
    fsm.onLayoutReady();
    vi.advanceTimersByTime(10 * 60 * 1000);
    vi.advanceTimersByTime(2 * 60 * 1000);
    fsm.setBlocked('VAULT_ID_MISMATCH');
    expect(fsm.getState()).toBe('BLOCKED');
    fsm.clearBlock();
    expect(fsm.getState()).toBe('READY');
  });

  it('clearBlock from non-BLOCKED is a no-op', () => {
    const { fsm } = makeFSM();
    fsm.onLayoutReady();
    vi.advanceTimersByTime(10 * 60 * 1000);
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(fsm.getState()).toBe('READY');
    fsm.clearBlock();
    expect(fsm.getState()).toBe('READY');
  });

  it('logs a warn entry on setBlocked and an info entry on clearBlock', () => {
    const { fsm, logger } = makeFSM();
    fsm.onLayoutReady();
    vi.advanceTimersByTime(10 * 60 * 1000);
    vi.advanceTimersByTime(2 * 60 * 1000);
    fsm.setBlocked('VAULT_ID_MISMATCH');
    expect(logger.warn).toHaveBeenCalledWith('fsm_blocked', { reason: 'VAULT_ID_MISMATCH' });
    fsm.clearBlock();
    expect(logger.info).toHaveBeenCalledWith('fsm_block_cleared');
  });
});
