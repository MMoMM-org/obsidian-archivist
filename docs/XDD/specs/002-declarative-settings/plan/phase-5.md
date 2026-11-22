---
title: "Phase 5: Docs, integration and release readiness"
status: in_progress
version: "1.0"
phase: 5
---

# Phase 5: Docs, integration and release readiness

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Quality Requirements]`
- `[ref: SDD/Acceptance Criteria F5/F6]`
- `[ref: SDD/Implementation Gotchas (branch base)]`
- `[ref: PRD/F5 AC3-4; PRD/F6 AC1, AC4; PRD/Success Metrics]`

**Key Decisions**:
- The behaviours the mock cannot show are verified manually in a real Obsidian 1.14.4: keyed re-render preserving focus, search result navigation, and inline slider values.
- Lifting the Dependabot `obsidian` ignore and running the post-release scorecard check happen after merge and are tracked here as follow-ups.

**Dependencies**:
- Phases 1–4 complete.

---

## Tasks

This phase closes the spec: user docs, an integration test across the whole tab, manual verification in real Obsidian, and a PR ready for release.

- [x] **T5.1 User docs state Obsidian 1.14.4** `[activity: technical-writing]` `[parallel: true]` `[ref: PRD/F5 AC3; SDD/Directory Map (docs)]`

  1. Prime:
     - Read `README.md:107` (the 1.11.4 mention refers to the history of `secretStorage` and stays).
     - Read `docs/installation.md:8` and `docs/troubleshooting.md:18-19`.
  2. Test (red): grep the docs for any minimum-version statement still saying 1.11.4. Each hit is a failure, except historical mentions such as the `secretStorage` introduction.
  3. Implement:
     - State "Obsidian 1.14.4 or newer" as the minimum.
     - Add the content PRD F5 AC3 names: installs on older Obsidian stay on the last 0.11.x release and receive no further updates; updating Obsidian to 1.14.4 or newer unlocks the new release.
     - Add a troubleshooting note: settings missing from search means the Obsidian version is below 1.14.4.
  4. Validate: re-run the grep; markdown renders.
  5. Success: the docs and the manifest agree `[ref: PRD/F5 AC3]`.

- [x] **T5.2 Settings CSS after the heading change** `[activity: design-visual]` `[parallel: true]` `[ref: SDD/User Interface & UX (Tokens)]`

  1. Prime:
     - Read `styles.css:7-123`, especially the `.archivist-settings h2` rules at 39-55.
     - Check how Obsidian 1.14.4 renders group headings: the `setting-group` / heading classes in the app's DOM.
  2. Test (red): `npm run lint:css` passes; dead selectors are listed.
  3. Implement:
     - Retarget or remove the `h2` rules to match the group heading markup.
     - Keep the banner, header and static classes.
     - No CSS features beyond `chrome 139` (ADR-6).
  4. Validate: `npm run lint:css` passes, and a visual check is done in T5.4.
  5. Success: the tab looks as before apart from the sanctioned group headings `[ref: PRD/F2 AC1]`.

- [x] **T5.3 Whole-tab integration test from a 0.11.x data.json** `[activity: test-strategy]` `[ref: SDD/Quality Requirements (Reliability); PRD/F1 AC1, F2 AC1-3]`

  1. Prime:
     - Read the existing settings fixtures and migration tests for the `data.json` loading path.
     - Read the PRD Settings inventory.
  2. Test (red). New `tests/ui/settings-tab.integration.test.ts`:
     - build the real tab, with all 5 real sections, from a captured 0.11.x `data.json` fixture with non-default values;
     - assert every inventory label is present as a searchable definition;
     - assert every control returns its stored value through `getControlValue`;
     - assert header, banner, static and estimate rows are `searchable:false`;
     - assert the vault_prefix, HH:MM and number rows are `control` (not `render`);
     - assert both Dropbox states expose the Account row;
     - assert the STORAGE banner row appears in the Retention group with injected usage above the threshold and not below it;
     - assert writing each control round-trips to the same `PluginSettings` path in the fixture's shape.
  3. Implement: the fixture and the test only. Fix production code only if the test exposes a real gap, and record it as a deviation in this file.
  4. Validate: the suite passes; coverage of `DefinitionBuilderHost.ts` and `SettingsTab.ts` is ≥ 90 % of lines.
  5. Success:
     - Upgrade safety is proven: no reset or renamed settings `[ref: PRD/F2 AC3]`.
     - The inventory is complete `[ref: PRD/F1 AC1]`.

- [x] **T5.4 Manual verification in Obsidian 1.14.4** `[activity: validate]` `[ref: SDD/Quality Requirements; PRD/Success Metrics (Tracking: manual search smoke check)]`

  1. Prime: `npm run build`, then install the build into a test vault on Obsidian 1.14.4 or newer.
  2. Test: run the checklist and record pass/fail per line in this file under "Verification log":
     - every inventory label is found through global settings search;
     - selecting a result opens Archivist's tab at that row;
     - each F8 alias finds its row;
     - the active-window rows are hidden from search while off, and appear immediately when toggled;
     - while typing in "Dropbox vault folder", trigger `refresh()` via a command or by disconnecting and reconnecting: the input keeps its text and focus;
     - raising and clearing a banner while the tab is open updates it;
     - Disconnect is destructive-styled and Re-authenticate is neutral;
     - sliders show their value inline;
     - HH:MM shows an inline error on bad input;
     - the visuals match 0.11.x apart from the group headings.
  3. Implement: fix any failures in the owning task's files, with a regression test where the mock can express it.
  4. Validate: all lines pass.
  5. Success: the PRD acceptance criteria that only real Obsidian can show are confirmed `[ref: PRD/F1 AC2; PRD/F3 AC4; PRD/F7]`.

- [ ] **T5.5 PR and release readiness** `[activity: build-platform]` `[ref: SDD/Constraints CON-4; PRD/F6 AC1, AC4]`

  1. Prime:
     - Read `.github/PULL_REQUEST_TEMPLATE.md`.
     - Read the memory notes "wait for CI before merge" and "PR state — verify".
  2. Test: `git fetch && git rebase origin/main`, which picks up the 0.11.7 release commit. Then run the full `npm test`, `lint`, `typecheck` and `build` on the rebased branch.
  3. Implement:
     - Open the PR referencing #54 and spec 002, listing #109–#113 as known out-of-scope items.
     - Watch the checks with `gh pr checks --watch`.
     - Post-merge follow-ups, recorded on #54:
       - comment `@dependabot unignore obsidian` on the next Dependabot group PR (the ignore lives on GitHub, not in `.github/dependabot.yml`);
       - after Obsidian re-scans the release, run `/obsidian-eval` and confirm the `getSettingDefinitions` warning is gone with no new flags;
       - optionally send an `_outbox/` handoff to Kado, Hashi and Hakobi describing the migration pattern.
  4. Validate: CI is green from the step logs, not just the badge (memory note on CI false greens).
  5. Success:
     - The PR is mergeable with all checks green `[ref: PRD/F6 AC3]`.
     - The follow-ups for the scorecard `[ref: PRD/F6 AC1]` and Dependabot `[ref: PRD/F6 AC4]` are tracked.

- [ ] **T5.6 Phase Validation** `[activity: validate]` `[ref: SDD/Quality Requirements; PRD/Success Metrics]`

  - Success: every row of the traceability table below is satisfied and ticked `[ref: PRD/F1–F8]`.

  - Full suite, lint (0), typecheck, build.
  - The traceability table below is fully ticked.
  - Commit per task: `docs: …`, `style(settings): …`, `test(settings): …`.

---

## PRD → task traceability

| PRD criterion | Task(s) |
|---|---|
| F1 AC1 (every inventory row findable) | T3.1, T5.3, T5.4 |
| F1 AC2 (result opens the tab) | T5.4 |
| F1 AC3 (hidden rows not in search) | T4.1, T5.4 |
| F1 AC4 (Dropbox row in both states) | T3.2, T5.3 |
| F1 AC5 (informational text not required) | T2.2, T5.3 |
| F2 AC1 (same sections, rows, labels) | T2.1, T3.1, T5.2, T5.3 |
| F2 AC2 (header and banners at top) | T2.3, T3.1 |
| F2 AC3 (0.11.x values kept) | T5.3 |
| F2 AC4 (saves to the same setting) | T3.1, T5.3 |
| F2 AC5 (inline error for HH:MM / vault folder) | T2.2, T5.4 |
| F2 AC6 (silent rejection kept) | T3.1 |
| F2 AC7 (designated toggle side effects) | T2.1, T3.1 |
| F2 AC8 (STORAGE banner threshold) | T3.1, T5.3 |
| F3 AC1 (banners live) | T3.2, T5.4 |
| F3 AC2 (Dropbox state live) | T3.2 |
| F3 AC3 (background values, failure fallback) | T3.2 |
| F3 AC4 (typing not lost) | T2.2 (control rows), T5.4 |
| F3 AC5 (no visible work while closed) | T3.2 |
| F4 AC1-2 (destructive styling) | T2.1, T2.3, T5.4 |
| F5 AC1-2 (version floor, older users kept) | T3.3 |
| F5 AC3 (docs) | T5.1 |
| F5 AC4 (changelog calls it out) | T3.3 (`feat!` + `BREAKING CHANGE` footer) |
| F6 AC1 (scorecard clean) | T5.5 (post-release `/obsidian-eval`) |
| F6 AC2 (lint clean on 1.14.4) | T1.1, T3.3 |
| F6 AC3 (tests pass, none deleted without replacement) | T1.2, T3.1, T5.5 |
| F6 AC4 (Dependabot ignore lifted) | T5.5 |
| F7 AC1-2 | T4.1, T5.4 |
| F8 AC1-2 | T4.2, T5.4 |

## Verification log

Run 1, 2026-11-21: user, test vault `test/Archivist/`, Obsidian 1.14.4, build `0.11.6-dev.20261121-1442` (the vault's data.json is a real 0.11.x-era config).

| # | Check | Result |
|---|---|---|
| 1 | Every inventory label findable via global settings search | ✅ |
| 2 | Selecting a result opens Archivist's tab at that row | ✅ |
| 3 | Each F8 alias finds its row | ✅ |
| 4 | Active-window rows hidden from search while off, appear immediately on toggle | ✅ |
| 5 | Typing in "Dropbox vault folder" survives a refresh (text + focus) | ✅ |
| 6 | Banner raised/cleared while open updates live | ✅ |
| 7 | Disconnect destructive, Re-authenticate neutral | ✅ |
| 8 | Sliders show their value inline | ✅ |
| 9 | Invalid HH:MM shows an inline error | ✅ |
| 10 | Looks like 0.11.x apart from group headings | ❌ Toggling "Active backup window" on/off duplicates render rows: the static "…tokens are kept in Obsidian…" sentence appears three times in a row, and the version header repeats too. Cause: render rows re-rendered by `update()` stack content; fix in T2.3's `customRows.ts` (see Deviations) |

Run 2, 2026-11-22: user, same vault, build with 775199f + ee4a3e6. Re-check of #10 only.

| # | Check | Result |
|---|---|---|
| 10 | Looks like 0.11.x apart from group headings; toggling "Active backup window" repeatedly leaves header, static text, banner and Dropbox buttons single | ✅ |

## Deviations

| Date | Deviation | Rationale | Approved |
|---|---|---|---|
| 2026-11-21 | PRD risk row "explicit regression test" for the typing-wipe is met by a structural automated guard (all text-entry rows are `control` rows) plus manual T5.4, not a behavioural unit test | The test mock cannot reproduce Obsidian's keyed re-render; the structural property is what guarantees the behaviour in the 1.14.4 runtime | Yes, at spec validation |
| 2026-11-21 | T5.1/T5.2 doc-quality fixes made by the orchestrator directly (README minimum, hedged troubleshooting checklist, one-line headings CSS note), not by a re-dispatched implementer | Mechanical doc edits; spec + code-quality reviews ran on them | Yes, at T5.4 |
| 2026-11-21 | T5.4 found render rows duplicating on `update()` (header, static text). Fix in T2.3's `customRows.ts`: renderers return a cleanup, and `drawIntoInfo` (WeakMap) drops the previous element before redrawing (775199f, ee4a3e6) | Obsidian reuses a render row's Setting: cleanup → `clear()` (controlEl only) → setName/setDesc → render, verified in the 1.15.x app.asar. The earlier claim "render rows are always rebuilt" was wrong. The WeakMap guard holds even if 1.14.4 never runs the cleanup between passes. Banner and actionRow buttons rely on Obsidian's `clear()` | Yes, at T5.4 |
