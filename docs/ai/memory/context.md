# Context Memory

<!-- 2026-04-27 — review feedback on dir-restore + FileVersionsView -->

## Deferred Review Items

Findings from `/review` on `feat/backup-browser-dir-restore-and-versions-view` (branch `87ed702..30a8e26`) that were intentionally not actioned in the immediate post-review pass. Address in a follow-up cleanup PR or when the area is touched again.

### M7 — Cap parallelism on FileVersionsView manifest load (2026-04-27)
- Location: `src/ui/FileVersionsView.ts:224-226`
- Concern: `Promise.allSettled(snapshots.map(loadManifest))` opens N parallel fetches on view open. Cold start for a 1000-snapshot vault hits ManifestCache hard; warm-cache case is fine.
- Reason deferred: V1-acceptable for current vault sizes; needs a `p-limit` dep + chunked rendering refactor to do right.
- Branch: feat/backup-browser-dir-restore-and-versions-view

### M8 — `_renderVersionsList` rebuilds whole DOM list per click (2026-04-27)
- Location: `src/ui/FileVersionsView.ts:355` (and same anti-pattern in `BackupBrowserView`'s `renderSnapshotsColumn` / `renderFilesColumn`)
- Concern: Re-rendering all rows just to flip `aria-selected` on two of them. Up to 4000+ DOM ops per click for a 1000-version file.
- Reason deferred: Pre-existing pattern, not a regression. Fix touches both views and benefits from a shared `RowList` helper that doesn't yet exist.
- Branch: feat/backup-browser-dir-restore-and-versions-view

### M9 — `restoreDirectory` sequential — no concurrency cap (2026-04-27)
- Location: `src/services/RestoreOperations.ts:152-164`
- Concern: 50-file restore = 50 sequential round-trips. A small cap (e.g. 4) would 4× throughput while staying under Dropbox's 200/min limit.
- Reason deferred: Plan rationale (Dropbox throttling) explicitly chose sequential for V1. Add a TODO + advanced-setting hook when the loop is touched again.
- Branch: feat/backup-browser-dir-restore-and-versions-view

### M14 — Renamed-from `<span>` not deterministically in row's accessible name (2026-04-27)
- Location: `src/ui/FileVersionsView.ts:328-333`
- Concern: ARIA spec doesn't guarantee subtree concatenation for `role="option"` in all AT modes. Low risk but non-zero.
- Reason deferred: Speculative AT-mode-specific issue; cheap to add `aria-label` later when other accessible-name work touches this.
- Branch: feat/backup-browser-dir-restore-and-versions-view

### LOW-tier findings (polish batch) — 2026-04-27
The following 22 LOW-tier findings (L1–L22 in review) are batched as polish for a follow-up cleanup PR:

- Test gaps: `collectDirMatches` direct unit test, `buildFileTree` root-level file `fullPath` assertion, `Menu._last` / `ConfirmRestoreModal._last` reset between tests, stale-async flush count fragility.
- Accessibility polish: live-region for toast announcements, `archivist-fv-file-live` differentiated classes for present/missing, `aria-labelledby` on listbox containers (some done in H6, leftover BackupBrowser listboxes still pending).
- Code-quality refactors: 4-positional `CONFIRM_DIR_RESTORE_BODY` → named-args, extract `WorkspaceWithLeafState` alias for the inline workspace casts in main.ts, hoist `formatSnapshotDate` / `fvFormatTimestamp` into shared `src/ui/format.ts`, rename `restoreAsCopyAt` → `restoreAsCopyWithSharedTimestamp`, central `BannerCode` union.
- Minor perf: `computeMissingDirs` Set-memo per click, `buildFileTree` ancestor array reallocation reduction.
- DRY: `collectDirMatches` duplicates `restoreDirectory` filter — hoist to shared util, both call it.
- Comment WHY-vs-WHAT cleanup at `BackupBrowserView.ts:691`.
- Function decomposition: `_renderForCurrentPath` long async with 4 stale-bails — extract `_loadManifestsForPath` + `_renderVersionsAndAutoSelect`.
- API ergonomics: `buildCopyPath(orig, sharedTs?)` foreshadows positional bloat — switch to opts object when next touched.
- FV ArrowDown `preventDefault` only inside bounds check — move outside to match BackupBrowser's `wireArrowNav`.
- `_selectDir` no-await invariant comment.

Reason deferred: Polish-tier; bundling them into one cleanup PR keeps history clean and keeps the V1 ship-blocker scope focused.

<!-- 2026-04-25 evening — manual-test session -->
- **First-light end-to-end test session complete** on branch `feat/xdd-001-archivist-plugin`. Plugin reached "FULL backup + restore-in-place + Backup Browser navigation all visibly working" against real Dropbox. ~17 commits today (`41e8461` through `24d9b20`) covering: path double-prefix fix (Apps/Archivist/ no longer client-side because App-Folder OAuth scope auto-prefixes server-side), leading-slash normalisation in `DropboxClient.normalizeApiPath`, OAuth account-email backfill, scope-rights debug helper `scripts/dropbox-inspect.mjs`, ribbon centering + status-bar item with FSM state mirror, validation-error inline display, file-history command modal wiring, restore-in-place via `vault.modifyBinary` (not adapter.write+rename), Backup Browser polish (selection highlights, "Files at YYYY-MM-DD HH:MM" header, basename + path subtitle in preview column), open-or-focus pattern via `getLeavesOfType` + `revealLeaf`. All 1050 tests green at session end; manifest deployed to test vault at `0.1.0-dev.20260425-1518`. Many lessons documented in `docs/ai/memory/troubleshooting.md` (worth re-reading before next UI work).
- **Open TODOs for next session** (user-flagged at session close):
  - **(a) History of current file — rework.** The command + modal are wired (`163e15d`) but the user wants a UX overhaul. Anchor: `src/ui/FileHistoryModal.ts`. Likely scope: layout, version-row presentation, integration with the new Backup Browser preview-header pattern, possibly inline diff against current vault state.
  - **(b) Right-click / note context menu options.** Add Archivist actions to Obsidian's file-menu (right-click on a note in the file explorer + the editor's note-menu): "Show backup history" and "Restore previous version". Hook via `app.workspace.on('file-menu', ...)` and `app.workspace.on('editor-menu', ...)`. None are wired yet.
