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
//   BACKUP_RUNNING ──(onBackupBlocked)─────────→ BLOCKED       (permanent)
//   ERROR   ──(tick + {full-due | catchup | inc-due})→ BACKUP_RUNNING
//   * (not BACKUP_RUNNING / BLOCKED) + setBlocked() → BLOCKED
//   BLOCKED + clearBlock() ────────────────────→ READY
//   * (not BACKUP_RUNNING) + setDesignated(false) → PASSIVE
//   PASSIVE + setDesignated(true) ─────────────→ READY
//   *       + setAuthLost()   ─────────────────→ AUTH_LOST
//   AUTH_LOST + setAuthRestored() ─────────────→ READY
//
// Design invariants:
//   - FSM never calls Dropbox directly. It emits BACKUP_RUNNING via the state
//     observer; callers read getPendingBackup() to decide inc vs. full, kick
//     off BackupService, and report the outcome via onBackupSuccess /
//     onBackupFailure / onBackupBlocked.
//   - Ticks in GRACE / QUIET_WAIT / BACKUP_RUNNING / PASSIVE / AUTH_LOST /
//     BLOCKED are no-ops. ERROR is NOT in that no-op list — a transient
//     failed backup should be retried on the next tick if the interval is
//     due. BLOCKED is the *permanent* error class (vault-id mismatch,
//     schema-corrupt remote, etc.) where retrying is futile and only spams
//     the user; clearing requires a user action via clearBlock().
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
  | 'AUTH_LOST'
  | 'BLOCKED';

/**
 * Reason a backup is blocked. Distinct from transient ERROR — these
 * conditions only resolve via user action (resolving a vault-id mismatch
 * via the recovery modal, repairing a corrupt remote vault_meta, etc.).
 * Retrying on the next tick would just spam the user with toasts and
 * burn Dropbox round-trips against a known-broken state.
 */
export type BlockReason =
  | 'VAULT_ID_MISMATCH'
  | 'VAULT_META_CORRUPT'
  | 'VAULT_ID_NEEDS_ADOPTION'
  | 'VAULT_ID_INVALID';

export type StateChangeHandler = (next: FSMState, prev: FSMState) => void;

// Opaque — FSM only round-trips the handle from setTimeoutFn back to clearTimeoutFn,
// so the caller picks the underlying type. `number | object` covers both
// browser (`number`) and node (`Timeout` is an object) without pulling in `unknown`,
// which would collapse `TimerHandle | null` into a redundant union.
export type TimerHandle = number | object;
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
  showPreflight(actions: PreflightActions, scheduledAt: number): void;
  /**
   * Dismiss any active preflight notice. Optional so lightweight test stubs
   * can satisfy the contract without implementing it. Called by the FSM when
   * the scheduled full has actually completed (so the sticky notice doesn't
   * linger past the event it was warning about).
   */
  dismissPreflight?(): void;
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
  /**
   * Epoch-ms of the earliest still-uncommitted vault event in the queue, or
   * null when the queue has nothing pending. Anchors the inc batch window:
   * the inc fires inc_interval_minutes after the FIRST pending edit, so
   * subsequent edits within the window get batched into a single snapshot
   * instead of firing their own incs back-to-back.
   */
  getEarliestPendingObservedAt: () => number | null;
  preflightHost: PreflightHost;
  logger: Logger;
  /** Injectable for tests — defaults to Date.now(). */
  now?: () => number;
  /**
   * Timer functions. Injected so production can pass `window.setTimeout`/
   * `window.clearTimeout` (Obsidian's `obsidianmd/prefer-window-timers` rule)
   * while tests pass thin wrappers around node's globals so vi.useFakeTimers
   * works.
   */
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
}

const PREFLIGHT_LEAD_MS = 5 * 60 * 1000;
const POSTPONE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// SchedulerFSM
// ---------------------------------------------------------------------------

export class SchedulerFSM {
  private state: FSMState = 'LOADING';
  private graceTimer: TimerHandle | null = null;
  private graceTimerEndAt: number | null = null;
  private quietTimer: TimerHandle | null = null;
  private quietTimerEndAt: number | null = null;
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
    this.setTimeoutFn = deps.setTimeoutFn;
    this.clearTimeoutFn = deps.clearTimeoutFn;
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

  /** Epoch-ms when the GRACE timer fires, or null if not in GRACE. */
  getGraceEndAt(): number | null {
    return this.graceTimerEndAt;
  }

  /** Epoch-ms when the QUIET_WAIT timer fires, or null if not in QUIET_WAIT. */
  getQuietWaitEndAt(): number | null {
    return this.quietTimerEndAt;
  }

