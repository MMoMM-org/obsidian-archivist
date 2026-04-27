---
title: "Phase 7: Scheduler FSM, Ribbon Status & Settings UI"
status: complete
version: "1.0"
phase: 7
---

# Phase 7: Scheduler FSM, Ribbon Status & Settings UI

> **UI Reference**: See [phase-7-mockups.md](phase-7-mockups.md) for ribbon state matrix, settings mockup, and locked design decisions (hybrid icon strategy, section order, storage-banner placement, manual-trigger surface).

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: plan/phase-7-mockups.md]` — UI mockups + locked design decisions
- `[ref: SDD/Cross-Cutting/UI Visualization Guide — Ribbon state machine]`
- `[ref: SDD/Runtime View/Primary Flow steps 1-4]`
- `[ref: SDD/Acceptance Criteria — Feature 1, Feature 7]`
- `[ref: SDD/Cross-Cutting/User Interface & UX]`
- `[ref: PRD/F1 (automatic backups), F5 (device coordination), F7 (OAuth), F8 (predecessor plugin), F2 (retention UI), S1 (exclusions), S3 (storage estimate), S5 (pre-flight toggle)]`
- `[ref: SDD/ADR-7, ADR-9, ADR-18]`

**Key Decisions**:
- Scheduler is a strict FSM: `LOADING → GRACE → QUIET_WAIT → READY ↔ BACKUP_RUNNING | PASSIVE | ERROR | AUTH_LOST`.
- GRACE is a fixed timer; QUIET_WAIT resets on every vault event; READY fires the interval tick.
- Pre-flight notice fires exactly once, 5 ± 0.5 min before each scheduled full.
- Catch-up jobs for overdue fulls enqueue automatically after QUIET_WAIT exits.
- Ribbon subscribes to FSM state changes and publishes an `aria-label` + tooltip for each state.
- `NoticeCenter` dedups error toasts (one per burst; resumed-from-error notice on success).
- Five settings sections in a single Obsidian `PluginSettingTab`: Backup Schedule / Retention / Notifications / Advanced / Dropbox.
- Retention tab uses **3 tiers** (never-prune / daily / monthly) with live-computed estimate row.
- Dropbox section is the OAuth UI entry point; disconnected and connected states visually distinct.
- Predecessor-plugin notice fires one-time on first `onload` after detecting installed+enabled `obsidian-dropbox-backups`.
- Vault-prefix changes require a confirmation dialog noting migration implications.

**Dependencies**: Phase 2 (strings, time util), Phase 3 (OAuthConnectFlow, DropboxClient), Phase 4 (EventQueue, PluginStore), Phase 5 (BackupService + DeviceCoordinator — Scheduler drives it), Phase 6 (RetentionService + StorageProbe).

---

## Tasks

This phase produces the user-facing config + status layer in its entirety: autonomous rhythm (Scheduler), always-visible status (Ribbon + NoticeCenter), and configuration surface (SettingsTab). Merging was deliberate — all five modules share the same FSM state and settings shape, so they belong in one phase.

### Scheduler + Ribbon + Notices (T7.1 – T7.5)

- [x] **T7.1 SchedulerFSM (state machine + transitions)** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/Cross-Cutting/UI Visualization Guide]`, `[ref: SDD/Runtime View]`.
  2. Test:
     - Initial state = `LOADING`; after `onLayoutReady` fires AND `device.designated === true` transitions to `GRACE`.
     - **Direct LOADING → PASSIVE (ROB-013):** if `device.designated === false` at plugin load, skip the GRACE + QUIET_WAIT timers entirely and transition `LOADING → PASSIVE` as soon as `onLayoutReady` fires. This avoids a meaningless 12-minute timer wait on a device that will never back up.
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

