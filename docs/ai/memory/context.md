# Context Memory

<!-- reconciled 2026-11-27 (#68) — replaces the 2026-04-23..28 snapshot -->

## Current state (2026-11-27)

- Latest release **0.12.8**, listed in the official community plugin registry.
- Open issues: **#67** (multi-day backup + prune integration test), **#73** (README screenshots — needs the user to capture them).

## Still-open deferred review items

From the `/review` of `feat/backup-browser-dir-restore-and-versions-view` (2026-04-27). Re-checked against code on 2026-11-27; none is tracked in an issue yet. Address when the area is touched again.

- **M7** FileVersionsView opens one manifest fetch per snapshot at once — `src/ui/FileVersionsView.ts` `Promise.allSettled(...)` in the load path. No concurrency cap; fine at current vault sizes.
- **M8** `_renderVersionsList` re-renders every row on each click just to move `aria-selected`; the same pattern is in BackupBrowserView's `renderSnapshotsColumn` / `renderFilesColumn`. A shared row-list helper would fix both.
- **M9** `RestoreOperations.restoreDirectory` restores files one after another (`for (const path of matches)`). Sequential was a deliberate V1 choice (Dropbox throttling); a cap of ~4 would speed up large directory restores.
- **M14** FileVersionsView version rows (`role="option"`) carry no `aria-label`; the renamed-from span is not guaranteed to be part of the accessible name.
- **LOW polish batch** (still open as of 2026-11-27):
  - `formatSnapshotDate` (BackupBrowserView) and `fvFormatTimestamp` (FileVersionsView) are duplicates — hoist to a shared `src/ui/format.ts`.
  - `restoreAsCopyAt` → clearer name (`restoreAsCopyWithSharedTimestamp`); `buildCopyPath(orig, sharedTs?)` → opts object.
  - `collectDirMatches` duplicates the `restoreDirectory` path filter — share one util.
  - BackupBrowserView listboxes lack `aria-labelledby` (FileVersionsView has it).
  - Central `BannerCode` union, `WorkspaceWithLeafState` alias for the workspace casts in `main.ts`, `CONFIRM_DIR_RESTORE_BODY` named args.
  - Minor: `computeMissingDirs` memo, `_renderForCurrentPath` decomposition, FV ArrowDown `preventDefault` placement.

## Done (history)

- **Post-V1 review of PRs #11–#15 (2026-04-28), 37 findings in clusters A–G — all shipped:** A a11y → #16 (also covers H5), B vault identity → #19, C repair perf + tests → #20, G chain-walk depth → #21 (comments corrected in #131 / #64), D hot paths → #22, F `data.json` write serialization → #23, E docs + copy (incl. M2 Path B) → #24.
- **2026-04-25 session TODOs:** the file-history rework became FileVersionsView (`1847b86`); the right-click entry ships via the `file-menu` hook in `main.ts` (covers file explorer + note more-options menu).
- Phase 1–10 progress notes, the Dropbox app registration and the test-vault setup are in git history, `docs/XDD/specs/001-archivist-plugin/README.md` and `tools.md`.
