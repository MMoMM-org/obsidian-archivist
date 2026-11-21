---
title: "Phase 1: Tooling and test foundation"
status: completed
version: "1.0"
phase: 1
---

# Phase 1: Tooling and test foundation

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Architecture Decisions; ADR-5, ADR-6]`
- `[ref: SDD/Implementation Gotchas]`: obsidianmd 0.6.0 lints `manifest.json`/`LICENSE`; `npm install` must run unsandboxed; the mock lacks the `SettingTab` base, `debounce` and `setDestructive`.
- `[ref: SDD/Directory Map]`: `package.json`, `eslint.config.mjs`, `tests/fixtures/obsidian-mock.ts`, `tests/fixtures/recording-section-host.ts`.

**Key Decisions**:
- Exact pins: `obsidian` 1.14.4 and `eslint-plugin-obsidianmd` 0.6.0. Browserslist stays at `chrome 139`.
- `minAppVersion` stays at **1.11.4** in this phase. It is raised in T3.3, together with the removal of `display()`, so the `require-display` and `no-deprecated-display` rules switch over in the same commit as the code.

**Dependencies**:
- None. This is the first phase. Branch `feat/54-declarative-settings`, with PRD and SDD committed.

---

## Tasks

This phase establishes a toolchain that builds and lints against Obsidian 1.14.4 types, and a test fixture layer that can exercise a declarative `SettingTab`.

- [x] **T1.1 Toolchain on Obsidian 1.14.4** `[activity: build-platform]` `[ref: SDD/ADR-5; PRD/F6]`

  1. Prime:
     - Read the `eslint-plugin-obsidianmd` "Upgrading to 0.6.0" notes (`docs/configuration.md` in github.com/obsidianmd/eslint-plugin).
     - Read the current `eslint.config.mjs` and `package.json`.
     - `[ref: SDD/Implementation Gotchas]`
  2. Test (red):
     - With the new versions installed, `npm run lint` and `npm run typecheck` surface the full list of new findings.
     - Record that list in the task notes.
     - The expected findings in `src/ui/SettingsTab.ts` are `obsidianmd/prefer-setting-definitions` (line 46) and `@typescript-eslint/no-deprecated` on `setWarning` (line 258) and `setDynamicTooltip` (line 460). Record whether `display` is also flagged. They stay until Phase 3 and are tracked, not fixed, here.
  3. Implement:
     - Set `obsidian` to `1.14.4` and `eslint-plugin-obsidianmd` to `0.6.0` as exact pins in `package.json`.
     - Run `npm install` **outside the sandbox**.
     - Scope the TS and type-checked blocks in `eslint.config.mjs` with `files: ['src/**/*.ts']` so `manifest.json` and `LICENSE` linting doesn't abort.
     - Fix the new-rule findings **outside** `src/ui/SettingsTab.ts`:
       - `no-await-chainable`, `prefer-active-doc`, `validate-manifest`, `validate-license`;
       - rename any `no-misused-promises` disable comments (none expected; verify by grep).
     - Anything structural becomes its own issue, not a fix here.
     - Check the licence field of `eslint-plugin-obsidianmd@0.6.0` (`node_modules/eslint-plugin-obsidianmd/package.json`); it must be OSI-permissive (MIT expected) per Constitution Dependencies L1.
     - Write `evolution/2026-11/<date>-toolchain-obsidian-1.14.md`: the version bumps and why, the unsandboxed install, the eslint `files` scoping (Constitution Operations L2).
  4. Validate:
     - `npm run typecheck` passes.
     - `npm test` passes.
     - `npm run lint` passes except for the recorded `SettingsTab.ts` deprecation findings.
     - `npm ls obsidian eslint-plugin-obsidianmd` shows no `invalid` / `ELSPROBLEMS`.
  5. Success:
     - Lint mirrors the review bot's settings-tab rules locally. `prefer-setting-definitions` fires on `src/ui/SettingsTab.ts:46`, reproducing the scorecard warning `[ref: PRD/F6 AC2]`.
     - No dependency peer conflicts `[ref: SDD/ADR-5]`.

- [x] **T1.2 Declarative-capable test fixtures** `[activity: test-strategy]` `[ref: SDD/Directory Map; SDD/Implementation Gotchas (Mock)]`

  1. Prime:
     - Read `tests/fixtures/obsidian-mock.ts:481-529` (inert `PluginSettingTab` and `Setting`).
     - Read `tests/fixtures/recording-section-host.ts`.
     - Read the 1.14.4 d.ts `SettingTab` / `PluginSettingTab` / `ButtonComponent`.
  2. Test (red), in a new fixture self-test file `tests/fixtures/obsidian-mock.test.ts`:
     - mock `SettingTab.update()` records its calls and invokes `getSettingDefinitions()`;
     - `refreshDomState()` exists and is a no-op recorder;
     - `ButtonComponent.setDestructive()` records the destructive state;
     - `debounce(fn, ms, resetTimer)` is exported with Obsidian's semantics: with `resetTimer=false` it fires once, `ms` after the first call, and coalesces calls inside the window; it is driven by `window.setTimeout`, so vitest fake timers control it;
     - `RecordingSectionHost` captures `key`, `visible` and `aliases`, and `findField` skips specs whose `visible()` returns false unless `{ includeHidden: true }` is passed.
  3. Implement:
     - Extend `obsidian-mock.ts` with the 1.13+ `SettingTab` members (`settingItems`, `getSettingDefinitions`, `update`, `getControlValue`, `setControlValue`, `refreshDomState`), plus `setDestructive` / `removeDestructive` and `debounce`.
     - Extend `RecordingSectionHost` as tested.
     - Keep every existing mock behaviour intact.
  4. Validate:
     - All existing suites still pass unchanged.
     - The new fixture tests pass.
     - Lint and typecheck pass for test files under the project's config.
  5. Success:
     - Later phases can assert on definitions, update calls and destructive styling without a real Obsidian `[ref: SDD/Quality Requirements]`.
     - No existing test was weakened `[ref: PRD/F6 AC3]`.

- [x] **T1.3 Phase Validation** `[activity: validate]` `[ref: plan/README.md Context Priming; SDD/ADR-5]`

  - Success: toolchain on 1.14.4 with only the recorded `SettingsTab.ts` findings outstanding `[ref: PRD/F6 AC2]`.

  - Run `npm test`, `npm run typecheck` and `npm run lint`.
  - The only accepted lint findings are the recorded deprecation hits in `src/ui/SettingsTab.ts`.
  - `npm run build` succeeds.
  - Commit per task: `chore(deps): …` and `test(fixtures): …`.

---

## Deviations

| Date | Deviation | Rationale | Approved |
|---|---|---|---|
| 2026-11-21 | Five `obsidianmd/prefer-instanceof` **warnings** (modal focus capture) remain in addition to the recorded `SettingsTab.ts` findings | The fix changes popout-window focus behaviour and needs its own test first; tracked in #114. They are warnings, so lint still exits 0 | Yes, at the Phase 1 checkpoint |
| 2026-11-21 | `vitest.config.ts` changed (the `tests/fixtures/**` exclude was dropped), although the Directory Map did not list it | Without it the new `tests/fixtures/obsidian-mock.test.ts` is never collected | Yes, at the Phase 1 checkpoint |
| 2026-11-21 | The lint script still doesn't cover `manifest.json` or `LICENSE` | Out of scope for this spec; tracked in #115. They are clean when linted by hand | Yes, at the Phase 1 checkpoint |