- **Test-vault state** (already deployed, ready for next session): vault prefix `test-vault`, Dropbox app folder under `/Apps/Archivist/test-vault/` with one FULL snapshot from 14:03 UTC. Tokens valid (refresh token persistent). Local `data.json` + `tokens.json` intact; `index.json` rebuilt by latest backup. Build mirror is `0.1.0-dev.20260425-1518` — disable/enable in Obsidian Community plugins to get a fresh load.

<!-- 2026-04-25 -->
- **Phase 10 complete** (2026-04-25). End-to-end integration suite (13 scenarios under `tests/integration/` + shared `createArchivistFixture()` harness with in-memory VaultAdapter + MockDropboxClient + InMemoryPluginStore), 4-week soak (`tests/soak/four-weeks.test.ts` — pre-seeded chain to avoid minute-resolution snapshot ID collisions; ~34ms runtime), pagination + SDK-contract pin tests on every PR, gated live-Dropbox smoke (`tests/live/`), 3 perf SLO gates (`tests/perf/{reconcile-warm, idle-tick, restore-e2e}`). Full main.ts onload rewrite wires all Phase 5–9 services (LazyDropboxProxy defers SDK construction until OAuth tokens land). README + CHANGELOG + LICENSE + Dependabot + release.sh + submission-audit.sh + ribbon.svg. 1032 tests passing; lint + typecheck + build all green. Submission audit clean. **Spec 001-archivist-plugin: implementation complete. Ready for v0.1.0 tag + GitHub Release + Community Plugin PR.**
- Pending USER actions before public listing: (1) author + upload `assets/icons/dropbox-app-512.png` to the Dropbox developer console; (2) optional `assets/icons/plugin-logo-256.png`; (3) `git tag -s v0.1.0` + `git push --tags`; (4) `bash scripts/release.sh` to assemble `dist/`; (5) `gh release create v0.1.0 dist/* --notes-file CHANGELOG.md`; (6) open PR against `obsidianmd/obsidian-releases` adding Archivist to `community-plugins.json`.