- [x] **T7.2 Scheduled full + catch-up + pre-flight notice** `[activity: backend-api]`

  1. Prime: Read `[ref: PRD/F1 AC-4, AC-5]`, `[ref: SDD/Acceptance Criteria — pre-flight]`.
  2. Test:
     - Given `full_cadence='weekly'`, `full_day=0`, `full_time='03:00'`, the next scheduled full is computed correctly across week/year/DST boundaries.
     - At `now = scheduled_full - 5 min`, the pre-flight notice fires exactly once with `{Start now / Postpone 1h / Skip}` buttons.
     - Clicking `Start now` advances the scheduled time to `now`.
     - Clicking `Postpone 1h` advances by 1 hour; repeated postpones stack.
     - Clicking `Skip` marks this week's full as skipped; the next run is next week's scheduled time.
     - If a scheduled full's time has passed while the plugin was unloaded, `recoverOnStartup()` enqueues a catch-up full to run after QUIET_WAIT exits.
     - A second overdue full (older than 1 cadence cycle) collapses into a single catch-up (we run one full, not N).
  3. Implement: Add scheduled-full planning to `SchedulerFSM`. Integrate pre-flight notice via `NoticeCenter` (T7.4). Persist `last_full_commit_at` in `index.json`.
  4. Validate: Unit tests with fake timers + fixed wall-clock.
  5. Success: Pre-flight reliability `[ref: PRD/F1 AC-5]`; catch-up on restart `[ref: PRD/F1 AC-6]`.

- [x] **T7.3 RibbonIcon (status surface)** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Cross-Cutting/User Interface & UX]`, `[ref: PRD/F3 user journey]`.
  2. Test:
     - Initial ribbon icon added; tooltip reads the initial state's label.
     - Subscribes to `SchedulerFSM.onStateChange`; on transition, tooltip and `aria-label` update synchronously.
     - Label strings come from `src/ui/strings.ts` (no hard-coded English in this module).
     - Click behavior: opens the Backup Browser.
     - On `onunload`, icon is removed and the state-change subscription is disposed.
  3. Implement: Create `src/ui/RibbonIcon.ts`. Uses `this.plugin.addRibbonIcon` (registered) + `setTooltip` / `setAttribute('aria-label', ...)`.
  4. Validate: Unit tests with a fake DOM; state-driven label matrix asserted.
  5. Success: Ribbon state matrix covers every FSM state `[ref: SDD/UI Visualization Guide]`; accessibility aria-label `[ref: SDD/Quality Requirements/Usability — aria-label reflects state]`.

- [x] **T7.4 NoticeCenter (toast dedup + routing)** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: PRD/F1, F7 notifications]`, `[ref: SDD/Error Handling]`.
  2. Test:
     - `showSuccess(event_type, detail)` fires an Obsidian `Notice` when the corresponding settings-toggle is ON (default: inc=OFF, full=ON, error=ON).
     - `showError(code, detail)` fires at most once per 5-minute burst per error code; after the burst, a single "resumed" notice fires on the next success.
     - `showPersistent(code, detail)` creates a sticky banner (rendered in SettingsTab + as a ribbon-tooltip override) until cleared; used for `QuotaExceeded`, `AuthLost`, `DeviceConflict`.
     - `showPreflight(actions)` produces the 5-min-before-full interactive notice with Start-now / Postpone-1h / Skip.
  3. Implement: Create `src/ui/NoticeCenter.ts`. Uses Obsidian `Notice` + a small in-memory dedup-state map. Persistent banners are published via an observable that `SettingsTab` and `RibbonIcon` subscribe to.
  4. Validate: Unit tests with fake DOM + fake timers verify dedup window.
  5. Success: Toast-fatigue mitigation `[ref: research UX default-calibration]`; error-notice contract `[ref: SDD/Acceptance Criteria — error-suppression]`.

