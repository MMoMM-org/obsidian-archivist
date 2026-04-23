---
title: "Phase 7: Scheduler FSM & Ribbon Status"
status: pending
version: "1.0"
phase: 7
---

# Phase 7: Scheduler FSM & Ribbon Status

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Cross-Cutting/UI Visualization Guide — Ribbon state machine]`
- `[ref: SDD/Runtime View/Primary Flow steps 1-4]`
- `[ref: SDD/Acceptance Criteria — Feature 1]`
- `[ref: PRD/F1]`

**Key Decisions**:
- Scheduler is a strict FSM: `LOADING → GRACE → QUIET_WAIT → READY ↔ BACKUP_RUNNING | PASSIVE | ERROR | AUTH_LOST`.
- GRACE is a fixed timer; QUIET_WAIT resets on every vault event; READY fires the interval tick.
- Pre-flight notice fires exactly once, 5 ± 0.5 min before each scheduled full.
- Catch-up jobs for overdue fulls enqueue automatically after QUIET_WAIT exits.
- Ribbon subscribes to FSM state changes and publishes an `aria-label` + tooltip for each state.
- `NoticeCenter` dedups error toasts (one per burst; resumed-from-error notice on success).

**Dependencies**: Phase 2 (strings, time util), Phase 5 (BackupService — Scheduler drives it), Phase 6 (RetentionService — Scheduler triggers after-backup), Phase 4 (EventQueue — for idle-tick check).

---

## Tasks

Produces the autonomous rhythm of the plugin: nothing happens until the scheduler says "go." Also produces the one piece of UI that's always visible — the ribbon icon.

- [ ] **T7.1 SchedulerFSM (state machine + transitions)** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/Cross-Cutting/UI Visualization Guide]`, `[ref: SDD/Runtime View]`.
  2. Test:
     - Initial state = `LOADING`; after `onLayoutReady` fires transitions to `GRACE`.
     - After `startup_grace_minutes` elapses → `QUIET_WAIT`.
     - A vault event during `QUIET_WAIT` resets its timer.
     - After `quiet_after_event_minutes` with no events → `READY`.
     - On designated-toggle false → `PASSIVE` (from any state except `BACKUP_RUNNING`).
     - `READY` + 15-min interval tick + non-empty queue + designated → `BACKUP_RUNNING`.
     - `BACKUP_RUNNING` → `READY` on success; `ERROR` on failure.
     - AuthError('invalid_grant') from BackupService sets `AUTH_LOST`; resolves on successful re-auth.
     - Ticks while in `GRACE`/`QUIET_WAIT`/`BACKUP_RUNNING`/`PASSIVE`/`AUTH_LOST` are no-ops.
     - Idle tick (queue empty) in `READY` makes zero Dropbox calls.
     - `onunload` stops all timers (verified by asserting no lingering `setTimeout` handles).
  3. Implement: Create `src/services/SchedulerFSM.ts`. Use `this.plugin.registerInterval(setInterval(tick, 60_000))` — tick function checks wall-clock against scheduled times; the 15-min interval is a derived concept. Observer pattern (`onStateChange(handler)`).
  4. Validate: Unit tests with fake timers exhaustively cover transitions + no-op tick.
  5. Success: Quiet-period contract `[ref: PRD/F1 AC-3, SDD/Acceptance Criteria — GRACE/QUIET]`; idle tick is zero-cost `[ref: PRD/F1 AC-2]`.

- [ ] **T7.2 Scheduled full + catch-up + pre-flight notice** `[activity: backend-api]`

  1. Prime: Read `[ref: PRD/F1 AC-4, AC-5]`, `[ref: SDD/Acceptance Criteria — pre-flight]`.
  2. Test:
     - Given `full_cadence='weekly'`, `full_day=0`, `full_time='03:00'`, the next scheduled full is computed correctly across week/year/DST boundaries.
     - At `now = scheduled_full - 5 min`, the pre-flight notice fires exactly once with `{Start now / Postpone 1h / Skip}` buttons.
     - Clicking `Start now` advances the scheduled time to `now`.
     - Clicking `Postpone 1h` advances by 1 hour; repeated postpones stack.
     - Clicking `Skip` marks this week's full as skipped; the next run is next week's scheduled time.
     - If a scheduled full's time has passed while the plugin was unloaded, `recoverOnStartup()` enqueues a catch-up full to run after QUIET_WAIT exits.
     - A second overdue full (older than 1 cadence cycle) collapses into a single catch-up (we run one full, not N).
  3. Implement: Add scheduled-full planning to `SchedulerFSM`. Integrate pre-flight notice via `NoticeCenter` (T7.4). Persist "last full committed" timestamp in `index.json`.
  4. Validate: Unit tests with fake timers + fixed wall-clock.
  5. Success: Pre-flight reliability `[ref: PRD/F1 AC-5]`; catch-up on restart `[ref: PRD/F1 AC-6]`.

