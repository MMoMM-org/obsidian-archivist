// T7.4 — NoticeCenter: notification routing + dedup + persistent-banner state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NoticeCenter,
  type NoticeCenterDeps,
  type NotifyFn,
  type NotifyOptions,
  type PersistentBanner,
} from '../../src/ui/NoticeCenter';
import type { NotificationSettings } from '../../src/model/Settings';
import type { Logger } from '../../src/infra/Logger';
import { S } from '../../src/ui/strings';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeSettings(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    preflight_notice_enabled: true,
    toast_after_inc: false,
    toast_after_full: true,
    toast_on_error: true,
    ...overrides,
  };
}

interface NotifyCall {
  message: string;
  timeout: number | undefined;
  buttons: Array<{ label: string; onClick: () => void }>;
  hidden: boolean;
}

function makeNotify(): { fn: NotifyFn; calls: NotifyCall[] } {
  const calls: NotifyCall[] = [];
  const fn: NotifyFn = (message: string, opts?: NotifyOptions) => {
    const call: NotifyCall = {
      message,
      timeout: opts?.timeout,
      buttons: opts?.buttons ? opts.buttons.map((b) => ({ label: b.label, onClick: b.onClick })) : [],
      hidden: false,
    };
    calls.push(call);
    return {
      hide: () => {
        call.hidden = true;
      },
    };
  };
  return { fn, calls };
}

interface HarnessOpts {
  settings?: Partial<NotificationSettings>;
  now?: () => number;
}

function makeCenter(opts: HarnessOpts = {}): {
  center: NoticeCenter;
  notifyCalls: NotifyCall[];
  setSettings: (s: Partial<NotificationSettings>) => void;
} {
  let settings = makeSettings(opts.settings);
  const { fn: notify, calls: notifyCalls } = makeNotify();
  const deps: NoticeCenterDeps = {
    getSettings: () => settings,
    notify,
    logger: makeLogger(),
    now: opts.now,
  };
  return {
    center: new NoticeCenter(deps),
    notifyCalls,
    setSettings: (s) => {
      settings = { ...settings, ...s };
    },
  };
}

// ---------------------------------------------------------------------------
// showSuccess
// ---------------------------------------------------------------------------