- [x] **T7.5 Manual "Back up now" command** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: PRD/S2]`.
  2. Test: Command registered as `Archivist: Back up now`; on invocation, if designated + not already in `BACKUP_RUNNING`, triggers an immediate incremental.
  3. Implement: Register command in `src/main.ts` (or a `src/ui/Commands.ts` helper).
  4. Validate: Unit test with mocked SchedulerFSM asserts the right entry point is called.
  5. Success: PRD S2 `[ref: PRD/S2]`.

### Settings UI (T7.6 – T7.11)

- [x] **T7.6 SettingsTab scaffold + five sections** `[activity: frontend-ui]`

  1. Prime: Read `[ref: SDD/Cross-Cutting/UI Visualization Guide]`, `[ref: PRD/Feature Requirements]`.
  2. Test:
     - Tab registers via `this.addSettingTab(new ArchivistSettingTab(...))`.
     - Five `<h2>` section headers in the documented order.
     - Each setting row uses Obsidian `new Setting(container)`; no direct DOM/innerHTML manipulation.
     - Settings edits persist immediately via `PluginStore.saveSettings`; values reload correctly after plugin reload.
     - Invalid input reverts to the prior value with an inline error.
     - Persistent-banner slot at the top of the tab renders active banners from `NoticeCenter` (Storage, AuthLost, DeviceConflict).
  3. Implement: Create `src/ui/SettingsTab.ts` extending `PluginSettingTab`. One renderer function per section — public surface: `renderBackupSchedule`, `renderRetention`, `renderNotifications`, `renderAdvanced`, `renderDropbox` — called from the top-level `display()`.
  4. Validate: Component tests with a fake DOM assert every documented setting is present and wired.
  5. Success: Each PRD-surfaced setting is reachable `[ref: PRD/Feature Requirements]`.

- [x] **T7.7 Backup Schedule section** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: PRD/F1]`, `[ref: SDD/Building Block View/Interface Specifications/Application Data Models — ScheduleSettings]`.
  2. Test:
     - Toggle: "This device performs backups" reflects `device.designated` and triggers `DeviceCoordinator.takeOwnership(true/false)` on change.
     - Device ID displayed read-only (first 6 chars + copy-to-clipboard).
     - Full cadence dropdown: weekly/biweekly/monthly; Full day + time pickers.
     - Incremental interval dropdown: 5/15/30/60 min.
     - Startup grace + quiet-period number inputs with validation.
     - Active-window fields disabled by default (C4 could-have); flipping the enable toggle shows them.
  3. Implement: Add `renderBackupSchedule(container)` to `SettingsTab`.
  4. Validate: Component tests mock settings.
  5. Success: PRD F1 + F5 configurable `[ref: PRD/F1, F5]`.

- [x] **T7.8 Retention section (3 tiers + live estimate)** `[activity: frontend-ui]`

  1. Prime: Read `[ref: PRD/F2, S3]`, `[ref: SDD/Acceptance Criteria — storage_warn]`.
  2. Test:
     - Four tier inputs: never-prune-window-days (0–14, default 14), daily-days (0–90, default 30), monthly-years (0–10, default 3), plus `recent_hours` (0–168, default 24) folded into the never-prune tier row as a "high-frequency recent window" sub-control.
     - Storage hard-limit input (default 200 GB) with warn-percent input (default 80).
     - Live-estimate row recomputes after each edit: "With these settings, approximately N snapshots kept, ~X GB".
        - Estimate uses a pure function `estimateRetention(profile, settings)` — takes the reference vault profile (size + edit rate) and the settings, returns `{snapshots, gb}`.
        - Profile comes from `index.json` statistics (last-known vault size + 7-day average edit rate) or from defaults if the plugin is new.
     - If current Dropbox usage (from `StorageProbe`) exceeds `warn_percent * hard_limit`, a persistent warning banner is shown at the top of the tab AND in ribbon tooltip.
  3. Implement: Add `renderRetention(container)` to `SettingsTab`. Create `src/services/retention/estimator.ts` (pure function).
  4. Validate: Fixture-driven tests for the estimator with the simplified 3-tier model; UI component test asserts the estimate row updates.
  5. Success: PRD F2 + S3 `[ref: PRD/F2, S3]`; storage warn `[ref: PRD/F2 AC-5]`.

