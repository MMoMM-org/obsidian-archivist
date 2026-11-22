# Specification: 002-declarative-settings

## Status

| Field | Value |
|-------|-------|
| **Created** | 2026-11-20 |
| **Current Phase** | Implemented |
| **Decomposition tier** | Incremental |
| **Model tier** | hard |
| **Last Updated** | 2026-11-22 |

## Documents

| Document | Status | Notes |
|----------|--------|-------|
| requirements.md | completed | v1.0 approved — 8 features (6 Must, 2 Should, both in release), 32 acceptance criteria |
| solution.md | completed | v1.0 approved — 7 components, ADR-1…6 confirmed, 27 EARS criteria (24 + 3 failure-path criteria added at validation) |
| plan/ | completed | 5 phases, 20 tasks, 4 parallel-tagged (T2.2 ∥ T2.3, T5.1 ∥ T5.2); validated 2026-11-21 |

**Status values**: `pending` | `in_progress` | `completed` | `skipped`

**Decomposition tier**: `Direct` (no plan) | `Incremental` (phase plan). Set by the classifier at the decomposition step and confirmed by the user; leave the placeholder until then. Read back by `spec.py --read`, which treats anything it does not recognise as absent.

**Model tier**: `routine` | `hard` | `frontier`. The classifier recommends it at the decomposition step and the user confirms it; leave the placeholder until then. `spec.py --read` treats anything it does not recognise as absent.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-11-20 | Spec created for GitHub issue #54 | community.obsidian.md scorecard (scan 2026-09-01, v0.11.7) warns `src/ui/SettingsTab.ts:46` lacks `getSettingDefinitions()` — settings invisible to Obsidian 1.13+ settings search. Issue #54's "review bot starts flagging" trigger is now met. |
| 2026-11-20 | Research mode: Standard (3 parallel agents: current tab, 1.13 API d.ts, peer plugins) | Narrow scope — one tab, one API migration. |
| 2026-11-20 | Pre-existing settings-tab defects out of scope → separate GitHub issues | One feature/fix per change. Defects: stubbed Disconnect confirm (`main.ts:1238`), stale-snapshot onChange closures, silent number/glob rejection, deviceId never displayed / unused `readonly`+`button` kinds, active-window pickers only appear on next re-render, hidden-tab banner re-subscription via `refresh()`. |
| 2026-11-20 | `obsidian` dev-dep → 1.14.4; **minAppVersion 1.11.4 → 1.14.4**; declarative-only tab, `display()` removed | User choice over dual-support (Path B). Types == runtime floor, so no API can be used that the minimum app lacks. Users below 1.14.4 stay on the last compatible release via `versions.json`. Removes `display()` deprecation hits entirely. |
| 2026-11-20 | PRD approved; Should-haves F7 (conditional rows react live) and F8 (search synonyms) included in this release | User choice at PRD review. F7 closes the active-window re-render defect instead of a separate issue. |
| 2026-11-20 | Defect issues filed: #109 (stub Disconnect confirm), #110 (stale-snapshot onChange), #111 (silent number/glob rejection), #112 (deviceId never shown / unused kinds), #113 (hidden-tab banner re-subscription) | Out-of-scope decision above. Not placed on a Projects board — no Archivist board exists. Active-window re-render defect not filed: covered by F7. |
| 2026-11-20 | Phase transition PRD → SDD | PRD complete, 0 clarification markers. |
| 2026-11-20 | ADR-1 Translator over FieldSpec (DefinitionBuilderHost); display()/ObsidianSectionHost removed | Single source of truth, section suites stay valid. Alternative B (sections return definitions) rejected: full test rewrite, Obsidian types leak into sections. |
| 2026-11-20 | ADR-2 Inputs as `control` rows with dotted keys, routed via per-build registry to section onChange | Only control rows survive `update()` while focused (verified in 1.14.4 runtime). |
| 2026-11-20 | ADR-3 Event-driven debounced `update()` (banner sub in ctor, header-render fetch, refresh()) | No "tab shown" hook in the declarative API; guard + diff bound the loop. |
| 2026-11-20 | ADR-4 Non-input content as `render` rows; setDestructive; `visible` predicates (F7); `aliases` (F8) | Documented route for custom content. |
| 2026-11-20 | ADR-5 obsidian 1.14.4 + eslint-plugin-obsidianmd 0.6.0 (exact) | 0.4.2 exact-peers obsidian 1.8.7; installed 0.3.0 lacks settings-tab rules; local lint must mirror the bot. |
| 2026-11-20 | ADR-6 browserslist stays chrome 139 | 1.14.4 ships Chrome 150, but app updates don't update Electron; 139 is the stricter superset. |
| 2026-11-21 | SDD approved; ADR-4 render-row refinement accepted | Static text keeps its exact look as render rows (searchable:false). |
| 2026-11-21 | Decomposition tier: Incremental | Classifier recommended Incremental (component_count=2 new: DefinitionBuilderHost, customRows; feature_count=6; ac_count=32; no parallel markers in solution.md — the plan's later `[parallel: true]` tags are intra-phase only and don't change rule 1). Accepted. |
| 2026-11-21 | Model tier: hard | Classifier recommended hard (adr_count=6; high_risks=2; novel_pattern=false). Accepted. |
| 2026-11-21 | Plan written: 5 phases, 20 tasks | Incremental tier; TDD per task; T3.3 ships as `feat!` → 0.12.0 (`.releaserc` breaking→minor keeps pre-1.0). |
| 2026-11-21 | Spec validation (4 perspectives): 5 FAIL / ~20 WARN, all fixed | Key corrections: Obsidian `debounce` 3rd arg is `resetTimer` (→ `false`, not leading-edge); versions.json snapshot (old entries map to 1.5.0); refresh guard `try/finally`; Constitution L1 write-failure + ownership-failure tests; NoticeCenter path `src/ui/`; explicit F8 synonym table; evolution/2026-11 entry; T4.1→T4.2 serialised (shared file). Typing-wipe test downgraded to structural guard + manual check — logged as deviation in plan/phase-5.md. |
| 2026-11-21 | Phase → Ready | PRD, SDD, PLAN complete; readiness HIGH. |
| 2026-11-22 | Implementation complete | PR #116 (feat/54-declarative-settings, rebased on 0.11.7). Phases 1–5 done; 1630 tests, lint 0 errors, CI green. minAppVersion 1.11.4 → 1.14.4, `feat!` → release 0.12.0. Post-merge follow-ups (Dependabot unignore, scorecard re-check, optional handoff) tracked on #54. |