  /**
   * Epoch-ms when the next inc backup becomes interval-eligible — same
   * logic as incIntervalElapsed (batch window from the earliest pending
   * edit), so the tooltip countdown matches when the tick will actually
   * fire. Returns null when the queue is empty (no batch in progress).
   */
  getNextIncEligibleAt(): number | null {
    const earliest = this.deps.getEarliestPendingObservedAt();
    if (earliest === null) return null;
    return earliest + this.deps.schedule.inc_interval_minutes * 60 * 1000;
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

  /**
   * Manual "Back up now" trigger (T7.5 / PRD S2). Bypasses GRACE / QUIET_WAIT
   * because the user has explicitly asked — no need to wait for edit activity
   * to settle. Never fires from BACKUP_RUNNING, PASSIVE, or AUTH_LOST; returns
   * a result code so the caller (Command handler) can surface the appropriate
   * Notice copy.
   */
  triggerBackupNow(
    kind: 'inc' | 'full' = 'inc',
  ): 'started' | 'already_running' | 'not_designated' | 'auth_lost' | 'blocked' {
    if (!this.deps.isDesignated()) return 'not_designated';
    if (this.state === 'AUTH_LOST') return 'auth_lost';
    if (this.state === 'BLOCKED') return 'blocked';
    if (this.state === 'BACKUP_RUNNING') return 'already_running';
    // Clear any pending grace/quiet so the manual trigger takes effect cleanly.
    this.clearTimers();
    this.pendingBackup =
      kind === 'full' ? { type: 'full', reason: 'scheduled' } : { type: 'inc' };
    this.transition('BACKUP_RUNNING');
    return 'started';
  }

  /**
   * Permanent-error lock. Distinct from onBackupFailure — that one keeps
   * the FSM eligible for tick-driven retries (transient failures recover
   * by themselves). setBlocked / onBackupBlocked freeze the FSM until
   * clearBlock() fires, typically from the recovery-modal success path.
   *
   * Cannot interrupt an in-flight upload — the upload itself will report
   * its outcome via onBackupSuccess / onBackupFailure / onBackupBlocked
   * and the latch we'd set here would be stomped a moment later anyway.
   */
  setBlocked(reason: BlockReason): void {
    if (this.state === 'BACKUP_RUNNING') return;
    this.clearTimers();
    this.deps.logger.warn('fsm_blocked', { reason });
    if (this.state !== 'BLOCKED') this.transition('BLOCKED');
  }

  /** Variant of onBackupFailure for permanent failures detected mid-upload. */
  onBackupBlocked(reason: BlockReason): void {
    this.pendingBackup = null;
    this.deps.logger.warn('fsm_blocked', { reason });
    if (this.state === 'BACKUP_RUNNING') this.transition('BLOCKED');
  }

  /**
   * Release the permanent-error lock. Called by the recovery modal after
   * the user adopts the remote vault_id (or otherwise resolves the
   * underlying config), and by setDesignated(true) so a passive device
   * can come back online cleanly.
   */
  clearBlock(): void {
    if (this.state !== 'BLOCKED') return;
    this.deps.logger.info('fsm_block_cleared');
    this.transition('READY');
  }

  onBackupSuccess(): void {
    // Clear planner state tied to the completed full, if any.
    if (this.pendingBackup?.type === 'full') {
      this.fullOverride = null;
      this.skippedCycle = null;
      this.preflightFiredFor = null;
      if (this.pendingBackup.reason === 'catchup') this.catchupPending = false;
      // The sticky preflight notice has no auto-timeout. Once the full it
      // warned about has actually run, dismiss it so it doesn't linger.
      this.deps.preflightHost.dismissPreflight?.();
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
   * Inspect lastFullCommitAt against the schedule. Set the catch-up flag in
   * two cases:
   *   1. lastFull === null — fresh install OR plugin lost the in-memory
   *      reference. Per requirements.md User-Journey 5 ("First-Time Setup"),
   *      the first FULL must run silently ~10 min after enable. Treat this as
   *      "scheduled FULL is overdue from time-immemorial".
   *   2. A scheduled FULL slot has passed since the last commit. Standard
   *      offline-catch-up case (requirements.md F1 AC).
   *
   * The actual transition to BACKUP_RUNNING happens when the FSM reaches
   * READY and receives its first tick (plan §T7.2 — "run after QUIET_WAIT
   * exits").
   */
  recoverOnStartup(): void {
    const lastFull = this.deps.getLastFullCommitAt();
    if (lastFull === null) {
      this.catchupPending = true;
      this.deps.logger.info('catchup_flagged_fresh_install');
      return;
    }

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
    this.deps.preflightHost.showPreflight(
      {
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
      },
      scheduled,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers — timers + transitions (unchanged from T7.1)
  // ---------------------------------------------------------------------------

  private enterGrace(): void {
    this.transition('GRACE');
    const ms = this.deps.schedule.startup_grace_minutes * 60 * 1000;
    this.graceTimerEndAt = this.now() + ms;
    this.graceTimer = this.setTimeoutFn(() => {
      this.graceTimer = null;
      this.graceTimerEndAt = null;
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
    this.quietTimerEndAt = this.now() + ms;
    this.quietTimer = this.setTimeoutFn(() => {
      this.quietTimer = null;
      this.quietTimerEndAt = null;
      if (this.state === 'QUIET_WAIT') this.transition('READY');
    }, ms);
  }

  private clearTimers(): void {
    if (this.graceTimer) {
      this.clearTimeoutFn(this.graceTimer);
      this.graceTimer = null;
      this.graceTimerEndAt = null;
    }
    if (this.quietTimer) {
      this.clearTimeoutFn(this.quietTimer);
      this.quietTimer = null;
      this.quietTimerEndAt = null;
    }
  }

  private incIntervalElapsed(): boolean {
    // Batch window: the inc fires inc_interval_minutes after the EARLIEST
    // still-uncommitted edit, not inc_interval_minutes after the last
    // commit. Difference matters when the user goes idle for a while —
    // the first edit after a long idle anchors a fresh batch window so
    // subsequent edits within that window get batched instead of each
    // tick firing its own near-immediate inc. Returns false when the
    // queue is empty (nothing to batch); the queue-size check upstream
    // in tick() also gates this, but the null-guard keeps the function
    // independently safe.
    const earliest = this.deps.getEarliestPendingObservedAt();
    if (earliest === null) return false;
    const elapsed = this.now() - earliest;
    return elapsed >= this.deps.schedule.inc_interval_minutes * 60 * 1000;
  }

  private transition(to: FSMState): void {
    const prev = this.state;
    if (prev === to) return;
    this.state = to;
    this.deps.logger.debug('fsm_transition', { from: prev, to });
    const snapshot = this.subscribers.slice();
    for (const s of snapshot) s(to, prev);
  }
}
