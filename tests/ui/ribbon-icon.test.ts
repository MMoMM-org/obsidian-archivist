// T7.3 — RibbonIcon: state-driven icon / tooltip / aria / CSS class.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RibbonIcon,
  type RibbonHandle,
  type RibbonHost,
} from '../../src/ui/RibbonIcon';
import { SchedulerFSM, type SchedulerFSMDeps } from '../../src/services/SchedulerFSM';
import type { Logger } from '../../src/infra/Logger';
import type { ScheduleSettings } from '../../src/model/Settings';
import { S } from '../../src/ui/strings';

// ---------------------------------------------------------------------------
// Fakes
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

interface HandleState {
  icon: string;
  tooltip: string;
  aria: string;
  cssClass: string;
  destroyed: boolean;
  clickHandler: () => void;
}

function makeRibbonHost(): { host: RibbonHost; state: HandleState; createCalls: number } {
  const state: HandleState = {
    icon: '',
    tooltip: '',
    aria: '',
    cssClass: '',
    destroyed: false,
    clickHandler: () => {},
  };
  let createCalls = 0;
  const host: RibbonHost = {
    create(params) {
      createCalls += 1;
      state.icon = params.icon;
      state.clickHandler = params.onClick;
      const handle: RibbonHandle = {
        setIcon(icon) {
          state.icon = icon;
        },
        setTooltip(t) {
          state.tooltip = t;
        },
        setAriaLabel(a) {
          state.aria = a;
        },
        setCssClass(c) {
          state.cssClass = c;
        },
        destroy() {
          state.destroyed = true;
        },
      };
      return handle;
    },
  };
  return {
    host,
    state,
    get createCalls() {
      return createCalls;
    },
  } as { host: RibbonHost; state: HandleState; createCalls: number };
}

interface HarnessOpts {
  designated?: boolean;
  schedule?: Partial<ScheduleSettings>;
}

function makeFSM(opts: HarnessOpts = {}): SchedulerFSM {
  const designated = opts.designated ?? true;
  const deps: SchedulerFSMDeps = {
    schedule: makeSchedule(opts.schedule),
    isDesignated: () => designated,
    getQueueSize: () => 0,
    getLastIncCommitAt: () => null,
    getLastFullCommitAt: () => null,
    preflightHost: { showPreflight: () => {} },
    logger: makeLogger(),
  };
  return new SchedulerFSM(deps);
}

function makeRibbon(
  fsm: SchedulerFSM,
  onRibbonClick?: () => void,
): {
  ribbon: RibbonIcon;
  state: HandleState;
  host: { host: RibbonHost; state: HandleState; createCalls: number };
} {
  const host = makeRibbonHost();
  return {
    ribbon: new RibbonIcon({ host: host.host, fsm, onRibbonClick }),
    state: host.state,
    host,
  };
}

// ---------------------------------------------------------------------------
// Tests — mount / unmount
// ---------------------------------------------------------------------------

