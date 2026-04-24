// T7.12 — Phase 7 integration: Scheduler + NoticeCenter + Ribbon + Command
// + Predecessor all wired together, driven through one day of fake time.
//
// Covers the cross-module contract only — per-unit behaviour is already
// exhaustively tested in tests/services/*.test.ts and tests/ui/*.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SchedulerFSM,
  type FSMState,
  type SchedulerFSMDeps,
} from '../../src/services/SchedulerFSM';
import { NoticeCenter, type NotifyFn, type NotifyOptions } from '../../src/ui/NoticeCenter';
import { RibbonIcon, type RibbonHandle, type RibbonHost } from '../../src/ui/RibbonIcon';
import { registerBackupNowCommand } from '../../src/ui/Commands';
import { PredecessorDetector } from '../../src/services/PredecessorDetector';
import { DEFAULT_SETTINGS, type PluginSettings } from '../../src/model/Settings';
import type { Logger } from '../../src/infra/Logger';
import type { Command } from 'obsidian';
import { S } from '../../src/ui/strings';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface NotifyRecord {
  message: string;
  timeout: number | undefined;
  buttons: Array<{ label: string; onClick: () => void }>;
}

interface Harness {
  fsm: SchedulerFSM;
  noticeCenter: NoticeCenter;
  ribbon: RibbonIcon;
  ribbonState: { icon: string; tooltip: string; aria: string; cssClass: string; destroyed: boolean };
  predecessor: PredecessorDetector;
  backupNowCommand: Command;
  notifies: NotifyRecord[];
  enabledPlugins: Set<string>;
  predecessorDismissed: { value: boolean };
  settings: PluginSettings;
  designated: { value: boolean };
  queueSize: { value: number };
  lastIncCommitAt: { value: number | null };
  lastFullCommitAt: { value: number | null };
  nowRef: { value: number };
}

