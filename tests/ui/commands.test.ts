// T7.5 — registerBackupNowCommand: Obsidian command palette integration.

import { describe, expect, it, vi } from 'vitest';
import { registerBackupNowCommand } from '../../src/ui/Commands';
import {
  SchedulerFSM,
  type SchedulerFSMDeps,
} from '../../src/services/SchedulerFSM';
import type { NotifyFn, NotifyOptions } from '../../src/ui/NoticeCenter';
import type { Logger } from '../../src/infra/Logger';
import type { ScheduleSettings } from '../../src/model/Settings';
import type { Command } from 'obsidian';
import { S } from '../../src/ui/strings';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeSchedule(): ScheduleSettings {
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
  };
}

function makeFSM(designated = true): SchedulerFSM {
  const deps: SchedulerFSMDeps = {
    schedule: makeSchedule(),
    isDesignated: () => designated,
    getQueueSize: () => 0,
    getLastIncCommitAt: () => null,
    getLastFullCommitAt: () => null,
    preflightHost: { showPreflight: () => {} },
    logger: makeLogger(),
  };
  return new SchedulerFSM(deps);
}

interface CapturedCommand {
  command: Command | null;
}

function makePluginStub(): {
  plugin: { addCommand: (c: Command) => Command };
  captured: CapturedCommand;
} {
  const captured: CapturedCommand = { command: null };
  return {
    plugin: {
      addCommand: (c) => {
        captured.command = c;
        return c;
      },
    },
    captured,
  };
}

interface NotifyCall {
  message: string;
  timeout: number | undefined;
}

function makeNotify(): { fn: NotifyFn; calls: NotifyCall[] } {
  const calls: NotifyCall[] = [];
  const fn: NotifyFn = (message: string, opts?: NotifyOptions) => {
    calls.push({ message, timeout: opts?.timeout });
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerBackupNowCommand', () => {
  it('registers a command with S.CMD_BACKUP_NOW as the display name', () => {
    const fsm = makeFSM();
    const { plugin, captured } = makePluginStub();
    const { fn: notify } = makeNotify();

    registerBackupNowCommand({ plugin, fsm, notify });

    expect(captured.command).not.toBeNull();
    expect(captured.command!.id).toBe('archivist-backup-now');
    expect(captured.command!.name).toBe(S.CMD_BACKUP_NOW);
    expect(typeof captured.command!.callback).toBe('function');
  });

  it('invoking the command from READY starts an incremental backup (transition to BACKUP_RUNNING)', () => {
    const fsm = makeFSM();
    // Drive FSM to READY via layout-ready + timers skipped via direct calls.
    // Manual trigger bypasses GRACE/QUIET_WAIT, so starting from LOADING works.
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls: notifyCalls } = makeNotify();

    registerBackupNowCommand({ plugin, fsm, notify });
    captured.command!.callback!();

    expect(fsm.getState()).toBe('BACKUP_RUNNING');
    expect(fsm.getPendingBackup()).toEqual({ type: 'inc' });
    expect(notifyCalls).toHaveLength(0);
  });

  it('invoking while already BACKUP_RUNNING shows BACKUP_NOW_IN_PROGRESS', () => {
    const fsm = makeFSM();
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls: notifyCalls } = makeNotify();

    registerBackupNowCommand({ plugin, fsm, notify });
    captured.command!.callback!(); // first invoke — starts
    captured.command!.callback!(); // second invoke — already running

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].message).toBe(S.BACKUP_NOW_IN_PROGRESS);
  });

  it('invoking when !designated shows BACKUP_NOW_NOT_DESIGNATED', () => {
    const fsm = makeFSM(false);
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls: notifyCalls } = makeNotify();

    registerBackupNowCommand({ plugin, fsm, notify });
    captured.command!.callback!();

    expect(fsm.getState()).not.toBe('BACKUP_RUNNING');
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].message).toBe(S.BACKUP_NOW_NOT_DESIGNATED);
  });

  it('invoking when AUTH_LOST shows OAUTH_REAUTH_REQUIRED', () => {
    const fsm = makeFSM();
    fsm.setAuthLost();
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls: notifyCalls } = makeNotify();

    registerBackupNowCommand({ plugin, fsm, notify });
    captured.command!.callback!();

    expect(fsm.getState()).toBe('AUTH_LOST');
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].message).toBe(S.OAUTH_REAUTH_REQUIRED);
  });
});
