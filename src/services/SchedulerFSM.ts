// SchedulerFSM — finite state machine driving backup cadence (T7.1).
//
// State diagram (SDD §Cross-Cutting/UI Visualization Guide):
//   LOADING ──(onLayoutReady + designated)─────→ GRACE
//   LOADING ──(onLayoutReady + !designated)────→ PASSIVE        (ROB-013)
//   GRACE   ──(startup_grace_minutes elapsed)──→ QUIET_WAIT
//   QUIET_WAIT ──(vault event)─────────────────→ QUIET_WAIT     (timer reset)
//   QUIET_WAIT ──(quiet_after_event_minutes)───→ READY
//   READY   ──(tick + interval + queue + desig)→ BACKUP_RUNNING
//   BACKUP_RUNNING ──(onBackupSuccess)─────────→ READY
//   BACKUP_RUNNING ──(onBackupFailure)─────────→ ERROR
//   ERROR   ──(tick + interval + queue + desig)→ BACKUP_RUNNING
//   * (not BACKUP_RUNNING) + setDesignated(false) → PASSIVE
//   PASSIVE + setDesignated(true) ─────────────→ READY
//   *       + setAuthLost()   ─────────────────→ AUTH_LOST
//   AUTH_LOST + setAuthRestored() ─────────────→ READY
//
// Design invariants:
//   - FSM never calls Dropbox directly. It emits BACKUP_RUNNING via the state
//     observer; callers kick off BackupService and report outcome via
//     onBackupSuccess / onBackupFailure.
//   - Ticks in GRACE / QUIET_WAIT / BACKUP_RUNNING / PASSIVE / AUTH_LOST are
//     no-ops. ERROR is NOT in that no-op list — a failed backup should be
//     retried on the next tick if the interval is due.
//   - All timers are cleared on onunload (ROB-005 / plan §T7.1).

import type { ScheduleSettings } from '../model/Settings';
import type { Logger } from '../infra/Logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FSMState =
  | 'LOADING'
  | 'GRACE'
  | 'QUIET_WAIT'
  | 'READY'
  | 'BACKUP_RUNNING'
  | 'PASSIVE'
  | 'ERROR'
  | 'AUTH_LOST';

export type StateChangeHandler = (next: FSMState, prev: FSMState) => void;

export type TimerHandle = ReturnType<typeof setTimeout>;
export type SetTimeoutFn = (handler: () => void, ms: number) => TimerHandle;
export type ClearTimeoutFn = (handle: TimerHandle) => void;

export interface SchedulerFSMDeps {
  schedule: Pick<
    ScheduleSettings,
    'startup_grace_minutes' | 'quiet_after_event_minutes' | 'inc_interval_minutes'
  >;
  isDesignated: () => boolean;
  getQueueSize: () => number;
  getLastIncCommitAt: () => number | null;
  logger: Logger;
  /** Injectable for tests — defaults to Date.now(). */
  now?: () => number;
  /**
   * Timer functions. Production should pass `activeWindow.setTimeout` bound
   * to `activeWindow` (obsidianmd/prefer-active-window-timers — popout
   * compatibility). Tests leave these undefined and drive via vi.useFakeTimers().
   */
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
}

// ---------------------------------------------------------------------------
// SchedulerFSM
// ---------------------------------------------------------------------------

export class SchedulerFSM {
  private state: FSMState = 'LOADING';
  private graceTimer: TimerHandle | null = null;
  private quietTimer: TimerHandle | null = null;
  private subscribers: StateChangeHandler[] = [];
  private readonly now: () => number;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;