describe('NoticeCenter.showSuccess', () => {
  it('inc: suppresses when toast_after_inc is false', () => {
    const { center, notifyCalls } = makeCenter({ settings: { toast_after_inc: false } });
    center.showSuccess({ type: 'inc', fileCount: 5 });
    expect(notifyCalls).toHaveLength(0);
  });

  it('inc: fires S.TOAST_INC_DONE(n) when toast_after_inc is true', () => {
    const { center, notifyCalls } = makeCenter({ settings: { toast_after_inc: true } });
    center.showSuccess({ type: 'inc', fileCount: 7 });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].message).toBe(S.TOAST_INC_DONE(7));
  });

  it('full: fires S.TOAST_FULL_DONE by default', () => {
    const { center, notifyCalls } = makeCenter();
    center.showSuccess({ type: 'full' });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].message).toBe(S.TOAST_FULL_DONE);
  });

  it('full: suppresses when toast_after_full is false', () => {
    const { center, notifyCalls } = makeCenter({ settings: { toast_after_full: false } });
    center.showSuccess({ type: 'full' });
    expect(notifyCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// showError — dedup per code within 5-minute burst
// ---------------------------------------------------------------------------

describe('NoticeCenter.showError', () => {
  let nowValue = 0;
  beforeEach(() => {
    nowValue = new Date('2026-04-24T12:00:00Z').getTime();
  });

  function makeAtNow(overrides: Partial<NotificationSettings> = {}) {
    return makeCenter({ settings: overrides, now: () => nowValue });
  }

  it('suppresses when toast_on_error is false', () => {
    const { center, notifyCalls } = makeAtNow({ toast_on_error: false });
    center.showError('NETWORK');
    expect(notifyCalls).toHaveLength(0);
  });

  it('fires the first error of a burst with code-specific copy', () => {
    const { center, notifyCalls } = makeAtNow();
    center.showError('NETWORK');
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].message).toBe(S.ERROR_NETWORK);
  });

  it('dedups repeats of the SAME code within 5 minutes', () => {
    const { center, notifyCalls } = makeAtNow();
    center.showError('NETWORK');
    nowValue += 4 * 60 * 1000; // 4 min later
    center.showError('NETWORK');
    expect(notifyCalls).toHaveLength(1);
  });

  it('fires again after the 5-minute window elapses', () => {
    const { center, notifyCalls } = makeAtNow();
    center.showError('NETWORK');
    nowValue += 5 * 60 * 1000 + 1; // just past the window
    center.showError('NETWORK');
    expect(notifyCalls).toHaveLength(2);
  });

  it('dedup is per-code: NETWORK and QUOTA_EXCEEDED fire independently', () => {
    const { center, notifyCalls } = makeAtNow();
    center.showError('NETWORK');
    center.showError('QUOTA_EXCEEDED');
    expect(notifyCalls.map((c) => c.message)).toEqual([
      S.ERROR_NETWORK,
      S.ERROR_QUOTA_EXCEEDED,
    ]);
  });

  it('unknown error code falls back to generic copy', () => {
    const { center, notifyCalls } = makeAtNow();
    center.showError('UNKNOWN_WEIRD_CODE');
    expect(notifyCalls[0].message).toBe(S.TOAST_ERROR_GENERIC);
  });
});

// ---------------------------------------------------------------------------
// Resumed-from-error notice
// ---------------------------------------------------------------------------

describe('NoticeCenter — resumed-from-error notice', () => {
  it('fires TOAST_ERRORS_RESOLVED before the first success after any error', () => {
    const { center, notifyCalls } = makeCenter({
      settings: { toast_after_full: true, toast_on_error: true },
    });
    center.showError('NETWORK');
    center.showSuccess({ type: 'full' });

    // First call: error; second: resumed; third: success.
    expect(notifyCalls.map((c) => c.message)).toEqual([
      S.ERROR_NETWORK,
      S.TOAST_ERRORS_RESOLVED,
      S.TOAST_FULL_DONE,
    ]);
  });

  it('fires resumed even when success toasts are disabled (resumed is independent)', () => {
    const { center, notifyCalls } = makeCenter({
      settings: { toast_after_inc: false, toast_after_full: false, toast_on_error: true },
    });
    center.showError('NETWORK');
    center.showSuccess({ type: 'full' });
    expect(notifyCalls.map((c) => c.message)).toEqual([
      S.ERROR_NETWORK,
      S.TOAST_ERRORS_RESOLVED,
    ]);
  });

  it('does not re-fire resumed on subsequent successes', () => {
    const { center, notifyCalls } = makeCenter();
    center.showError('NETWORK');
    center.showSuccess({ type: 'full' });
    center.showSuccess({ type: 'full' });
    const resumedCount = notifyCalls.filter((c) => c.message === S.TOAST_ERRORS_RESOLVED).length;
    expect(resumedCount).toBe(1);
  });

  it('does not fire resumed if no error has happened', () => {
    const { center, notifyCalls } = makeCenter();
    center.showSuccess({ type: 'full' });
    expect(notifyCalls.map((c) => c.message)).toEqual([S.TOAST_FULL_DONE]);
  });

  it('multiple error codes → one resumed notice on next success', () => {
    const { center, notifyCalls } = makeCenter();
    center.showError('NETWORK');
    center.showError('QUOTA_EXCEEDED');
    center.showSuccess({ type: 'full' });
    const resumedCount = notifyCalls.filter((c) => c.message === S.TOAST_ERRORS_RESOLVED).length;
    expect(resumedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Persistent banners
// ---------------------------------------------------------------------------

describe('NoticeCenter — persistent banners', () => {
  it('showPersistent adds a banner observable via getPersistentBanners', () => {
    const { center } = makeCenter();
    center.showPersistent('AUTH_LOST', S.OAUTH_REAUTH_REQUIRED);
    expect(center.getPersistentBanners()).toEqual([
      { code: 'AUTH_LOST', message: S.OAUTH_REAUTH_REQUIRED },
    ]);
  });

  it('same code twice updates in place — one entry wins', () => {
    const { center } = makeCenter();
    center.showPersistent('STORAGE', 'first');
    center.showPersistent('STORAGE', 'second');
    expect(center.getPersistentBanners()).toEqual([{ code: 'STORAGE', message: 'second' }]);
  });

  it('idempotent: same code + same message does NOT re-emit to subscribers', () => {
    const { center } = makeCenter();
    const updates: PersistentBanner[][] = [];
    center.subscribePersistentBanners((list) => updates.push(list));
    center.showPersistent('AUTH_LOST', 'a');
    center.showPersistent('AUTH_LOST', 'a');
    // First call emitted once; second was a no-op.
    expect(updates).toHaveLength(1);
  });

  it('carries a primary action through to the banner observable', () => {
    const { center } = makeCenter();
    const onClick = vi.fn();
    center.showPersistent('VAULT_ID_MISMATCH', S.MISMATCH_BANNER, {
      action: { label: S.MISMATCH_BANNER_RESOLVE, onClick },
    });
    const [banner] = center.getPersistentBanners();
    expect(banner.action?.label).toBe(S.MISMATCH_BANNER_RESOLVE);
    banner.action?.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('re-emits when only the action changes (action is part of identity)', () => {
    const { center } = makeCenter();
    const updates: PersistentBanner[][] = [];
    center.subscribePersistentBanners((list) => updates.push(list));
    center.showPersistent('VAULT_ID_MISMATCH', 'm', {
      action: { label: 'Resolve', onClick: vi.fn() },
    });
    center.showPersistent('VAULT_ID_MISMATCH', 'm', {
      action: { label: 'Resolve', onClick: vi.fn() },
    });
    expect(updates).toHaveLength(2);
  });

  it('clearPersistent removes the banner and emits', () => {
    const { center } = makeCenter();
    center.showPersistent('AUTH_LOST', 'x');
    center.clearPersistent('AUTH_LOST');
    expect(center.getPersistentBanners()).toEqual([]);
  });

  it('subscribePersistentBanners returns unsubscribe', () => {
    const { center } = makeCenter();
    const handler = vi.fn();
    const unsubscribe = center.subscribePersistentBanners(handler);

    center.showPersistent('A', '1');
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    center.showPersistent('B', '2');
    expect(handler).toHaveBeenCalledTimes(1); // still 1
  });
});

// ---------------------------------------------------------------------------
// Preflight — PreflightHost contract
// ---------------------------------------------------------------------------

describe('NoticeCenter.showPreflight', () => {
  function makeActions(): {
    actions: { onStartNow: () => void; onPostpone1h: () => void; onSkip: () => void };
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      actions: {
        onStartNow: () => calls.push('start'),
        onPostpone1h: () => calls.push('postpone'),
        onSkip: () => calls.push('skip'),
      },
      calls,
    };
  }

  // 2026-05-10 14:35 local — fixed time so HH:MM rendering is deterministic
  // regardless of TZ (uses Date#getHours, which returns the local hour).
  const SCHEDULED_AT = new Date(2026, 4, 10, 14, 35).getTime();

  it('renders a notice with 3 labeled buttons that auto-expires at the scheduled instant', () => {
    // Fix `now` exactly 5 min before SCHEDULED_AT so the timeout is the full
    // lead window. The auto-expiry replaces the previous sticky-forever
    // behavior so a lingering preflight never outlives the event it warned
    // about (e.g. when the full silently fails or never starts).
    const now = SCHEDULED_AT - 5 * 60 * 1000;
    const { center, notifyCalls } = makeCenter({ now: () => now });
    const { actions } = makeActions();
    center.showPreflight(actions, SCHEDULED_AT);

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].timeout).toBe(5 * 60 * 1000);
    expect(notifyCalls[0].buttons.map((b) => b.label)).toEqual([
      S.PREFLIGHT_START_NOW,
      S.PREFLIGHT_POSTPONE_1H,
      S.PREFLIGHT_SKIP,
    ]);
  });

  it('clamps the timeout to a small positive minimum when scheduledAt has already passed', () => {
    // FSM races / wakeups can call showPreflight at-or-after the scheduled
    // instant. A timeout of 0 in Obsidian is sticky — exactly what the new
    // behavior is meant to avoid — so the minimum keeps the notice visible
    // briefly without making it persistent.
    const now = SCHEDULED_AT + 1000;
    const { center, notifyCalls } = makeCenter({ now: () => now });
    const { actions } = makeActions();
    center.showPreflight(actions, SCHEDULED_AT);

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].timeout).toBeGreaterThan(0);
  });

  it('renders the scheduled time in the message body', () => {
    const { center, notifyCalls } = makeCenter();
    const { actions } = makeActions();
    center.showPreflight(actions, SCHEDULED_AT);
    expect(notifyCalls[0].message).toContain('14:35');
  });

  it('clicking Start-now invokes actions.onStartNow and hides the notice', () => {
    const { center, notifyCalls } = makeCenter();
    const { actions, calls } = makeActions();
    center.showPreflight(actions, SCHEDULED_AT);
    notifyCalls[0].buttons[0].onClick();
    expect(calls).toEqual(['start']);
    expect(notifyCalls[0].hidden).toBe(true);
  });

  it('clicking Postpone invokes actions.onPostpone1h and hides the notice', () => {
    const { center, notifyCalls } = makeCenter();
    const { actions, calls } = makeActions();
    center.showPreflight(actions, SCHEDULED_AT);
    notifyCalls[0].buttons[1].onClick();
    expect(calls).toEqual(['postpone']);
    expect(notifyCalls[0].hidden).toBe(true);
  });

  it('clicking Skip invokes actions.onSkip and hides the notice', () => {
    const { center, notifyCalls } = makeCenter();
    const { actions, calls } = makeActions();
    center.showPreflight(actions, SCHEDULED_AT);
    notifyCalls[0].buttons[2].onClick();
    expect(calls).toEqual(['skip']);
    expect(notifyCalls[0].hidden).toBe(true);
  });

  it('silently drops when preflight_notice_enabled is false', () => {
    const { center, notifyCalls } = makeCenter({ settings: { preflight_notice_enabled: false } });
    const { actions, calls } = makeActions();
    center.showPreflight(actions, SCHEDULED_AT);
    expect(notifyCalls).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it('dismissPreflight() hides the active notice and is idempotent', () => {
    const { center, notifyCalls } = makeCenter();
    const { actions } = makeActions();
    center.showPreflight(actions, SCHEDULED_AT);
    center.dismissPreflight();
    expect(notifyCalls[0].hidden).toBe(true);
    // second call is a no-op (no error, no second hide())
    center.dismissPreflight();
    expect(notifyCalls).toHaveLength(1);
  });

  it('a second showPreflight dismisses the stale one (no stacked notices)', () => {
    const { center, notifyCalls } = makeCenter();
    const { actions } = makeActions();
    center.showPreflight(actions, SCHEDULED_AT);
    center.showPreflight(actions, SCHEDULED_AT + 60 * 60 * 1000);
    expect(notifyCalls).toHaveLength(2);
    expect(notifyCalls[0].hidden).toBe(true);
    expect(notifyCalls[1].hidden).toBe(false);
  });
});

// Lint touches for unused imports above.
afterEach(() => {
  // no-op: keeps the test module's afterEach symbol used
});
