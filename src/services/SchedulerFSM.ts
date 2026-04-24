// SchedulerFSM — finite state machine driving backup cadence (T7.1) + the
// scheduled-full planner, pre-flight notice, and catch-up on startup (T7.2).
//
// State diagram (SDD §Cross-Cutting/UI Visualization Guide):
//   LOADING ──(onLayoutReady + designated)─────→ GRACE
//   LOADING ──(onLayoutReady + !designated)────→ PASSIVE        (ROB-013)
//   GRACE   ──(startup_grace_minutes elapsed)──→ QUIET_WAIT
//   QUIET_WAIT ──(vault event)─────────────────→ QUIET_WAIT     (timer reset)
//   QUIET_WAIT ──(quiet_after_event_minutes)───→ READY
//   READY   ──(tick + {full-due | catchup | inc-due})→ BACKUP_RUNNING
//   BACKUP_RUNNING ──(onBackupSuccess)─────────→ READY
//   BACKUP_RUNNING ──(onBackupFailure)─────────→ ERROR
//   ERROR   ──(tick + {full-due | catchup | inc-due})→ BACKUP_RUNNING
//   * (not BACKUP_RUNNING) + setDesignated(false) → PASSIVE
//   PASSIVE + setDesignated(true) ─────────────→ READY
//   *       + setAuthLost()   ─────────────────→ AUTH_LOST
//   AUTH_LOST + setAuthRestored() ─────────────→ READY
//
// Design invariants:
//   - FSM never calls Dropbox directly. It emits BACKUP_RUNNING via the state
//     observer; callers read getPendingBackup() to decide inc vs. full, kick
//     off BackupService, and report the outcome via onBackupSuccess /
//     onBackupFailure.
//   - Ticks in GRACE / QUIET_WAIT / BACKUP_RUNNING / PASSIVE / AUTH_LOST are
//     no-ops. ERROR is NOT in that no-op list — a failed backup should be
//     retried on the next tick if the interval is due.
//   - Scheduled full takes priority over incremental when both are due.
//   - Multiple overdue fulls collapse to a single catch-up — recoverOnStartup
//     sets `catchupPending = true` once; no per-cycle queue.
//   - All timers are cleared on onunload (ROB-005 / plan §T7.1).

import type { ScheduleSettings } from '../model/Settings';
import type { Logger } from '../infra/Logger';
import { nextFullAt } from '../util/time';

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

export type PendingBackup =
  | { type: 'inc' }
  | { type: 'full'; reason: 'scheduled' | 'catchup' };

export interface PreflightActions {
  onStartNow: () => void;
  onPostpone1h: () => void;
  onSkip: () => void;
}

export interface PreflightHost {
  showPreflight(actions: PreflightActions): void;
}

export interface SchedulerFSMDeps {
  schedule: Pick<
    ScheduleSettings,
    | 'startup_grace_minutes'
    | 'quiet_after_event_minutes'
    | 'inc_interval_minutes'
    | 'full_cadence'
    | 'full_day_of_week'
    | 'full_time_of_day'
  >;
  isDesignated: () => boolean;
  getQueueSize: () => number;
  getLastIncCommitAt: () => number | null;
  getLastFullCommitAt: () => number | null;
  preflightHost: PreflightHost;
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

const PREFLIGHT_LEAD_MS = 5 * 60 * 1000;
const POSTPONE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// SchedulerFSM
// ---------------------------------------------------------------------------

export class SchedulerFSM {
  private state: FSMState = 'LOADING';
  private graceTimer: TimerHandle | null = null;
  private quietTimer: TimerHandle | null = null;
  private subscribers: StateChangeHandler[] = [];

  // T7.2 planner state --------------------------------------------------------
  /** Absolute override for the next scheduled full (Start-now / Postpone). */
  private fullOverride: number | null = null;
  /** Timestamp of a scheduled cycle the user chose to skip. */
  private skippedCycle: number | null = null;
  /** Dedup: scheduled timestamp the preflight has already been shown for. */
  private preflightFiredFor: number | null = null;
  /** Collapsed catch-up flag — one full, regardless of how many cycles missed. */
  private catchupPending = false;
  /** Pending backup type, visible to subscribers once state === BACKUP_RUNNING. */
  private pendingBackup: PendingBackup | null = null;

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
  // Public API — state observation
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

  getPendingBackup(): PendingBackup | null {
    return this.pendingBackup;
  }

  hasPendingCatchup(): boolean {
    return this.catchupPending;
  }

