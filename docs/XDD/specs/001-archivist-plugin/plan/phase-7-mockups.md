---
title: "Phase 7: UI Mockups — Ribbon + Settings"
status: reference
version: "1.0"
phase: 7
---

# Phase 7 — UI Mockups

Reference artefact for T7.3 (RibbonIcon), T7.6–T7.10 (SettingsTab sections). Mockups + locked design decisions below supersede any conflicting ambiguity in `phase-7.md`.

**Source grounding:**
- `src/ui/strings.ts` — all visible copy below is drawn from `S.*` keys; no freelancing.
- `solution.md` §User Interface & UX (lines 1168–1247) — ribbon state machine + IA.
- `plan/phase-7.md` — task contracts T7.1–T7.11.

---

## Locked Design Decisions

1. **Ribbon icon: hybrid.**
   - Base icon: Lucide `archive-restore`.
   - During `BACKUP_RUNNING`: swap to Lucide `history`, add pulsing animation.
   - State expressed via CSS class on the ribbon element (color variables), **plus** tooltip + `aria-label` carry the full state name for a11y.
2. **Storage warning banner: settings-only.** T7.8's warn banner renders at the top of the Settings tab (persistent-banner slot). It does **not** bleed into the ribbon tooltip. Ribbon still reflects scheduler state (READY / ERROR / etc.), independent of storage pressure.
3. **"Back up now": Command Palette only.** No button in the Dropbox section. Keeps the connection section focused on auth; manual trigger lives in `Archivist: Back up now` (T7.5).
4. **Settings section order:** Schedule / Retention / Notifications / Advanced / Dropbox. (Plan order preserved; Dropbox stays at the bottom.)

---

## Ribbon — State Matrix (hybrid icon + colors + tooltip)

One ribbon item registered via `addRibbonIcon('archive-restore', ...)`. On `SchedulerFSM.onStateChange`, the handler:
1. Swaps the icon via `setIcon(el, iconFor(state))`.
2. Resets the element's className to `archivist-ribbon ${classFor(state)}`.
3. Updates tooltip via `setTooltip(el, tooltipFor(state))`.
4. Updates `aria-label` via `el.setAttribute('aria-label', ariaFor(state))`.

Click always opens the Backup Browser (T7.3).

### State table

| State            | Icon              | CSS class            | Color token            | Tooltip (S.*)                                           |
|------------------|-------------------|----------------------|------------------------|---------------------------------------------------------|
| `LOADING`        | `archive-restore` | `archivist-muted`    | `--text-muted`         | `RIBBON_TOOLTIP_IDLE`                                   |
| `GRACE`          | `archive-restore` | `archivist-muted`    | `--text-muted`         | `RIBBON_TOOLTIP_IDLE` + "starting in N min"             |
| `QUIET_WAIT`     | `archive-restore` | `archivist-muted`    | `--text-muted`         | `RIBBON_TOOLTIP_IDLE` + "waiting for quiet"             |
| `READY`          | `archive-restore` | `archivist-ready`    | `--interactive-accent` | `RIBBON_TOOLTIP_IDLE` + "last/next/full" composition    |
| `BACKUP_RUNNING` | `history`         | `archivist-running`  | `--interactive-accent` | `RIBBON_TOOLTIP_RUNNING`                                |
|                  | + pulse           | `+ archivist-pulse`  |                        |                                                         |
| `PASSIVE`        | `archive-restore` | `archivist-passive`  | `--text-faint`         | `RIBBON_TOOLTIP_PAUSED`                                 |
| `ERROR`          | `archive-restore` | `archivist-error`    | `--text-error`         | `RIBBON_TOOLTIP_ERROR`                                  |
| `AUTH_LOST`      | `archive-restore` | `archivist-error`    | `--text-error`         | `RIBBON_TOOLTIP_DISCONNECTED`                           |

New `strings.ts` additions required for extended tooltips (to be added in T7.3):
- `RIBBON_TOOLTIP_GRACE(minutesLeft: number): string`
- `RIBBON_TOOLTIP_QUIET_WAIT: string`
- `RIBBON_TOOLTIP_READY(lastAt: string, nextIncAt: string, nextFullAt: string): string`
- Aria-label variants (short, no dynamic numbers) for screen reader clarity.

