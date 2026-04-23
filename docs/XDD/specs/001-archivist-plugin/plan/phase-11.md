---
title: "Phase 11: Mobile Affordances & Accessibility"
status: pending
version: "1.0"
phase: 11
---

# Phase 11: Mobile Affordances & Accessibility

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/ADR-12 — isDesktopOnly=false, mobile read-only]`
- `[ref: SDD/Cross-Cutting/User Interface & UX — accessibility]`
- `[ref: SDD/Risks/Implementation Gotchas — mobile suspension]`
- `[ref: PRD/S4 — mobile restore]`
- `[ref: research UX — Accessibility Requirements + Mobile Affordances]`

**Key Decisions**:
- Mobile reduces the 3-column Backup Browser to a single-column stack (snapshot list → file list → preview with Back button).
- Mobile ribbon shows only two states: "Tap to back up now" or "Passive — backups run on desktop."
- No scheduling on mobile — the SchedulerFSM is not instantiated when `Platform.isMobileApp`.
- Every destructive button gains extra spacing on mobile (48 px tap target min).
- Full keyboard-nav support on desktop (Tab + arrows); all modals trap focus.
- Every user-visible glyph also has a text label OR `aria-label` — no color-only states.

**Dependencies**: Phase 7 (Ribbon), Phase 9 (BackupBrowserView, FileHistoryModal, ConfirmRestoreModal), Phase 10 (SettingsTab).

---

## Tasks

Produces the platform-parity and accessibility layer. Most work is refinement rather than new surfaces.

- [ ] **T11.1 Platform detection + conditional features** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/ADR-12]`, `[ref: SDD/Risks/Implementation Gotchas]`.
  2. Test:
     - `platform.isMobileApp === true` → SchedulerFSM is NOT instantiated in `main.ts.onload`; no intervals registered.
     - Desktop → SchedulerFSM is instantiated as usual.
     - Mobile → manual-backup command is registered only if `advanced.allow_manual_backup_mobile === true`.
     - Mobile → settings "This device performs backups" toggle is disabled + shows the explanation string.
  3. Implement: Add `src/util/platform.ts` exporting `isMobileApp()`, `isDesktopApp()`. Use Obsidian `Platform` API. Guard scheduler instantiation in `main.ts`.
  4. Validate: Unit tests with a fake platform; end-to-end test on a real iOS/Android test vault (manual) verifies no crash on plugin enable.
  5. Success: No mobile scheduler `[ref: SDD/ADR-12]`; no Obsidian suspension issues `[ref: SDD/Risks]`.

- [ ] **T11.2 BackupBrowserView — mobile single-column stack** `[activity: frontend-ui]`

  1. Prime: Read `[ref: research UX — Mobile Affordances]`.
  2. Test:
     - On mobile, the view renders a single column with three tabs (Snapshots / Files / Preview); a back button replaces the column metaphor.
     - Tapping a snapshot navigates to the Files view; tapping a file navigates to Preview; back button returns.
     - Restore actions in Preview view are laid out with 48 px minimum tap targets and visible separation between destructive and non-destructive actions.
     - Preview view loads Markdown via `MarkdownRenderer.render` same as desktop.
     - CSS responds to viewport; a Cypress-equivalent (or jsdom with media-query fake) confirms the layout swap.
  3. Implement: Update `BackupBrowserView` with a responsive layout; prefer CSS over JS branching where possible; use Obsidian CSS media-query pattern.
  4. Validate: Component tests run twice — once with mobile-width fake viewport, once with desktop-width.
  5. Success: Mobile usability `[ref: PRD/S4]`.

- [ ] **T11.3 Ribbon mobile state reduction** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: research UX — Ribbon mobile states]`.
  2. Test:
     - `isMobileApp()` path returns a simplified two-state tooltip/aria-label: "Tap to back up now" (if manual allowed) or "Passive — backups run on desktop" (otherwise).
     - Mobile ribbon click with manual-enabled fires a manual incremental (via an ad-hoc BackupService instantiation if needed — no scheduler dependency).
     - Mobile ribbon click with manual-disabled is a no-op with a one-time info notice explaining how to enable it in settings.
  3. Implement: Update `RibbonIcon` to branch on platform.
  4. Validate: Unit tests with fake platform.
  5. Success: Mobile ribbon UX `[ref: research UX]`.

- [ ] **T11.4 Accessibility — keyboard navigation** `[activity: frontend-ui]`

  1. Prime: Read `[ref: SDD/Quality Requirements/Usability — keyboard]`, `[ref: research UX — ACC-1, ACC-5]`.
  2. Test:
     - In `BackupBrowserView` (desktop), Tab moves between columns in order (snapshots → files → preview actions); Shift-Tab reverses.
     - Within a list column, ArrowUp/ArrowDown move selection; Enter opens the default action; Home/End jump to first/last.
     - In `FileHistoryModal` and `ConfirmRestoreModal`, focus is trapped (Tab cycles within the modal); Escape closes.
     - The ribbon icon is focusable and has `role="button"` and `tabindex="0"`.
  3. Implement: Add keyboard handlers + `tabindex` attributes to the three UI modules; ensure Obsidian's `Modal` focus-trap default is not overridden.
  4. Validate: Keyboard-driver tests in the fake DOM; real-Obsidian manual sweep.
  5. Success: WCAG 2.1 AA keyboard nav for the feature surfaces `[ref: SDD/Quality Requirements]`.

- [ ] **T11.5 Accessibility — aria + contrast + theming** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: research UX — ACC-2, ACC-3, ACC-4]`.
  2. Test:
     - Every ribbon state has a unique `aria-label` from `strings.ts`.
     - No hard-coded colors: a CI grep rule flags any `#[0-9a-fA-F]{3,8}` in `styles.css` except for CSS custom properties (`var(--*)`).
     - Dark-mode and default-theme screenshots (manual, Phase 12 soak) show no contrast-insufficient element.
     - Error states pair color with a shape or text change (icon + text, not just red).
  3. Implement: Audit `styles.css` + every UI module's inline styles (if any); migrate to CSS vars. Add `aria-label` attributes. Add error-state icons (Obsidian icon tokens).
  4. Validate: Lint + unit tests on aria-label presence; CI grep for hard-coded colors.
  5. Success: Theme-agnostic + accessible `[ref: research UX — ACC-3, ACC-4]`.

- [ ] **T11.6 Phase Validation** `[activity: validate]`

  - Run all Phase 11 tests. Manual sweep on: macOS Obsidian, Obsidian iOS, Obsidian Android, default Obsidian theme, a popular community theme (e.g., Minimal). Verify: no layout breakage, no crash, ribbon states render correctly, keyboard nav works on desktop, tap targets comfortable on mobile. Lint and typecheck pass.
