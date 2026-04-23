---
title: "Phase 10: Settings Page & OAuth UI"
status: pending
version: "1.0"
phase: 10
---

# Phase 10: Settings Page & OAuth UI

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Cross-Cutting/User Interface & UX]`
- `[ref: PRD/Feature Requirements — F7 (OAuth), F8 (predecessor plugin)]`
- `[ref: PRD/S1 (exclusions), S3 (storage estimate), S5 (pre-flight toggle)]`
- `[ref: SDD/ADR-7, ADR-9, ADR-18]`
- `[ref: SDD/Acceptance Criteria — Feature 7]`

**Key Decisions**:
- Five settings sections in a single Obsidian `PluginSettingTab`: Backup Schedule / Retention / Notifications / Advanced / Dropbox.
- Retention tab includes a live-computed "estimate" row (snapshots kept + approximate GB).
- Dropbox section is the OAuth UI entry point; disconnected and connected states are visually distinct.
- One-time predecessor-plugin notice fires on first `onload` after a check.
- Vault-prefix changes from the Advanced section require a confirmation dialog noting migration implications.

**Dependencies**: Phase 2 (strings, types, utils), Phase 3 (OAuthConnectFlow, DropboxClient), Phase 4 (PluginStore), Phase 6 (RetentionService estimate hook), Phase 7 (NoticeCenter for persistent banners).

---

## Tasks

Produces the single UI surface where users configure everything. Also the entry point for Dropbox auth.

- [ ] **T10.1 SettingsTab scaffold + five sections** `[activity: frontend-ui]`

  1. Prime: Read `[ref: SDD/Cross-Cutting/UI Visualization Guide]`, `[ref: PRD/Feature Requirements]`.
  2. Test:
     - Tab registers via `this.addSettingTab(new ArchivistSettingTab(...))`.
     - Five `<h2>` section headers in the documented order.
     - Each setting row uses Obsidian `new Setting(container)`; no direct DOM/innerHTML manipulation.
     - Settings edits persist immediately via `PluginStore.saveSettings`; values reload correctly after plugin reload.
     - Invalid input (e.g., retention tier value out of range) reverts to the prior value with an inline error.
     - Persistent-banner slot at the top of the tab renders active banners from `NoticeCenter` (Storage, AuthLost, DeviceConflict).
  3. Implement: Create `src/ui/SettingsTab.ts` extending `PluginSettingTab`. Compose small helper functions per section.
  4. Validate: Component tests with a fake DOM assert every documented setting is present and wired.
  5. Success: Each PRD-surfaced setting is reachable `[ref: PRD/Feature Requirements]`.

- [ ] **T10.2 Backup Schedule section** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: PRD/F1]`, `[ref: SDD/Building Block View/Interface Specifications/Application Data Models — ScheduleSettings]`.
  2. Test:
     - Toggle: "This device performs backups" reflects `device.designated` and triggers `DeviceCoordinator.takeOwnership(true/false)` on change.
     - Device ID displayed read-only (first 6 chars + copy-to-clipboard).
     - Full cadence dropdown: weekly/biweekly/monthly; Full day + time pickers.
     - Incremental interval dropdown: 5/15/30/60 min.
     - Startup grace + quiet-period number inputs with validation.
     - Active-window fields disabled by default (S4 could-have); flipping the enable toggle shows them.
     - On mobile, the designated-device toggle is disabled with an inline explanation: "Backup scheduling runs on desktop only."
  3. Implement: Add `renderBackupSchedule(container)` to `SettingsTab`.
  4. Validate: Component tests mock settings + a fake platform.
  5. Success: PRD F1 + F5 + S4 configurable `[ref: PRD/F1, F5, S4]`.

- [ ] **T10.3 Retention section with live estimate** `[activity: frontend-ui]`

  1. Prime: Read `[ref: PRD/F2, S3]`, `[ref: SDD/Acceptance Criteria — storage_warn]`.
  2. Test:
     - Six tier inputs (never-prune, recent, hourly, daily, weekly, monthly) with the documented ranges (see `RetentionSettings` type).
     - Storage hard-limit input (default 200 GB) with warn-percent input (default 80).
     - Live-estimate row recomputes after each edit: "With these settings, approximately N snapshots kept, ~X GB".
        - Estimate uses a pure function `estimateRetention(profile, settings)` — takes the reference vault profile (size + edit rate) and the settings, returns `{snapshots, gb}`.
        - Profile comes from `index.json` statistics (last-known vault size + 7-day average edit rate) or from defaults if the plugin is new.
     - If current Dropbox usage (from `StorageProbe`) exceeds `warn_percent * hard_limit`, a persistent warning banner is shown at the top of the tab AND in ribbon tooltip.
  3. Implement: Add `renderRetention(container)` to `SettingsTab`. Create `src/services/retention/estimator.ts` (pure function).
  4. Validate: Fixture-driven tests for the estimator; UI component test asserts the estimate row updates.
  5. Success: PRD F2 + S3 `[ref: PRD/F2, S3]`; storage warn `[ref: PRD/F2 AC-5]`.

