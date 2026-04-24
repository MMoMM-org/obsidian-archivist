---
title: "Phase 9: Backup Browser, File-History Modal & Restore UI"
status: in_progress
version: "1.0"
phase: 9
---

# Phase 9: Backup Browser, File-History Modal & Restore UI

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Cross-Cutting/User Interface & UX]`
- `[ref: SDD/Cross-Cutting/UI Visualization Guide]`
- `[ref: SDD/Acceptance Criteria — Feature 3, Feature 4]`
- `[ref: SDD/ADR-13]`
- `[ref: PRD/F3, F4]`

**Key Decisions**:
- All preview rendering via `MarkdownRenderer.render(...)` — no `innerHTML` on user content.
- Empty/loading/error states are first-class (not afterthoughts) — exact copy lives in `src/ui/strings.ts`.
- File-History modal paginates 50 at a time with [Show 50 more] (not infinite scroll).
- Restore confirmation dialog: Enter does NOT default to the destructive action; Escape closes.

**Dependencies**: Phase 2 (strings), Phase 8 (RestoreService), Phase 4 (VaultAdapter).

---

## Tasks

Produces the UI surfaces for restore — the features that fulfill the PRD promise "recover the right version in ≤ 3 clicks."

- [ ] **T9.1 BackupBrowserView (ItemView, 3-column layout)** `[activity: frontend-ui]`

  1. Prime: Read `[ref: SDD/Cross-Cutting/UI Visualization Guide]`, `[ref: PRD/F4]`.
  2. Test:
     - View registers a `WorkspaceLeaf` with view-type `archivist-backup-browser` and opens via command `Archivist: Open Backup Browser` and via ribbon click (desktop).
     - 3-column DOM present: `.archivist-snapshots`, `.archivist-files`, `.archivist-preview`; column widths driven by CSS flex with Obsidian CSS vars only.
     - Snapshots listed grouped by "Today / Yesterday / This week / This month / Older"; each row shows timestamp + type (full/inc) + tier tag.
     - Selecting a snapshot populates the file tree (middle column) by calling `RestoreService.materializeVaultStateAt(snapshotId)` and rendering the resulting paths as a nested tree.
     - Selecting a file fetches content via `RestoreService.fetchContent`; renders Markdown via `MarkdownRenderer.render`; for binary files shows the "binary file, no text preview" placeholder with Restore actions still enabled.
     - Empty state (no snapshots): renders the exact copy from `S.BROWSER_EMPTY_STATE`.
     - Loading state: skeleton/spinner on snapshot/file-list/preview transitions.
     - Error state: if `materializeVaultStateAt` throws `CHAIN_BROKEN`, displays the error inline without crashing the view.
     - Keyboard navigation: Tab moves between columns; arrows navigate within a column (selection follows focus).
     - Deleted-file restore: selecting a file whose path no longer exists in live vault shows the Restore actions (in place recreates missing dirs after confirm; as copy saves at recreated path).
     - `onunload` destroys the view cleanly.
  3. Implement: Create `src/ui/BackupBrowserView.ts` extending `ItemView`. Use `createEl` only (no `innerHTML`). Subscribe to storage warnings (persistent banner at top of the view).
  4. Validate: Component tests with a fake DOM + mocked `RestoreService`; accessibility test ensures tab-order is correct.
  5. Success: Feature 4 acceptance criteria `[ref: PRD/F4]`; safe preview `[ref: SDD/ADR-13]`.

- [ ] **T9.2 FileHistoryModal (version list with pagination + rename markers)** `[activity: frontend-ui]`

  1. Prime: Read `[ref: PRD/F3 user journey + AC-1..AC-5]`, `[ref: SDD/Runtime View/Primary Flow: File-Level Restore]`.
  2. Test:
     - Command `Archivist: Show history of current file` is registered; invoking it on an open markdown file opens a modal populated with versions (newest first) within 2s using `RestoreService.listVersionsForPath`.
     - Each row shows timestamp + size + tier tag; a live-now marker on the first row labeled `[now]`; files renamed in history are marked "Renamed from X on Y".
     - Single-version case shows a dedicated "Only one version on record" message AND the entry.
     - 50 rows shown initially; [Show 50 more] button loads next batch; no infinite scroll.
     - Preview action fetches content and renders via `MarkdownRenderer.render`.
     - Restore action opens `ConfirmRestoreModal`; on confirm, calls `RestoreService.restoreInPlace` and closes both modals.
     - Escape key closes the modal; focus returns to the editor.
     - Accessibility: modal traps focus; restore button is not the Enter-key default.
  3. Implement: Create `src/ui/FileHistoryModal.ts` extending `Modal`.
  4. Validate: Component tests + keyboard-nav tests; assert the one-version edge case is handled.
  5. Success: Feature 3 acceptance criteria `[ref: PRD/F3]`; accessibility `[ref: SDD/Quality Requirements/Usability]`.

- [ ] **T9.3 ConfirmRestoreModal** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read `[ref: research UX copy-draft — Restore in place]`, `[ref: SDD/Cross-Cutting/Interaction Design]`.
  2. Test:
     - Modal shows exact confirmation copy from `S.CONFIRM_RESTORE_IN_PLACE` including file path + snapshot timestamp + size.
     - Two buttons: `Cancel` (default) and `Replace`; Escape closes.
     - Enter does NOT trigger Replace; Tab-to-Replace-then-Space or a click is required.
     - On confirm, calls the supplied `onConfirm` callback; on cancel, calls `onCancel`; either way closes the modal and returns focus to the trigger.
     - When the target directory does not exist, the copy switches to `S.CONFIRM_RESTORE_CREATES_DIR` and lists the folders that will be created.
  3. Implement: Create `src/ui/ConfirmRestoreModal.ts` extending `Modal`.
  4. Validate: Component tests with keyboard drivers assert Enter is not destructive.
  5. Success: Destructive-action safety `[ref: research UX ACC-6]`.

- [ ] **T9.4 Preview pane safe rendering (+ co-installed plugin boundary notice)** `[activity: security]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/ADR-13 (revised)]`, `[ref: SDD/System-Wide Patterns/Security]`.
  2. Test:
     - Markdown input containing `<script>` tags / `javascript:` URLs / `onerror=` attributes is rendered harmlessly by `MarkdownRenderer.render` — no script execution (verified via fake DOM with `execCommand` tracking).
     - Binary file (image/PDF/other) never reaches the markdown renderer; the placeholder component is shown instead.
     - CSS styles applied use Obsidian CSS variables; no hard-coded hex.
     - ESLint rule `no-unsafe-innerhtml` prevents any regression that introduces `innerHTML =` in the preview code path (CI gate from T1.3 catches this).
     - **File-tree column (SEC-L2):** assert path rendering uses `el.createEl('span', {text: path})` or equivalent text-node insertion; never `innerHTML` or unencoded `href`. Test includes a vault path containing `<`, `>`, `"`, `&` characters — renders as literal text, not markup.
     - **Co-installed plugin advisory (SEC-H3, ADR-13 boundary):** on `BackupBrowserView` first open per session, check `this.app.plugins.enabledPlugins` for any of `['dataview', 'templater-obsidian', 'obsidian-tasks-plugin']`. If any present, fire a **one-time** notice: `S.PREVIEW_PLUGIN_ADVISORY` — "Previewing historical content may execute plugin code (Dataview/Templater/…) the same way as in a live note. The preview runs in your current plugin environment." Dismissed state persists in `data.json.ui.preview_plugin_advisory_dismissed`.
  3. Implement: Create `src/ui/PreviewPane.ts` exporting `renderPreview(containerEl, content, path, component)` that decides binary/text and calls `MarkdownRenderer.render` for text. Used by both `BackupBrowserView` and `FileHistoryModal`. Add `detectCodeEvalPlugins()` helper used by the advisory.
  4. Validate: Injection tests with malicious payloads; verify zero executions. Advisory tests with fake `app.plugins.enabledPlugins`.
  5. Success: XSS-to-Electron-RCE class ruled out for the common case `[ref: SDD/ADR-13]`; user informed about plugin-interaction boundary `[ref: SDD/ADR-13 threat-model boundary]`.

- [ ] **T9.5 Phase Validation** `[activity: validate]`

  - Run all Phase 9 tests. Integration: with mocked RestoreService, open Backup Browser, navigate a 10k-file snapshot, select a deleted-path file, confirm restore-in-place, verify the callback is called with the right args. Run `FileHistoryModal` on a 500-version fixture, confirm pagination works. Lint and typecheck pass.