describe('RibbonIcon — mount / unmount', () => {
  it('mount creates a ribbon handle with archive-restore + RIBBON_LABEL', () => {
    const fsm = makeFSM();
    const { ribbon, state } = makeRibbon(fsm);
    ribbon.mount();
    expect(state.icon).toBe('archive-restore');
  });

  it('mount applies initial state (LOADING) tooltip + aria + class', () => {
    const fsm = makeFSM();
    const { ribbon, state } = makeRibbon(fsm);
    ribbon.mount();
    expect(state.tooltip).toBe(S.RIBBON_TOOLTIP_IDLE);
    expect(state.aria).toBe(S.RIBBON_ARIA_IDLE);
    expect(state.cssClass).toContain('archivist-muted');
  });

  it('mount is idempotent — second call does not create a second handle', () => {
    const fsm = makeFSM();
    const { ribbon, host } = makeRibbon(fsm);
    ribbon.mount();
    ribbon.mount();
    expect(host.createCalls).toBe(1);
  });

  it('unmount destroys the handle and unsubscribes from FSM', () => {
    const fsm = makeFSM();
    const { ribbon, state } = makeRibbon(fsm);
    ribbon.mount();
    ribbon.unmount();
    expect(state.destroyed).toBe(true);

    // After unmount, a state change must not propagate.
    const iconBeforeTransition = state.icon;
    fsm.onLayoutReady();
    expect(state.icon).toBe(iconBeforeTransition);
  });

  it('unmount is safe to call when not mounted', () => {
    const fsm = makeFSM();
    const { ribbon } = makeRibbon(fsm);
    expect(() => ribbon.unmount()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — onRibbonClick wiring
// ---------------------------------------------------------------------------

describe('RibbonIcon — click handler', () => {
  it('invokes onRibbonClick when the ribbon is clicked', () => {
    const onRibbonClick = vi.fn();
    const fsm = makeFSM();
    const { ribbon, host } = makeRibbon(fsm, onRibbonClick);
    ribbon.mount();
    host.state.clickHandler();
    expect(onRibbonClick).toHaveBeenCalledOnce();
  });

  it('click without onRibbonClick does not throw', () => {
    const fsm = makeFSM();
    const { ribbon, host } = makeRibbon(fsm);
    ribbon.mount();
    expect(() => host.state.clickHandler()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — per-state presentation matrix
// ---------------------------------------------------------------------------

describe('RibbonIcon — state matrix', () => {
  beforeEach(() => vi.useFakeTimers());

  it('GRACE: archive-restore + muted + grace tooltip + starting aria', () => {
    const fsm = makeFSM({ designated: true, schedule: { startup_grace_minutes: 10 } });
    const { ribbon, state } = makeRibbon(fsm);
    ribbon.mount();
    fsm.onLayoutReady();
    expect(state.icon).toBe('archive-restore');
    expect(state.cssClass).toContain('archivist-muted');
    expect(state.tooltip).toBe(S.RIBBON_TOOLTIP_GRACE);
    expect(state.aria).toBe(S.RIBBON_ARIA_STARTING);
  });

  it('QUIET_WAIT: muted + quiet-wait tooltip + waiting-quiet aria', () => {
    const fsm = makeFSM({ schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 2 } });
    const { ribbon, state } = makeRibbon(fsm);
    ribbon.mount();
    fsm.onLayoutReady();
    vi.advanceTimersByTime(1 * 60 * 1000);
    expect(state.icon).toBe('archive-restore');
    expect(state.cssClass).toContain('archivist-muted');
    expect(state.tooltip).toBe(S.RIBBON_TOOLTIP_QUIET_WAIT);
    expect(state.aria).toBe(S.RIBBON_ARIA_WAITING_QUIET);
  });

  it('READY: archive-restore + ready class', () => {
    const fsm = makeFSM({ schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 } });
    const { ribbon, state } = makeRibbon(fsm);
    ribbon.mount();
    fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(state.icon).toBe('archive-restore');
    expect(state.cssClass).toContain('archivist-ready');
    expect(state.aria).toBe(S.RIBBON_ARIA_READY);
  });

  it('BACKUP_RUNNING: icon swaps to history + pulse class', () => {
    const fsm = makeFSM({ schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 } });
    const { ribbon, state } = makeRibbon(fsm);
    ribbon.mount();
    fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);
    fsm.onBackupStarted();
    expect(state.icon).toBe('history');
    expect(state.cssClass).toContain('archivist-running');
    expect(state.cssClass).toContain('archivist-pulse');
    expect(state.tooltip).toBe(S.RIBBON_TOOLTIP_RUNNING);
    expect(state.aria).toBe(S.RIBBON_ARIA_RUNNING);
  });

  it('PASSIVE: archive-restore + passive class + paused tooltip', () => {
    const fsm = makeFSM({ designated: false });
    const { ribbon, state } = makeRibbon(fsm);
    ribbon.mount();
    fsm.onLayoutReady();
    expect(state.icon).toBe('archive-restore');
    expect(state.cssClass).toContain('archivist-passive');
    expect(state.tooltip).toBe(S.RIBBON_TOOLTIP_PAUSED);
    expect(state.aria).toBe(S.RIBBON_ARIA_PAUSED);
  });

  it('ERROR: archive-restore + error class + error tooltip', () => {
    const fsm = makeFSM({ schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 } });
    const { ribbon, state } = makeRibbon(fsm);
    ribbon.mount();
    fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);
    fsm.onBackupStarted();
    fsm.onBackupFailure();
    expect(state.icon).toBe('archive-restore');
    expect(state.cssClass).toContain('archivist-error');
    expect(state.tooltip).toBe(S.RIBBON_TOOLTIP_ERROR);
    expect(state.aria).toBe(S.RIBBON_ARIA_ERROR);
  });

  it('AUTH_LOST: error class + disconnected tooltip + auth-lost aria', () => {
    const fsm = makeFSM();
    const { ribbon, state } = makeRibbon(fsm);
    ribbon.mount();
    fsm.setAuthLost();
    expect(state.icon).toBe('archive-restore');
    expect(state.cssClass).toContain('archivist-error');
    expect(state.tooltip).toBe(S.RIBBON_TOOLTIP_DISCONNECTED);
    expect(state.aria).toBe(S.RIBBON_ARIA_AUTH_LOST);
  });

  it('pulse class is PRESENT only in BACKUP_RUNNING', () => {
    const fsm = makeFSM({ schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 } });
    const { ribbon, state } = makeRibbon(fsm);
    ribbon.mount();

    // Walk through several states and assert pulse is only on BACKUP_RUNNING.
    fsm.onLayoutReady(); // GRACE
    expect(state.cssClass).not.toContain('archivist-pulse');

    vi.advanceTimersByTime(1 * 60 * 1000); // QUIET_WAIT
    expect(state.cssClass).not.toContain('archivist-pulse');

    vi.advanceTimersByTime(1 * 60 * 1000); // READY
    expect(state.cssClass).not.toContain('archivist-pulse');

    fsm.onBackupStarted(); // BACKUP_RUNNING
    expect(state.cssClass).toContain('archivist-pulse');

    fsm.onBackupSuccess(); // back to READY
    expect(state.cssClass).not.toContain('archivist-pulse');
  });
});

// ---------------------------------------------------------------------------
// Tests — aria-label is carried in EVERY state (not just color)
// ---------------------------------------------------------------------------

describe('RibbonIcon — accessibility parity', () => {
  beforeEach(() => vi.useFakeTimers());

  it('every state sets an aria-label that names the state context', () => {
    const fsm = makeFSM({ schedule: { startup_grace_minutes: 1, quiet_after_event_minutes: 1 } });
    const { ribbon, state } = makeRibbon(fsm);
    ribbon.mount();

    // Collect aria labels across a sequence of transitions.
    const observed = new Set<string>();
    observed.add(state.aria);
    fsm.onLayoutReady();
    observed.add(state.aria);
    vi.advanceTimersByTime(1 * 60 * 1000);
    observed.add(state.aria);
    vi.advanceTimersByTime(1 * 60 * 1000);
    observed.add(state.aria);
    fsm.onBackupStarted();
    observed.add(state.aria);
    fsm.onBackupFailure();
    observed.add(state.aria);

    // Each of these aria strings is distinct — ensures we're not color-only.
    expect(observed.size).toBeGreaterThanOrEqual(5);
    for (const a of observed) {
      expect(a.toLowerCase()).toContain('archivist');
    }
  });
});
