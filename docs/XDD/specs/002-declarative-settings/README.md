# Specification: 002-declarative-settings

## Status

| Field | Value |
|-------|-------|
| **Created** | 2026-11-20 |
| **Current Phase** | SDD |
| **Decomposition tier** | {{DECOMPOSITION_TIER}} |
| **Model tier** | {{MODEL_TIER}} |
| **Last Updated** | 2026-11-20 |

## Documents

| Document | Status | Notes |
|----------|--------|-------|
| requirements.md | completed | v1.0 approved — 8 features (6 Must, 2 Should, both in release), 32 acceptance criteria |
| solution.md | pending | |
| plan/ | pending | |

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
| 2026-11-20 | Phase transition PRD → SDD | PRD complete, 0 clarification markers. |

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