<!-- 2026-04-24 -->
- **Phase 9 complete** (2026-04-24). ConfirmRestoreModal (keyboard-safe destructive action, Modal subclass + DI via ModalHandle), PreviewPane (ADR-13 MarkdownRenderer-only, binary gate, plugin-advisory), BackupBrowserView (3-column ItemView, DST-safe date grouping, capture-before-await race safety, banner region, arrow-key nav, tier tags, deleted-file marker), FileHistoryModal (500-version pagination, preview via PreviewPane, restore via ConfirmRestoreModal→restoreInPlace, focus trap, autofocus non-destructive anchor). Phase-9 integration test covers 1k-file snapshot + 500-version pagination + history→restore flow. 1000 tests passing; lint + typecheck + build all green. Next step: **Phase 10 (Integration, Soak Tests & Release Readiness)**.
- Plugin wiring in `src/main.ts` still bootstrap-only — deferred to Phase 10. Will integrate Scheduler + Ribbon + Commands (registerBackupNowCommand + registerOpenBackupBrowserCommand + registerShowHistoryCommand) + SettingsTab + PredecessorDetector + RestoreService/Operations in the onload rewrite. View registration for `archivist-backup-browser` view-type lands there.

<!-- 2026-04-24 -->
- **Phase 8 complete** (2026-04-24). RestoreService (materializeVaultStateAt — chain merge from the SDD walkthrough; listVersionsForPath — Algorithm 3 with ROB-004 path-reuse guard + mirror-case alias termination for the reverse lineage), ManifestCache (snapshot-index + per-id cache with concurrent-dedup latch), RestoreOperations (per-path mutex, pre-write hash verify, atomic write), fetchContent + CONTENT_HASH_MISMATCH guard, standalone Restore CLI (`scripts/restore.mjs`, zero npm deps, 14 functions exported, atomic-dir pattern). 842 tests passing; lint + typecheck + build all green.

<!-- 2026-04-24 -->
- **Phase 7 complete** (2026-04-24). SchedulerFSM (8-state machine + scheduled-full planner with catch-up + pre-flight), NoticeCenter (dedup + resumed + banners), RibbonIcon (hybrid archive-restore/history+pulse, state-driven tooltip/aria), manual Back-up-now command, full 5-section SettingsTab (BackupSchedule / Retention / Notifications / Advanced / Dropbox) built on a SectionHost DOM-free abstraction, retention estimator (pure fn), and PredecessorDetector with dismissible banners. 757 tests passing; lint + typecheck + build all green.

<!-- 2026-04-23 -->
- **Phase 2 complete** (2026-04-23). Domain models (`src/model/`), infrastructure primitives (`src/infra/Hasher`, `src/infra/Logger`), utility modules (`src/util/{paths,time,glob,retry}`), and the full UI strings module (`src/ui/strings.ts`) are landed with 168 tests passing, lint + typecheck + build green. Settings migration engine exercised via 3 synthetic-schema scenarios plus the 5 failure modes from phase-2 T2.1.
- **Spec 001-archivist-plugin is Ready** on branch `feat/xdd-001-archivist-plugin`. 20 ADRs all user-approved, 10 phases with ~70 TDD tasks, 25/25 multi-reviewer findings addressed.
- **Dropbox app registered for V1**: App name `ObsidianArchivist` (globally unique Dropbox requirement) / app-folder name `Archivist` / CLIENT_ID `aanoqah5sn73rjb`. App-folder path: `/Apps/Archivist/<VAULT_PREFIX>/`. Publisher: Marcus Breiden. Privacy Policy URL: `https://github.com/MMoMM-org/obsidian-archivist/blob/main/PRIVACY.md`. CLIENT_ID lands as a compile-time constant in `src/config/dropbox.ts` during Phase 3 T3.3.
- **Outstanding before V1 public release (non-code)**: push repo to `github.com/MMoMM-org/obsidian-archivist` so the Privacy Policy URL resolves; upload 512×512 PNG app icon to the Dropbox app page and the ribbon SVG for the community listing (Phase 10 T10.6a).
- **Dev environment ready**: local Obsidian test vault at `test/Archivist/` (git-ignored) is pre-configured with the `hot-reload` plugin. Phase 1 T1.4's manual verification step ("load into a disposable Obsidian vault") can use this vault directly — no need to create one. Point Obsidian at this folder as a vault; the build pipeline (Phase 1 T1.2) should emit to `test/Archivist/.obsidian/plugins/obsidian-archivist/`.
- **Scope decisions locked**: Mobile deferred post-V1 (`isDesktopOnly: true`, PRD W8a captures re-add plan). Retention 3-tier MVP (never-prune + recent / daily / monthly; hourly and weekly tiers dropped, may return post-V1). No telemetry in V1. No client-side encryption in V1 (trade-off with CAS dedup; deferred).