- [ ] **T10.4 Notifications + Advanced sections** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: PRD/Notifications defaults, S1 exclusions, Advanced settings]`.
  2. Test:
     - Notifications: four toggles (pre-flight, after-inc, after-full, on-error) with documented defaults (inc=OFF, full=ON, error=ON, pre-flight=ON).
     - Advanced: exclusion-globs textarea (one glob per line); reconcile-scan toggle (ON); dry-run toggle (OFF); vault-prefix input (default slugified vault name — see ADR-18); diagnostic-logging toggle (OFF, default); upload-parallelism slider 1..8 (default 4); chunk-size-MB slider 4..64 (default 8); allow-manual-backup-mobile toggle (ON, default).
     - Changing vault-prefix opens a confirm modal explaining the migration implication (new path = new history; old history stays at old prefix until user cleans up manually).
     - Changing exclusion-globs validates each glob pattern syntax; invalid glob shows inline error without persisting.
  3. Implement: Add `renderNotifications` and `renderAdvanced` to `SettingsTab`.
  4. Validate: Component tests + glob-validation tests.
  5. Success: PRD S1 configurable; defaults match `[ref: PRD/Notifications defaults, S1]`.

- [ ] **T10.5 Dropbox section (OAuth UI + Disconnect)** `[activity: frontend-ui]`

  1. Prime: Read `[ref: PRD/F7 acceptance criteria]`, `[ref: research UX — OAuth connect prompt]`, `[ref: SDD/ADR-7, ADR-9]`.
  2. Test:
     - Disconnected state: shows `S.OAUTH_CONNECT_PROMPT` (exact copy) and a `[Connect Dropbox]` button.
     - Click Connect → calls `OAuthConnectFlow.beginAuth()` → opens browser → on callback → shows connected state.
     - Cancel mid-flow: returns to disconnected state with `[Try again]` button; no partial auth state retained.
     - Connected state: shows "Connected as \<email\>"; `[Re-authenticate]` + `[Disconnect]` buttons.
     - Click Disconnect → opens confirmation dialog (`S.CONFIRM_DISCONNECT`) → on confirm, calls revoke + local clear; returns to disconnected state.
     - Plaintext-token disclosure text rendered inline (`S.TOKEN_DISCLOSURE`).
     - If data.json path is detected under a known iCloud / sync path, a one-time notice fires `S.DATA_JSON_SYNC_WARNING`.
  3. Implement: Add `renderDropbox(container)` to `SettingsTab`. Wire to `OAuthConnectFlow` + `DropboxClient.disconnect`.
  4. Validate: Component tests exercise connect / cancel / disconnect with mocked flow.
  5. Success: F7 acceptance criteria `[ref: PRD/F7]`; disclosure present `[ref: SDD/ADR-7]`.

- [ ] **T10.6 Predecessor plugin detection notice** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: PRD/F8]`.
  2. Test:
     - On `onload`, check whether plugin `obsidian-dropbox-backups` is installed AND enabled via `this.app.plugins.enabledPlugins.has('obsidian-dropbox-backups')`.
     - If yes: fire a persistent notice with `S.PREDECESSOR_PLUGIN_WARNING`; include a "Don't show again" button.
     - If user dismisses: record `data.json.ui.predecessor_notice_dismissed = true`; do not re-show on next load.
     - If the predecessor plugin is later disabled: the notice state auto-clears.
  3. Implement: Add `detectPredecessorPlugin()` in `src/main.ts` onload.
  4. Validate: Unit tests with a fake `app.plugins` surface.
  5. Success: PRD F8 `[ref: PRD/F8]`.

- [ ] **T10.7 Phase Validation** `[activity: validate]`

  - Run all Phase 10 tests. Manually verify in a real Obsidian test vault: all settings round-trip, OAuth flow completes, disconnect works, predecessor notice fires and dismisses. Lint and typecheck pass.