- [ ] **T7.3 RibbonIcon (status surface)** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Cross-Cutting/User Interface & UX]`, `[ref: PRD/F3 user journey]`.
  2. Test:
     - Initial ribbon icon added; tooltip reads the initial state's label.
     - Subscribes to `SchedulerFSM.onStateChange`; on transition, tooltip and `aria-label` update synchronously.
     - Label strings come from `src/ui/strings.ts` (no hard-coded English in this module).
     - Mobile state: shows only `Tap to back up now` (manual allowed) or `Passive — backups run on desktop` depending on settings + platform.
     - Click behavior: on desktop opens the Backup Browser; on mobile (if manual backup allowed) triggers a manual backup.
     - On `onunload`, icon is removed and the state-change subscription is disposed.
  3. Implement: Create `src/ui/RibbonIcon.ts`. Uses `this.plugin.addRibbonIcon` (registered) + `setTooltip` / `setAttribute('aria-label', ...)`.
  4. Validate: Unit tests with a fake DOM; state-driven label matrix asserted.
  5. Success: Ribbon state matrix covers every FSM state `[ref: SDD/UI Visualization Guide]`; accessibility aria-label `[ref: SDD/Quality Requirements/Usability — aria-label reflects state]`.

- [ ] **T7.4 NoticeCenter (toast dedup + routing)** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: PRD/F1, F7 notifications]`, `[ref: SDD/Error Handling]`.
  2. Test:
     - `showSuccess(event_type, detail)` fires an Obsidian `Notice` when the corresponding settings-toggle is ON (default: inc=OFF, full=ON, error=ON).
     - `showError(code, detail)` fires at most once per 5-minute burst per error code; after the burst, a single "resumed" notice fires on the next success.
     - `showPersistent(code, detail)` creates a sticky banner (rendered in SettingsTab + as a ribbon-tooltip override) until cleared; used for `QuotaExceeded`, `AuthLost`, `DeviceConflict`.
     - `showPreflight(actions)` produces the 5-min-before-full interactive notice with Start-now / Postpone-1h / Skip.
  3. Implement: Create `src/ui/NoticeCenter.ts`. Uses Obsidian `Notice` + a small in-memory dedup-state map. Persistent banners are published via an observable that `SettingsTab` and `RibbonIcon` subscribe to.
  4. Validate: Unit tests with fake DOM + fake timers verify dedup window.
  5. Success: Toast-fatigue mitigation `[ref: research UX default-calibration]`; error-notice contract `[ref: SDD/Acceptance Criteria — error-suppression]`.

- [ ] **T7.5 Manual "Back up now" command** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: PRD/S2]`.
  2. Test: Command registered as `Archivist: Back up now`; on invocation, if designated + not already in BACKUP_RUNNING, triggers an immediate incremental; on mobile, respects `advanced.allow_manual_backup_mobile` (if false, command is not registered on mobile).
  3. Implement: Register command in `src/main.ts` (or a `src/ui/Commands.ts` helper).
  4. Validate: Unit test with mocked SchedulerFSM asserts the right entry point is called.
  5. Success: PRD S2 `[ref: PRD/S2]`.

- [ ] **T7.6 Phase Validation** `[activity: validate]`

  - Run all Phase 7 tests. Integration: wire Scheduler + Ribbon + NoticeCenter + a mocked BackupService; simulate 1 day of fake time; verify expected ribbon transitions, pre-flight notice, error dedup, manual trigger. Lint and typecheck pass.