### Implementation sketch (T7.3)

```ts
import { setIcon, setTooltip } from 'obsidian';

private applyState(state: FSMState): void {
  const iconName = state === 'BACKUP_RUNNING' ? 'history' : 'archive-restore';
  setIcon(this.ribbonEl, iconName);
  this.ribbonEl.className = `archivist-ribbon ${classFor(state)}`;
  this.ribbonEl.setAttribute('aria-label', ariaFor(state));
  setTooltip(this.ribbonEl, tooltipFor(state, this.clock));
}
```

### CSS (new `styles.css`)

```css
.archivist-ribbon svg { transition: color 150ms ease-in-out; }

.archivist-ribbon.archivist-muted   svg { color: var(--text-muted); }
.archivist-ribbon.archivist-ready   svg { color: var(--interactive-accent); }
.archivist-ribbon.archivist-running svg { color: var(--interactive-accent); }
.archivist-ribbon.archivist-passive svg { color: var(--text-faint); }
.archivist-ribbon.archivist-error   svg { color: var(--text-error); }

@keyframes archivist-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}
.archivist-ribbon.archivist-pulse svg {
  animation: archivist-pulse 1.6s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .archivist-ribbon.archivist-pulse svg { animation: none; }
}
```

### Accessibility checklist (T7.3 validation)

- [ ] `aria-label` reflects each of 8 FSM states, verified in unit tests.
- [ ] Color contrast against ribbon background ≥ 3:1 for each state (WCAG 2.1 AA for non-text UI components).
- [ ] Pulse animation honours `prefers-reduced-motion`.
- [ ] State information NEVER conveyed by color alone — tooltip carries the same signal.

---

## Settings Tab — Five Sections

