# Context Memory

<!-- reconciled 2026-11-27 (#68) — replaces the 2026-04-23..28 snapshot -->

## Current state (2026-11-28)

- Latest release **0.14.3**, listed in the official community plugin registry.
- Open issues: **#67** (multi-day backup + prune integration test), **#73** (README screenshots — needs the user to capture them), plus the deferred items below. Priority labels: `P0-must` / `P1-should` / `P2-could`.

## Still-open deferred review items

From the 2026-04-27 review, filed as issues on 2026-11-27:

- **P1** #134 FileVersionsView manifest cache thrashes above 50 snapshots (M7)
- **P2** #136 directory restore with a small concurrency cap (M9)
- **P2** #137 update row selection in place instead of re-rendering (M8)

## Done (history)

- **2026-11-28:** #135 row `aria-label` (0.14.3); #138 LOW polish batch (shared timestamp formatter, `pathsUnderDir`, `BannerCode` union, listbox labels, arrow-key fix).
- **Post-V1 review of PRs #11–#15 (2026-04-28), 37 findings in clusters A–G — all shipped:** A a11y → #16 (also covers H5), B vault identity → #19, C repair perf + tests → #20, G chain-walk depth → #21 (comments corrected in #131 / #64), D hot paths → #22, F `data.json` write serialization → #23, E docs + copy (incl. M2 Path B) → #24.
- **2026-04-25 session TODOs:** the file-history rework became FileVersionsView (`1847b86`); the right-click entry ships via the `file-menu` hook in `main.ts` (covers file explorer + note more-options menu).
- Phase 1–10 progress notes, the Dropbox app registration and the test-vault setup are in git history, `docs/XDD/specs/001-archivist-plugin/README.md` and `tools.md`.
