// T7.5 — registerBackupNowCommand: Obsidian command palette integration.

import { describe, expect, it, vi } from 'vitest';
import {
  registerBackupNowCommand,
  registerVerifyVaultOwnershipCommand,
} from '../../src/ui/Commands';
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
    getEarliestPendingObservedAt: () => null,
    preflightHost: { showPreflight: () => {} },
    logger: makeLogger(),
  };
  return new SchedulerFSM(deps);
}

interface CapturedCommand {
  /** Last-registered command (legacy single-command test ergonomics). */
  command: Command | null;
  /** All registered commands — registerBackupNowCommand now wires inc + full. */
  byId: Map<string, Command>;
}

function makePluginStub(): {
  plugin: { addCommand: (c: Command) => Command };
  captured: CapturedCommand;
} {
  const captured: CapturedCommand = { command: null, byId: new Map() };
  return {
    plugin: {
      addCommand: (c) => {
        captured.command = c;
        captured.byId.set(c.id, c);
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
  it('registers both inc and full commands with their respective display names', () => {
    const fsm = makeFSM();
    const { plugin, captured } = makePluginStub();
    const { fn: notify } = makeNotify();

    registerBackupNowCommand({ plugin, fsm, notify });

    const inc = captured.byId.get('archivist-backup-now');
    const full = captured.byId.get('archivist-full-backup-now');
    expect(inc).toBeDefined();
    expect(full).toBeDefined();
    expect(inc!.name).toBe(S.CMD_BACKUP_NOW);
    expect(full!.name).toBe(S.CMD_FULL_BACKUP_NOW);
    expect(typeof inc!.callback).toBe('function');
    expect(typeof full!.callback).toBe('function');
  });

  it('invoking the inc command from READY starts an incremental backup (transition to BACKUP_RUNNING)', () => {
    const fsm = makeFSM();
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls: notifyCalls } = makeNotify();

    registerBackupNowCommand({ plugin, fsm, notify });
    captured.byId.get('archivist-backup-now')!.callback!();

    expect(fsm.getState()).toBe('BACKUP_RUNNING');
    expect(fsm.getPendingBackup()).toEqual({ type: 'inc' });
    expect(notifyCalls).toHaveLength(0);
  });

  it('invoking the full command from READY starts a full backup', () => {
    const fsm = makeFSM();
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls: notifyCalls } = makeNotify();

    registerBackupNowCommand({ plugin, fsm, notify });
    captured.byId.get('archivist-full-backup-now')!.callback!();

    expect(fsm.getState()).toBe('BACKUP_RUNNING');
    expect(fsm.getPendingBackup()).toEqual({ type: 'full', reason: 'scheduled' });
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

// ---------------------------------------------------------------------------
// registerVerifyVaultOwnershipCommand — on-demand consistency probe
// ---------------------------------------------------------------------------

describe('registerVerifyVaultOwnershipCommand', () => {
  function makeIdentity(state:
    | { kind: 'ok'; remoteName: string }
    | { kind: 'fresh-folder' }
    | { kind: 'adopt-remote'; remoteName: string }
    | { kind: 'mismatch'; remoteName: string }
    | { kind: 'remote-corrupt' }
    | { kind: 'throws'; error: Error }
  ) {
    return {
      checkConsistency: vi.fn(async () => {
        switch (state.kind) {
          case 'ok':
            return { kind: 'ok', localId: 'L', remote: { vault_id: 'L', vault_name: state.remoteName } };
          case 'fresh-folder':
            return { kind: 'fresh-folder', localId: 'L' };
          case 'adopt-remote':
            return { kind: 'adopt-remote', remote: { vault_id: 'R', vault_name: state.remoteName } };
          case 'mismatch':
            return { kind: 'mismatch', localId: 'L', remote: { vault_id: 'R', vault_name: state.remoteName } };
          case 'remote-corrupt':
            return { kind: 'remote-corrupt', localId: 'L', rawError: 'bad' };
          case 'throws':
            throw state.error;
        }
      }),
    };
  }

  it("'ok' state surfaces the OK toast naming the remote vault", async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerVerifyVaultOwnershipCommand({
      plugin,
      vaultIdentity: makeIdentity({ kind: 'ok', remoteName: 'TestVault' }) as never,
      notify,
      logger: makeLogger() as never,
    });
    await captured.byId.get('archivist-verify-vault-ownership')!.callback!();
    expect(calls.some((c) => c.message === S.VERIFY_OWNERSHIP_OK('TestVault'))).toBe(true);
  });

  it("'fresh-folder' state surfaces the empty-folder toast", async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerVerifyVaultOwnershipCommand({
      plugin,
      vaultIdentity: makeIdentity({ kind: 'fresh-folder' }) as never,
      notify,
      logger: makeLogger() as never,
    });
    await captured.byId.get('archivist-verify-vault-ownership')!.callback!();
    expect(calls.some((c) => c.message === S.VERIFY_OWNERSHIP_FRESH_FOLDER)).toBe(true);
  });

  it("'mismatch' surfaces the blocked toast with the remote vault name", async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerVerifyVaultOwnershipCommand({
      plugin,
      vaultIdentity: makeIdentity({ kind: 'mismatch', remoteName: 'OtherVault' }) as never,
      notify,
      logger: makeLogger() as never,
    });
    await captured.byId.get('archivist-verify-vault-ownership')!.callback!();
    expect(calls.some((c) => c.message === S.VERIFY_OWNERSHIP_MISMATCH('OtherVault'))).toBe(true);
  });

  it("'adopt-remote' surfaces the adopt-needed toast", async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerVerifyVaultOwnershipCommand({
      plugin,
      vaultIdentity: makeIdentity({ kind: 'adopt-remote', remoteName: 'OtherVault' }) as never,
      notify,
      logger: makeLogger() as never,
    });
    await captured.byId.get('archivist-verify-vault-ownership')!.callback!();
    expect(calls.some((c) => c.message === S.VERIFY_OWNERSHIP_ADOPT_NEEDED('OtherVault'))).toBe(true);
  });

  it("'remote-corrupt' surfaces the corrupt-meta toast", async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerVerifyVaultOwnershipCommand({
      plugin,
      vaultIdentity: makeIdentity({ kind: 'remote-corrupt' }) as never,
      notify,
      logger: makeLogger() as never,
    });
    await captured.byId.get('archivist-verify-vault-ownership')!.callback!();
    expect(calls.some((c) => c.message === S.VERIFY_OWNERSHIP_REMOTE_CORRUPT)).toBe(true);
  });

  it('thrown error from checkConsistency is surfaced via the failure toast', async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerVerifyVaultOwnershipCommand({
      plugin,
      vaultIdentity: makeIdentity({ kind: 'throws', error: new Error('network down') }) as never,
      notify,
      logger: makeLogger() as never,
    });
    await captured.byId.get('archivist-verify-vault-ownership')!.callback!();
    expect(calls.some((c) => c.message === S.VERIFY_OWNERSHIP_FAILED('network down'))).toBe(true);
  });
});