## Research Summary

- 1.13+ contract: `display()` is "Not called when getSettingDefinitions returns a non-empty array". `getSettingDefinitions()` is sync + cheap; `update()` rebuilds definitions and the search index (safe while the modal is closed); `refreshDomState()` re-evaluates `visible`/`disabled` only.
- Search indexes only definitions (`name`, `desc` textContent, `aliases`); hand-built DOM is invisible. `render: (setting, group) => cleanup?` rows are indexed by name/desc but don't auto-save.
- No `button` control type: multi-button rows → `render` row. `setWarning` → `setDestructive`; `setDynamicTooltip` deprecated (sliders show value inline). New: `Setting.setErrorMessage`, `ConfirmationModal`.
- Existing `FieldSpec`/`SectionHost` abstraction (`src/ui/settings/SectionHost.ts`) means section renderers are already data-shaped — reuse them as the single source of truth.
- Sources: d.ts of obsidian 1.13.0/1.13.1/1.14.4 (scratchpad), docs.obsidian.md Settings + "Migrate to declarative settings", obsidianmd/eslint-plugin settings-tab rules, peer plugins (BRAT, Maps, Hider, Templater).

## Context

- Issue: #54 — migrate to Obsidian 1.13 declarative settings API (`PluginSettingTab.display` → `getSettingDefinitions`; `ButtonComponent.setWarning` → `setDestructive`).
- Constraint (decided): `minAppVersion` raised 1.11.4 → 1.14.4; no fallback path for older Obsidian.
- Constraint: local `obsidian` dev-dep pinned at 1.12.3 with Dependabot ignore on minor bumps; moves to 1.14.4 and the ignore is lifted.
- Behaviour to preserve: persistent banners (quota, auth-lost, device-conflict) re-render, async refresh of device-id / designated device / Dropbox email + usedBytes.
- Cross-plugin: Kado, Hashi, Hakobi likely share the pattern — Archivist goes first, others follow via handoff.

---
*This file is managed by the xdd-meta skill.*