  // ---------------------------------------------------------------------------
  // Public API — lifecycle
  // ---------------------------------------------------------------------------

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
    // Clear planner state tied to the completed full, if any.
    if (this.pendingBackup?.type === 'full') {
      this.fullOverride = null;
      this.skippedCycle = null;
      this.preflightFiredFor = null;
      if (this.pendingBackup.reason === 'catchup') this.catchupPending = false;
    }
    this.pendingBackup = null;
    if (this.state === 'BACKUP_RUNNING') this.transition('READY');
  }

  onBackupFailure(): void {
    this.pendingBackup = null;
    if (this.state === 'BACKUP_RUNNING') this.transition('ERROR');
  }

  /**
   * Wall-clock tick. Called externally (production: registered via
   * plugin.registerInterval(setInterval(tick, 60_000)); tests: invoked
   * directly). Evaluates preflight window + scheduled-full / catch-up /
   * incremental triggers in that priority order.
   */
  tick(): void {
    if (this.state !== 'READY' && this.state !== 'ERROR') return;
    if (!this.deps.isDesignated()) return;

    const now = this.now();

    // 1. Pre-flight window? (fires regardless of whether a backup follows)
    const scheduled = this.computeNextScheduledFullAt();
    if (
      now >= scheduled - PREFLIGHT_LEAD_MS &&
      now < scheduled &&
      this.preflightFiredFor !== scheduled
    ) {
      this.firePreflight(scheduled);
    }

    // 2. Scheduled full due?
    if (now >= scheduled) {
      this.pendingBackup = { type: 'full', reason: 'scheduled' };
      this.transition('BACKUP_RUNNING');
      return;
    }

    // 3. Catch-up full pending?
    if (this.catchupPending) {
      this.pendingBackup = { type: 'full', reason: 'catchup' };
      this.transition('BACKUP_RUNNING');
      return;
    }

    // 4. Incremental?
    if (this.deps.getQueueSize() === 0) return;
    if (!this.incIntervalElapsed()) return;
    this.pendingBackup = { type: 'inc' };
    this.transition('BACKUP_RUNNING');
  }

  onunload(): void {
    this.clearTimers();
  }

  // ---------------------------------------------------------------------------
  // Public API — planner
  // ---------------------------------------------------------------------------

  getNextScheduledFullAt(): number {
    return this.computeNextScheduledFullAt();
  }

  /**
   * Inspect lastFullCommitAt against the schedule. If at least one scheduled
   * full has passed since the last commit, set a single catch-up flag. The
   * actual transition to BACKUP_RUNNING happens when the FSM reaches READY
   * and receives its first tick (plan §T7.2 — "run after QUIET_WAIT exits").
   */
  recoverOnStartup(): void {
    const lastFull = this.deps.getLastFullCommitAt();
    if (lastFull === null) return; // fresh install — no catch-up

    const nextFromLast = this.nextFullAfter(new Date(lastFull));
    if (nextFromLast.getTime() <= this.now()) {
      this.catchupPending = true;
      this.deps.logger.info('catchup_flagged', {
        last_full_at: lastFull,
        next_from_last: nextFromLast.getTime(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers — planner
  // ---------------------------------------------------------------------------

  private computeNextScheduledFullAt(): number {
    if (this.fullOverride !== null) return this.fullOverride;
    const base = this.nextFullAfter(new Date(this.now())).getTime();
    if (this.skippedCycle === base) {
      // Jump past the skipped cycle by computing from just after it.
      return this.nextFullAfter(new Date(base + 1)).getTime();
    }
    return base;
  }

  private nextFullAfter(anchor: Date): Date {
    const lastFull = this.deps.getLastFullCommitAt();
    return nextFullAt(
      anchor,
      this.deps.schedule.full_cadence,
      this.deps.schedule.full_day_of_week,
      this.deps.schedule.full_time_of_day,
      lastFull === null ? null : new Date(lastFull),
    );
  }

  private firePreflight(scheduled: number): void {
    this.preflightFiredFor = scheduled;
    this.deps.preflightHost.showPreflight({
      onStartNow: () => {
        this.fullOverride = this.now();
        this.preflightFiredFor = null;
      },
      onPostpone1h: () => {
        const base = this.fullOverride ?? scheduled;
        this.fullOverride = base + POSTPONE_MS;
        this.preflightFiredFor = null;
      },
      onSkip: () => {
        this.skippedCycle = scheduled;
        this.fullOverride = null;
        this.preflightFiredFor = null;
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers — timers + transitions (unchanged from T7.1)
  // ---------------------------------------------------------------------------

  private enterGrace(): void {
    this.transition('GRACE');
    const ms = this.deps.schedule.startup_grace_minutes * 60 * 1000;
    this.graceTimer = this.setTimeoutFn(() => {
      this.graceTimer = null;
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
    const snapshot = this.subscribers.slice();
    for (const s of snapshot) s(to, prev);
  }
}