  constructor(private readonly deps: SchedulerFSMDeps) {
    this.now = deps.now ?? ((): number => Date.now());
    // eslint-disable-next-line obsidianmd/prefer-active-window-timers
    this.setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    // eslint-disable-next-line obsidianmd/prefer-active-window-timers
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getState(): FSMState {
    return this.state;
  }

  onStateChange(handler: StateChangeHandler): () => void {
    this.subscribers.push(handler);
    return (): void => {
      this.subscribers = this.subscribers.filter((s) => s !== handler);
    };
  }

  onLayoutReady(): void {
    if (this.state !== 'LOADING') return;
    if (!this.deps.isDesignated()) {
      // ROB-013: skip GRACE + QUIET_WAIT entirely on an undesignated device.
      this.transition('PASSIVE');
      return;
    }
    this.enterGrace();
  }

  onVaultEvent(): void {
    if (this.state === 'QUIET_WAIT') this.resetQuietTimer();
  }

  setDesignated(designated: boolean): void {
    // Cannot interrupt an in-flight upload.
    if (this.state === 'BACKUP_RUNNING') return;

    if (!designated) {
      this.clearTimers();
      if (this.state !== 'PASSIVE') this.transition('PASSIVE');
      return;
    }
    // designated = true
    if (this.state === 'PASSIVE') this.transition('READY');
  }

  setAuthLost(): void {
    this.clearTimers();
    if (this.state !== 'AUTH_LOST') this.transition('AUTH_LOST');
  }

  setAuthRestored(): void {
    if (this.state === 'AUTH_LOST') this.transition('READY');
  }

  onBackupStarted(): void {
    if (this.state === 'READY' || this.state === 'ERROR') this.transition('BACKUP_RUNNING');
  }

  onBackupSuccess(): void {
    if (this.state === 'BACKUP_RUNNING') this.transition('READY');
  }

  onBackupFailure(): void {
    if (this.state === 'BACKUP_RUNNING') this.transition('ERROR');
  }

  /**
   * Wall-clock tick. Called externally (production: registered via
   * plugin.registerInterval(setInterval(tick, 60_000)); tests: invoked
   * directly). The 15-min incremental cadence is a derived concept — this
   * method checks whether the interval has elapsed against the last commit.
   */
  tick(): void {
    if (this.state !== 'READY' && this.state !== 'ERROR') return;
    if (!this.deps.isDesignated()) return;
    if (this.deps.getQueueSize() === 0) return;
    if (!this.incIntervalElapsed()) return;
    this.transition('BACKUP_RUNNING');
  }

  onunload(): void {
    this.clearTimers();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private enterGrace(): void {
    this.transition('GRACE');
    const ms = this.deps.schedule.startup_grace_minutes * 60 * 1000;
    this.graceTimer = this.setTimeoutFn(() => {
      this.graceTimer = null;
      // Check state in case onunload / setDesignated / setAuthLost ran first.
      if (this.state === 'GRACE') this.enterQuietWait();
    }, ms);
  }

  private enterQuietWait(): void {
    this.transition('QUIET_WAIT');
    this.resetQuietTimer();
  }

  private resetQuietTimer(): void {
    if (this.quietTimer) this.clearTimeoutFn(this.quietTimer);
    const ms = this.deps.schedule.quiet_after_event_minutes * 60 * 1000;
    this.quietTimer = this.setTimeoutFn(() => {
      this.quietTimer = null;
      if (this.state === 'QUIET_WAIT') this.transition('READY');
    }, ms);
  }

  private clearTimers(): void {
    if (this.graceTimer) {
      this.clearTimeoutFn(this.graceTimer);
      this.graceTimer = null;
    }
    if (this.quietTimer) {
      this.clearTimeoutFn(this.quietTimer);
      this.quietTimer = null;
    }
  }

  private incIntervalElapsed(): boolean {
    const last = this.deps.getLastIncCommitAt();
    if (last === null) return true;
    const elapsed = this.now() - last;
    return elapsed >= this.deps.schedule.inc_interval_minutes * 60 * 1000;
  }

  private transition(to: FSMState): void {
    const prev = this.state;
    if (prev === to) return;
    this.state = to;
    this.deps.logger.info('fsm_transition', { from: prev, to });
    // Iterate a snapshot so a subscriber that mutates the list doesn't skip handlers.
    const snapshot = this.subscribers.slice();
    for (const s of snapshot) s(to, prev);
  }
}