Registered via `this.addSettingTab(new ArchivistSettingTab(app, plugin))`. Layout below is the `display()` render order.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Settings                                                              ✕   │
├─────────────────────┬──────────────────────────────────────────────────────┤
│ ► Archivist         │ ┌──────────────────────────────────────────────────┐ │
│                     │ │ ⚠  Storage: 168 GB of 200 GB used (84%).         │ │
│                     │ │    Consider raising the cap or reducing reten-   │ │
│                     │ │    tion.                      [Open Retention]   │ │
│                     │ └──────────────────────────────────────────────────┘ │
│                     │                                                      │
│                     │ ═══ Backup Schedule ═══════════════════════════════ │
│                     │                                                      │
│                     │  This device backs up the vault          [ ●═══○ ]  │
│                     │  └ Device ID: 7f3a2c…                    [ Copy  ]  │
│                     │                                                      │
│                     │  Full backup cadence               [ Weekly    ▾ ]  │
│                     │  Full backup day                   [ Sunday    ▾ ]  │
│                     │  Full backup time (local)          [ 03:00       ]  │
│                     │  Incremental backup interval       [ 15 min    ▾ ]  │
│                     │  Startup grace period (minutes)    [    10       ]  │
│                     │  Quiet period after edits (min)    [     2       ]  │
│                     │                                                      │
│                     │  Active backup window                    [ ○═══● ]  │
│                     │  └ (disabled unless toggled on)                     │
│                     │                                                      │
│                     │ ═══ Retention ═════════════════════════════════════ │
│                     │                                                      │
│                     │  Recent high-frequency window (h)  [    24       ]  │
│                     │    Keep every version from the last 24 hours.       │
│                     │  Never-prune window (days)         [    14       ]  │
│                     │    Keep every snapshot in this window.              │
│                     │  Daily retention (days)            [    30       ]  │
│                     │    After the never-prune window, keep one per day.  │
│                     │  Monthly retention (years)         [     3       ]  │
│                     │    After daily window, keep one per month.          │
│                     │                                                      │
│                     │  Hard storage limit (GB)           [   200       ]  │
│                     │  Warn at percent of cap            [    80       ]  │
│                     │                                                      │
│                     │  ┌──────────────────────────────────────────────┐   │
│                     │  │ Estimate: ~487 snapshots kept, ~12.4 GB      │   │
│                     │  │ Based on last 7-day edit rate.               │   │
│                     │  └──────────────────────────────────────────────┘   │
│                     │                                                      │
│                     │ ═══ Notifications ═════════════════════════════════ │
│                     │                                                      │
│                     │  Show pre-flight notice before full backups [●═○]   │
│                     │  Show toast after incremental backup        [○═●]   │
│                     │  Show toast after full backup               [●═○]   │
│                     │  Show toast on error                        [●═○]   │
│                     │                                                      │
│                     │ ═══ Advanced ══════════════════════════════════════ │
│                     │                                                      │
│                     │  Exclusion globs                                    │
│                     │  ┌──────────────────────────────────────────────┐   │
│                     │  │ .trash/**                                    │   │
│                     │  │ .obsidian/workspace*.json                    │   │
│                     │  │ *.tmp                                        │   │
│                     │  └──────────────────────────────────────────────┘   │
│                     │  One pattern per line. Supports *, **, ?, [abc].    │
│                     │                                                      │
│                     │  Enable reconcile scan on startup           [●═○]   │
│                     │  Dry-run mode (no uploads)                  [○═●]   │
│                     │  Diagnostic logging (paths in logs)         [○═●]   │
│                     │                                                      │
│                     │  Dropbox vault folder              [ my-vault    ]  │
│                     │    Folder under Apps/Archivist/. Changing starts    │
│                     │    a fresh backup history.              ⓘ           │
│                     │                                                      │
│                     │  Concurrent uploads          1 ──●───────── 8  [4]  │
│                     │  Upload chunk size (MB)      4 ──●───────── 64 [8]  │
│                     │                                                      │
│                     │ ═══ Dropbox ═══════════════════════════════════════ │
│                     │                                                      │
│                     │  ┌─ DISCONNECTED STATE ──────────────────────────┐  │
│                     │  │ Connect Dropbox to start backing up your      │  │
│                     │  │ vault.                                        │  │
│                     │  │                                               │  │
│                     │  │ Archivist stores backups in an app-scoped     │  │
│                     │  │ folder (Apps/Archivist/) and can only read    │  │
│                     │  │ or write within that folder.                  │  │
│                     │  │                                               │  │
│                     │  │                      [  Connect Dropbox  ]    │  │
│                     │  └───────────────────────────────────────────────┘  │
│                     │                                                      │
│                     │  ┌─ CONNECTED STATE ─────────────────────────────┐  │
│                     │  │ ✓ Connected as marcus@breiden.net             │  │
│                     │  │                                               │  │
│                     │  │            [ Re-authenticate ]  [ Disconnect ]│  │
│                     │  │                                               │  │
│                     │  │ Tokens are stored in plaintext in             │  │
│                     │  │ tokens.json (outside data.json). See README.  │  │
│                     │  └───────────────────────────────────────────────┘  │
└─────────────────────┴──────────────────────────────────────────────────────┘
```

### Controls inventory (per section)

**Backup Schedule** (T7.7):
- Toggle: `SETTINGS_DESIGNATED_TOGGLE` → `DeviceCoordinator.takeOwnership(bool)`.
- Read-only text + copy button: device ID (first 6 chars).
- Dropdown: `SETTINGS_FULL_CADENCE` — `weekly` / `biweekly` / `monthly`.
- Dropdown: full day (Sun–Sat).
- Time input: `SETTINGS_FULL_TIME` (HH:MM, local).
- Dropdown: `SETTINGS_INC_INTERVAL` — `5` / `15` / `30` / `60` min.
- Number input: `SETTINGS_STARTUP_GRACE` (default 10).
- Number input: `SETTINGS_QUIET_PERIOD` (default 2).
- Toggle + collapsible group: active backup window (C4 could-have — disabled by default).

**Retention** (T7.8):
- Number: `SETTINGS_RETENTION_RECENT_HOURS` (0–168, default 24).
- Number: `SETTINGS_RETENTION_NEVER_PRUNE` (0–14, default 14).
- Number: `SETTINGS_RETENTION_DAILY_DAYS` (0–90, default 30).
- Number: `SETTINGS_RETENTION_MONTHLY_YEARS` (0–10, default 3).
- Number: `SETTINGS_STORAGE_HARD_LIMIT` (GB, default 200).
- Number: `SETTINGS_STORAGE_WARN_AT` (%, default 80).
- Live-updating estimate row — drives `estimateRetention(profile, settings)` from `src/services/retention/estimator.ts` (new).

**Notifications** (T7.9):
- Toggle: `SETTINGS_PREFLIGHT_NOTICE` (default ON).
- Toggle: `SETTINGS_TOAST_AFTER_INC` (default OFF).
- Toggle: `SETTINGS_TOAST_AFTER_FULL` (default ON).
- Toggle: `SETTINGS_TOAST_ON_ERROR` (default ON).

**Advanced** (T7.9):
- Textarea: `SETTINGS_EXCLUSION_GLOBS` (one per line, glob-validated on save).
- Toggle: `SETTINGS_RECONCILE_SCAN` (default ON).
- Toggle: `SETTINGS_DRY_RUN` (default OFF).
- Toggle: `SETTINGS_DIAGNOSTIC_LOGGING` (default OFF).
- Text input: `SETTINGS_VAULT_PREFIX` (regex `/^[a-z0-9][a-z0-9_-]{1,63}$/`; changing opens confirm modal).
- Slider: `SETTINGS_UPLOAD_PARALLELISM` (1–8, default 4).
- Slider: `SETTINGS_CHUNK_SIZE` (4–64 MB, default 8).

**Dropbox** (T7.10):
- Disconnected: `OAUTH_EMPTY_STATE_TITLE`, `OAUTH_EMPTY_STATE_BODY`, `[OAUTH_CONNECT_BUTTON]`.
- Connecting: `OAUTH_CONNECTING` spinner.
- Connected: `OAUTH_CONNECTED_AS(email)`, `[Re-authenticate]`, `[OAUTH_DISCONNECT_BUTTON]`.
- Disconnect confirm modal: `OAUTH_DISCONNECT_CONFIRM_*` keys.
- Inline disclosure: token-plaintext note (SDD ADR-7).

**Persistent banner slot** (top of tab, T7.6):
- Storage warning (`STORAGE_LIMIT_WARN(pct)`).
- `OAUTH_REAUTH_REQUIRED` when FSM is in `AUTH_LOST`.
- `DEVICE_CONFLICT_BANNER` when two devices claim ownership.
- `PREDECESSOR_NOTICE` (T7.11) with `[PREDECESSOR_NOTICE_DISMISS]`.

---

## Strings gap — add during T7.3 / T7.6

The following keys are referenced by mockups but NOT yet in `strings.ts`. Add them in T7.3 (ribbon) and T7.6 (settings scaffold):

- `RIBBON_TOOLTIP_GRACE(minutesLeft: number)` — "Archivist — idle · starting in N min"
- `RIBBON_TOOLTIP_QUIET_WAIT` — "Archivist — idle · waiting for 2 min of quiet"
- `RIBBON_TOOLTIP_READY(lastAt, nextIncAt, nextFullAt)` — the composed form shown in solution.md:1195–1196.
- `RIBBON_ARIA_*` variants per state (short, no dynamic numbers).
- `SETTINGS_DEVICE_ID_COPY` — "Copy device ID".
- `SETTINGS_RETENTION_ESTIMATE(snapshots, gb)` — estimate row template.
- `SETTINGS_VAULT_PREFIX_CHANGE_CONFIRM_*` — migration confirm modal.

---

## Out of scope for Phase 7

- Backup Browser 3-column layout — Phase 8.
- File-history modal — Phase 8.
- Restore confirmation dialog — Phase 8.
- Storage "continue anyway" override flow — Phase 6 + Phase 8 integration.
