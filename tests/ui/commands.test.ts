// T7.5 — registerBackupNowCommand: Obsidian command palette integration.

import { describe, expect, it, vi } from 'vitest';
import {
  registerBackupNowCommand,
  registerRepairCommands,
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

// ---------------------------------------------------------------------------
// registerRepairCommands — three user-facing recovery commands. Tests cover
// success-toast routing for each command + the failure path. (H4)
// ---------------------------------------------------------------------------

describe('registerRepairCommands', () => {
  type RepairKind =
    | { command: 'rebuild'; result: { kept: string[]; phantomsRemoved: string[]; invalidManifests: string[] } }
    | { command: 'rebuild'; throws: Error }
    | { command: 'gc'; result: {
        state: 'swept' | 'skipped_locked' | 'skipped_no_index';
        deleted?: string[];
        kept_count?: number;
        skipped_age_gate?: number;
        blocking_lock?: { age_ms: number };
      } }
    | { command: 'gc'; throws: Error }
    | { command: 'clear'; cleared: boolean }
    | { command: 'clear'; throws: Error };

  function makeRepair(...behaviours: RepairKind[]): {
    rebuildSnapshotIndex: ReturnType<typeof vi.fn>;
    gcOrphanContent: ReturnType<typeof vi.fn>;
    clearGcLock: ReturnType<typeof vi.fn>;
  } {
    const rebuild = behaviours.find((b) => b.command === 'rebuild');
    const gc = behaviours.find((b) => b.command === 'gc');
    const clear = behaviours.find((b) => b.command === 'clear');
    return {
      rebuildSnapshotIndex: vi.fn(async () => {
        if (!rebuild) throw new Error('rebuildSnapshotIndex not stubbed');
        if ('throws' in rebuild) throw rebuild.throws;
        return rebuild.result;
      }),
      gcOrphanContent: vi.fn(async () => {
        if (!gc) throw new Error('gcOrphanContent not stubbed');
        if ('throws' in gc) throw gc.throws;
        return {
          state: gc.result.state,
          deleted: gc.result.deleted ?? [],
          kept_count: gc.result.kept_count ?? 0,
          skipped_age_gate: gc.result.skipped_age_gate ?? 0,
          blocking_lock: gc.result.blocking_lock,
        };
      }),
      clearGcLock: vi.fn(async () => {
        if (!clear) throw new Error('clearGcLock not stubbed');
        if ('throws' in clear) throw clear.throws;
        return clear.cleared;
      }),
    };
  }

  it('registers all three repair commands with their declared ids', () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify } = makeNotify();
    registerRepairCommands({
      plugin,
      repair: makeRepair() as never,
      notify,
      logger: makeLogger(),
    });
    expect(captured.byId.has('archivist-repair-backup-index')).toBe(true);
    expect(captured.byId.has('archivist-gc-orphan-content')).toBe(true);
    expect(captured.byId.has('archivist-clear-gc-lock')).toBe(true);
  });

  it('uses jargon-free user-facing labels (M17)', () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify } = makeNotify();
    registerRepairCommands({
      plugin,
      repair: makeRepair() as never,
      notify,
      logger: makeLogger(),
    });
    // Command IDs stay stable (COMPAT-003) so user hotkeys are
    // preserved, but the user-visible names are no longer
    // jargon-laden ("GC", "garbage collect", "orphan content").
    expect(captured.byId.get('archivist-gc-orphan-content')!.name).toBe(
      'Archivist: Remove unused backup blobs',
    );
    expect(captured.byId.get('archivist-clear-gc-lock')!.name).toBe(
      'Archivist: Clear stuck garbage-collection lock',
    );
  });

  // -------------------------------------------------------------------------
  // archivist-repair-backup-index
  // -------------------------------------------------------------------------

  it('repair-index: success surfaces the OK toast with kept/removed/invalid counts', async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerRepairCommands({
      plugin,
      repair: makeRepair({
        command: 'rebuild',
        result: {
          kept: ['s1', 's2', 's3'],
          phantomsRemoved: ['p1'],
          invalidManifests: ['/path/i1'],
        },
      }) as never,
      notify,
      logger: makeLogger(),
    });
    await captured.byId.get('archivist-repair-backup-index')!.callback!();
    expect(calls.some((c) => c.message === S.REPAIR_INDEX_RUNNING)).toBe(true);
    expect(calls.some((c) => c.message === S.REPAIR_INDEX_OK(3, 1, 1))).toBe(true);
  });

  it('repair-index: failure surfaces the FAILED toast with the error message', async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerRepairCommands({
      plugin,
      repair: makeRepair({
        command: 'rebuild',
        throws: new Error('network down'),
      }) as never,
      notify,
      logger: makeLogger(),
    });
    await captured.byId.get('archivist-repair-backup-index')!.callback!();
    expect(calls.some((c) => c.message === S.REPAIR_INDEX_FAILED('network down'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // archivist-gc-orphan-content
  // -------------------------------------------------------------------------

  it('gc: swept state surfaces the swept toast with deleted/kept/age-gated counts', async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerRepairCommands({
      plugin,
      repair: makeRepair({
        command: 'gc',
        result: { state: 'swept', deleted: ['a', 'b'], kept_count: 7, skipped_age_gate: 3 },
      }) as never,
      notify,
      logger: makeLogger(),
    });
    await captured.byId.get('archivist-gc-orphan-content')!.callback!();
    expect(calls.some((c) => c.message === S.GC_OK_SWEPT(2, 7, 3))).toBe(true);
  });

  it('gc: skipped_no_index surfaces the no-index toast (M13 + GC_OK_NO_INDEX route)', async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerRepairCommands({
      plugin,
      repair: makeRepair({
        command: 'gc',
        result: { state: 'skipped_no_index' },
      }) as never,
      notify,
      logger: makeLogger(),
    });
    await captured.byId.get('archivist-gc-orphan-content')!.callback!();
    expect(calls.some((c) => c.message === S.GC_OK_NO_INDEX)).toBe(true);
  });

  it('gc: skipped_locked surfaces the locked toast with rounded age in minutes', async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerRepairCommands({
      plugin,
      repair: makeRepair({
        command: 'gc',
        result: { state: 'skipped_locked', blocking_lock: { age_ms: 12 * 60 * 1000 } },
      }) as never,
      notify,
      logger: makeLogger(),
    });
    await captured.byId.get('archivist-gc-orphan-content')!.callback!();
    expect(calls.some((c) => c.message === S.GC_OK_LOCKED(12))).toBe(true);
  });

  it('gc: failure surfaces the GC_FAILED toast', async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerRepairCommands({
      plugin,
      repair: makeRepair({
        command: 'gc',
        throws: new Error('lock contention'),
      }) as never,
      notify,
      logger: makeLogger(),
    });
    await captured.byId.get('archivist-gc-orphan-content')!.callback!();
    expect(calls.some((c) => c.message === S.GC_FAILED('lock contention'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // archivist-clear-gc-lock
  // -------------------------------------------------------------------------

  it('clear-gc-lock: surfaces the cleared toast when a lock was deleted', async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerRepairCommands({
      plugin,
      repair: makeRepair({ command: 'clear', cleared: true }) as never,
      notify,
      logger: makeLogger(),
    });
    await captured.byId.get('archivist-clear-gc-lock')!.callback!();
    expect(calls.some((c) => c.message === S.GC_LOCK_CLEARED)).toBe(true);
  });

  it('clear-gc-lock: surfaces the no-lock toast when nothing to clear', async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerRepairCommands({
      plugin,
      repair: makeRepair({ command: 'clear', cleared: false }) as never,
      notify,
      logger: makeLogger(),
    });
    await captured.byId.get('archivist-clear-gc-lock')!.callback!();
    expect(calls.some((c) => c.message === S.GC_LOCK_CLEAR_NONE)).toBe(true);
  });

  it('clear-gc-lock: failure surfaces the FAILED toast', async () => {
    const { plugin, captured } = makePluginStub();
    const { fn: notify, calls } = makeNotify();
    registerRepairCommands({
      plugin,
      repair: makeRepair({
        command: 'clear',
        throws: new Error('insufficient permissions'),
      }) as never,
      notify,
      logger: makeLogger(),
    });
    await captured.byId.get('archivist-clear-gc-lock')!.callback!();
    expect(calls.some((c) => c.message === S.GC_LOCK_CLEAR_FAILED('insufficient permissions'))).toBe(true);
  });
});