function makeHarness(nowMs: number): Harness {
  const nowRef = { value: nowMs };
  const designated = { value: true };
  const queueSize = { value: 0 };
  const lastIncCommitAt: { value: number | null } = { value: null };
  const lastFullCommitAt: { value: number | null } = { value: null };
  const settings: PluginSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  // Shrink grace + quiet for the integration test (we're not re-testing T7.1
  // timer semantics here — we're verifying cross-module wiring).
  settings.schedule.startup_grace_minutes = 1;
  settings.schedule.quiet_after_event_minutes = 1;

  const notifies: NotifyRecord[] = [];
  const notify: NotifyFn = (message, opts?: NotifyOptions) => {
    notifies.push({
      message,
      timeout: opts?.timeout,
      buttons: opts?.buttons
        ? opts.buttons.map((b) => ({ label: b.label, onClick: b.onClick }))
        : [],
    });
  };

  const noticeCenter = new NoticeCenter({
    getSettings: () => settings.notifications,
    notify,
    logger: makeLogger(),
    now: () => nowRef.value,
  });

  const fsmDeps: SchedulerFSMDeps = {
    schedule: settings.schedule,
    isDesignated: () => designated.value,
    getQueueSize: () => queueSize.value,
    getLastIncCommitAt: () => lastIncCommitAt.value,
    getLastFullCommitAt: () => lastFullCommitAt.value,
    preflightHost: noticeCenter,
    logger: makeLogger(),
    now: () => nowRef.value,
  };
  const fsm = new SchedulerFSM(fsmDeps);

  // Ribbon
  const ribbonState = {
    icon: '',
    tooltip: '',
    aria: '',
    cssClass: '',
    destroyed: false,
  };
  const ribbonHost: RibbonHost = {
    create(params) {
      ribbonState.icon = params.icon;
      const handle: RibbonHandle = {
        setIcon: (i) => {
          ribbonState.icon = i;
        },
        setTooltip: (t) => {
          ribbonState.tooltip = t;
        },
        setAriaLabel: (a) => {
          ribbonState.aria = a;
        },
        setCssClass: (c) => {
          ribbonState.cssClass = c;
        },
        destroy: () => {
          ribbonState.destroyed = true;
        },
      };
      return handle;
    },
  };
  const ribbon = new RibbonIcon({ host: ribbonHost, fsm });

  // Command
  let backupNowCommand: Command = { id: '', name: '' };
  registerBackupNowCommand({
    plugin: {
      addCommand: (c) => {
        backupNowCommand = c;
        return c;
      },
    },
    fsm,
    notify,
  });

  // Predecessor
  const enabledPlugins = new Set<string>();
  const predecessorDismissed = { value: false };
  const predecessor = new PredecessorDetector({
    app: { plugins: { enabledPlugins } },
    noticeCenter,
    isDismissed: () => predecessorDismissed.value,
    recordDismissed: async () => {
      predecessorDismissed.value = true;
    },
  });

  return {
    fsm,
    noticeCenter,
    ribbon,
    ribbonState,
    predecessor,
    backupNowCommand,
    notifies,
    enabledPlugins,
    predecessorDismissed,
    settings,
    designated,
    queueSize,
    lastIncCommitAt,
    lastFullCommitAt,
    nowRef,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase 7 integration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('startup → GRACE → QUIET_WAIT → READY drives matching ribbon updates', () => {
    const h = makeHarness(new Date('2026-04-23T12:00:00').getTime());
    h.ribbon.mount();
    expect(h.ribbonState.icon).toBe('archive-restore');

    h.fsm.onLayoutReady();
    expect(h.ribbonState.tooltip).toBe(S.RIBBON_TOOLTIP_GRACE);

    vi.advanceTimersByTime(1 * 60 * 1000);
    expect(h.ribbonState.tooltip).toBe(S.RIBBON_TOOLTIP_QUIET_WAIT);

    vi.advanceTimersByTime(1 * 60 * 1000);
    expect(h.fsm.getState()).toBe('READY');
    expect(h.ribbonState.cssClass).toContain('archivist-ready');
  });

  it('pre-flight notice fires at scheduled - 5 min; Start-now advances to BACKUP_RUNNING full', () => {
    const scheduled = new Date('2026-04-26T03:00:00').getTime();
    const h = makeHarness(scheduled - 5 * 60 * 1000);
    h.ribbon.mount();

    // Drive to READY (grace + quiet timers)
    h.fsm.onLayoutReady();
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(h.fsm.getState()).toBe('READY');

    // Tick → preflight window
    h.fsm.tick();
    const preflight = h.notifies.find((n) => n.buttons.length === 3);
    expect(preflight).toBeDefined();

    // Click "Start now" (first button)
    preflight!.buttons[0].onClick();
    h.fsm.tick();
    expect(h.fsm.getState()).toBe('BACKUP_RUNNING');
    expect(h.fsm.getPendingBackup()).toEqual({ type: 'full', reason: 'scheduled' });
    expect(h.ribbonState.icon).toBe('history');
    expect(h.ribbonState.cssClass).toContain('archivist-pulse');

    // Simulate successful completion
    h.fsm.onBackupSuccess();
    expect(h.fsm.getState()).toBe('READY');
    expect(h.ribbonState.cssClass).not.toContain('archivist-pulse');
  });

  it('error dedup + resumed notice flow', () => {
    const h = makeHarness(new Date('2026-04-23T12:00:00').getTime());
    // Two errors of the same code within 5 min → one notice
    h.noticeCenter.showError('NETWORK');
    h.noticeCenter.showError('NETWORK');
    const networkNotices = h.notifies.filter((n) => n.message === S.ERROR_NETWORK);
    expect(networkNotices).toHaveLength(1);

    // Then success → resumed notice + success toast
    h.noticeCenter.showSuccess({ type: 'full' });
    const resumed = h.notifies.filter((n) => n.message === S.TOAST_ERRORS_RESOLVED);
    expect(resumed).toHaveLength(1);
    const fullDone = h.notifies.filter((n) => n.message === S.TOAST_FULL_DONE);
    expect(fullDone).toHaveLength(1);
  });

  it('manual "Back up now" command drives BACKUP_RUNNING + updates the ribbon', () => {
    const h = makeHarness(new Date('2026-04-23T12:00:00').getTime());
    h.ribbon.mount();

    h.backupNowCommand.callback!();
    expect(h.fsm.getState()).toBe('BACKUP_RUNNING');
    expect(h.ribbonState.icon).toBe('history');
    expect(h.fsm.getPendingBackup()).toEqual({ type: 'inc' });
  });

  it('AUTH_LOST → ribbon reflects disconnected + manual trigger is gated', () => {
    const h = makeHarness(new Date('2026-04-23T12:00:00').getTime());
    h.ribbon.mount();

    h.fsm.setAuthLost();
    expect(h.ribbonState.tooltip).toBe(S.RIBBON_TOOLTIP_DISCONNECTED);
    expect(h.ribbonState.aria).toBe(S.RIBBON_ARIA_AUTH_LOST);

    h.backupNowCommand.callback!();
    // Manual trigger must not start backup; surfaces the reauth notice instead.
    expect(h.fsm.getState()).toBe('AUTH_LOST');
    expect(h.notifies.some((n) => n.message === S.OAUTH_REAUTH_REQUIRED)).toBe(true);
  });

  it('predecessor notice: detect → dismiss → persisted → cleared', async () => {
    const h = makeHarness(new Date('2026-04-23T12:00:00').getTime());
    h.enabledPlugins.add('obsidian-dropbox-backups');
    h.predecessor.check();

    const banners = h.noticeCenter.getPersistentBanners();
    expect(banners).toHaveLength(1);
    expect(banners[0].code).toBe('PREDECESSOR');

    await banners[0].onDismiss!();
    expect(h.predecessorDismissed.value).toBe(true);
    expect(h.noticeCenter.getPersistentBanners()).toHaveLength(0);

    // Second check after dismissal → still clear.
    h.predecessor.check();
    expect(h.noticeCenter.getPersistentBanners()).toHaveLength(0);
  });

  it('predecessor notice: auto-clears when predecessor plugin is later disabled', () => {
    const h = makeHarness(new Date('2026-04-23T12:00:00').getTime());
    h.enabledPlugins.add('obsidian-dropbox-backups');
    h.predecessor.check();
    expect(h.noticeCenter.getPersistentBanners()).toHaveLength(1);

    h.enabledPlugins.delete('obsidian-dropbox-backups');
    h.predecessor.check();
    expect(h.noticeCenter.getPersistentBanners()).toHaveLength(0);
  });

  it('one-day fake-time soak: multiple state transitions, preflight, inc, full, error+recovery', () => {
    const dayStart = new Date('2026-04-26T00:00:00').getTime(); // Sunday
    const h = makeHarness(dayStart);
    h.ribbon.mount();

    const transitions: FSMState[] = [];
    h.fsm.onStateChange((next) => transitions.push(next));

    // 00:00 layout-ready → GRACE
    h.fsm.onLayoutReady();

    // 00:02 → QUIET_WAIT → READY (1 min grace + 1 min quiet)
    h.nowRef.value = dayStart + 2 * 60 * 1000;
    vi.advanceTimersByTime(2 * 60 * 1000);

    // 02:55 → preflight window for 03:00 scheduled full
    h.nowRef.value = dayStart + (2 * 60 + 55) * 60 * 1000;
    h.fsm.tick();
    const preflight = h.notifies.find((n) => n.buttons.length === 3);
    expect(preflight).toBeDefined();

    // User clicks Start now
    preflight!.buttons[0].onClick();

    // 02:56 → tick picks up override → BACKUP_RUNNING full
    h.nowRef.value += 60 * 1000;
    h.fsm.tick();
    expect(h.fsm.getState()).toBe('BACKUP_RUNNING');
    expect(h.fsm.getPendingBackup()?.type).toBe('full');

    // Full backup succeeds
    h.lastFullCommitAt.value = h.nowRef.value;
    h.fsm.onBackupSuccess();
    expect(h.fsm.getState()).toBe('READY');

    // Vault edit → queue grows
    h.queueSize.value = 3;

    // 17 min later — inc interval elapsed → inc fires
    h.nowRef.value += 17 * 60 * 1000;
    h.fsm.tick();
    expect(h.fsm.getPendingBackup()).toEqual({ type: 'inc' });

    // Inc fails → ERROR state
    h.fsm.onBackupFailure();
    h.noticeCenter.showError('NETWORK');
    expect(h.fsm.getState()).toBe('ERROR');

    // Next tick — retry fires (ERROR is a tickable state)
    h.nowRef.value += 16 * 60 * 1000;
    h.fsm.tick();
    expect(h.fsm.getState()).toBe('BACKUP_RUNNING');

    // Success this time → resumed notice
    h.lastIncCommitAt.value = h.nowRef.value;
    h.fsm.onBackupSuccess();
    h.noticeCenter.showSuccess({ type: 'full' });
    expect(h.notifies.some((n) => n.message === S.TOAST_ERRORS_RESOLVED)).toBe(true);

    // Ribbon must be back to ready state
    expect(h.ribbonState.cssClass).toContain('archivist-ready');
    expect(h.ribbonState.cssClass).not.toContain('archivist-pulse');

    // Transition log includes every expected phase
    expect(transitions).toContain('GRACE');
    expect(transitions).toContain('QUIET_WAIT');
    expect(transitions).toContain('READY');
    expect(transitions).toContain('BACKUP_RUNNING');
    expect(transitions).toContain('ERROR');
  });

  it('onunload cleans up: ribbon destroyed, FSM timers cleared', () => {
    const h = makeHarness(new Date('2026-04-23T12:00:00').getTime());
    h.ribbon.mount();
    h.fsm.onLayoutReady();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    h.ribbon.unmount();
    h.fsm.onunload();
    expect(h.ribbonState.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