- [x] **T7.9 Notifications + Advanced sections** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: PRD/Notifications defaults, S1 exclusions, Advanced settings]`.
  2. Test:
     - Notifications: four toggles (pre-flight, after-inc, after-full, on-error) with documented defaults (inc=OFF, full=ON, error=ON, pre-flight=ON).
     - Advanced: exclusion-globs textarea (one glob per line); reconcile-scan toggle (ON); dry-run toggle (OFF); vault-prefix input (default slugified vault name — see ADR-18, validation regex `/^[a-z0-9][a-z0-9_-]{1,63}$/`); diagnostic-logging toggle (OFF, default); upload-parallelism slider 1..8 (default 4); chunk-size-MB slider 4..64 (default 8).
     - Changing vault-prefix opens a confirm modal explaining the migration implication (new path = new history; old history stays at old prefix until user cleans up manually).
     - Changing exclusion-globs validates each glob pattern syntax; invalid glob shows inline error without persisting.
  3. Implement: Add `renderNotifications` and `renderAdvanced` to `SettingsTab`.
  4. Validate: Component tests + glob-validation tests.
  5. Success: PRD S1 configurable; defaults match `[ref: PRD/Notifications defaults, S1]`.

- [x] **T7.10 Dropbox section (OAuth UI + Disconnect)** `[activity: frontend-ui]`

  1. Prime: Read `[ref: PRD/F7 acceptance criteria]`, `[ref: research UX — OAuth connect prompt]`, `[ref: SDD/ADR-7, ADR-9]`.
  2. Test:
     - Disconnected state: shows `S.OAUTH_CONNECT_PROMPT` (exact copy) and a `[Connect Dropbox]` button.
     - Click Connect → calls `OAuthConnectFlow.beginAuth()` → opens browser → on callback → shows connected state.
     - Cancel mid-flow: returns to disconnected state with `[Try again]` button; no partial auth state retained.
     - Connected state: shows "Connected as \<email\>"; `[Re-authenticate]` + `[Disconnect]` buttons.
     - Click Disconnect → opens confirmation dialog (`S.CONFIRM_DISCONNECT`) → on confirm, calls revoke + local clear; returns to disconnected state.
     - Plaintext-token disclosure text rendered inline (`S.TOKEN_DISCLOSURE`).
     - If plugin-data path is detected under a known iCloud / sync path, a one-time notice fires `S.DATA_JSON_SYNC_WARNING`.
  3. Implement: Add `renderDropbox(container)` to `SettingsTab`. Wire to `OAuthConnectFlow` + `DropboxClient.disconnect`.
  4. Validate: Component tests exercise connect / cancel / disconnect with mocked flow.
  5. Success: F7 acceptance criteria `[ref: PRD/F7]`; disclosure present `[ref: SDD/ADR-7]`.

- [x] **T7.11 Predecessor plugin detection notice** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: PRD/F8]`.
  2. Test:
     - On `onload`, check whether plugin `obsidian-dropbox-backups` is installed AND enabled via `this.app.plugins.enabledPlugins.has('obsidian-dropbox-backups')`.
     - If yes: fire a persistent notice with `S.PREDECESSOR_PLUGIN_WARNING`; include a "Don't show again" button.
     - If user dismisses: record `data.json.ui.predecessor_notice_dismissed = true`; do not re-show on next load.
     - If the predecessor plugin is later disabled: the notice state auto-clears.
  3. Implement: Add `detectPredecessorPlugin()` in `src/main.ts` onload.
  4. Validate: Unit tests with a fake `app.plugins` surface.
  5. Success: PRD F8 `[ref: PRD/F8]`.

- [x] **T7.12 Phase Validation** `[activity: validate]`

  - Run all Phase 7 tests. Integration: wire Scheduler + Ribbon + NoticeCenter + SettingsTab + a mocked BackupService; simulate 1 day of fake time; verify expected ribbon transitions, pre-flight notice, error dedup, manual trigger, settings round-trip, OAuth flow connect/cancel/disconnect, predecessor notice dismissal. Manual sanity-check in a real Obsidian test vault for all five settings sections. Lint and typecheck pass.
