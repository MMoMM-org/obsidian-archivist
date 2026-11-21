---
title: "Phase 3: Declarative settings tab"
status: pending
version: "1.0"
phase: 3
---

# Phase 3: Declarative settings tab

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Internal API Changes (ArchivistSettingTab)]`
- `[ref: SDD/Runtime View]`: the primary flow, the banner and OAuth secondary flows, and Complex Logic with its traced walkthrough.
- `[ref: SDD/Error Handling]`
- `[ref: SDD/Integration Points]`: `main.ts:194`, `:1220`, `:1258-1263`, `:1277`; `NoticeCenter.ts:207-212`.

**Key Decisions**:
- ADR-2: `setControlValue` runs the write guard, then `spec.onChange`, then `scheduleUpdate()`. `getControlValue` returns `registry.get(key)?.value`.
- ADR-3: `scheduleUpdate = debounce(() => this.update(), 150, false)`. Obsidian's third argument is `resetTimer`; `false` fires 150 ms after the first call and coalesces the rest of the window.
  - The banner subscription is created in the constructor and torn down via `deps.register`.
  - The header render row starts `refreshAsyncFields(false)`.
  - `refresh()` forces an update.
- `minAppVersion` is raised in this phase (T3.3) so the lint rule switch-over (`require-display` → `no-deprecated-display`) lands together with the removal of `display()`.

**Dependencies**:
- Phase 2 complete: keys in `FieldSpec`, `DefinitionBuilderHost`, `CustomRowRenderers`.

---

## Tasks

This phase replaces the imperative tab with the declarative one. At the end of it, Archivist's settings are searchable on 1.14.4 and refresh live.

- [ ] **T3.1 Declarative ArchivistSettingTab contract** `[activity: build-feature]` `[ref: SDD/Internal API Changes; SDD/Implementation Examples (write guard)]`

  1. Prime:
     - Read the current `src/ui/SettingsTab.ts` in full.
     - Read the SDD write-guard example and the Error Handling section.
     - Read `tests/ui/settings-tab.test.ts`.
  2. Test (red). Rewrite `tests/ui/settings-tab.test.ts`:
     - `getSettingDefinitions()` returns 6 groups: untitled top, then Schedule, Retention, Notifications, Advanced, Dropbox account;
     - the top group holds the header followed by banners in `getPersistentBanners()` order;
     - `getControlValue(key)` returns the current build's value;
     - `setControlValue`:
       - calls `onChange` exactly once for an accepted value;
       - silently drops NaN or out-of-range numbers and textarea values that fail validation;
       - ignores unknown keys;
       - for `ui.device_designated`, calls take/release and writes no settings;
       - schedules `update()` after every accepted write;
       - when `onChange` rejects (an `updateSettings` failure), produces no unhandled rejection, still schedules exactly one `update()`, and does not loop (Constitution L1 failure path);
       - when `takeOwnership()` rejects, writes no settings field and leaves `ctx.deviceDesignated` unchanged;
       - rapid toggling of `schedule.active_window_enabled` (on/off/on inside 150 ms) yields one `update()` and the last value saved;
       - the STORAGE banner row sits in the Retention group when injected usage is at or above the threshold, and is absent below it and when `hard_limit` is 0;
     - `persistentToBannerSpec` behaves as before;
     - the class has no own `display` or `hide` member.
  3. Implement:
     - Rewrite `src/ui/SettingsTab.ts`:
       - `getSettingDefinitions` runs the header, the top banners and the 5 sections through a fresh `DefinitionBuilderHost`, and stores the registry;
       - override `getControlValue` and `setControlValue`;
       - keep `persistentToBannerSpec` exported.
     - Delete `display()`, `hide()`, `ObsidianSectionHost`, `renderHeader` and `subscribeBannerUpdates`.
  4. Validate:
     - All settings suites pass.
     - `@typescript-eslint/no-deprecated` and `prefer-setting-definitions` report nothing for `src/ui/SettingsTab.ts`.
     - The file is ≤ 300 lines.
  5. Success:
     - Every inventory row is emitted as a definition `[ref: PRD/F1 AC1]`.
     - Values and validation behave as before `[ref: PRD/F2 AC1, AC4-7]`.
     - The designated toggle keeps its side effects `[ref: PRD/F2 AC7]`.

- [ ] **T3.2 Refresh orchestration** `[activity: build-feature]` `[ref: SDD/Complex Logic; SDD/Runtime View (secondary flows); PRD/F3]`

  1. Prime:
     - Read the Complex Logic algorithm and the traced walkthrough.
     - Read `src/ui/SettingsTab.ts:112-138` from before the rewrite (in git history), for the guard and change-check semantics.
     - Read `main.ts:1240-1280`.
  2. Test (red), using fake timers:
     - a NoticeCenter banner change triggers `update()` 150 ms after it, both with the tab "visible" and with it not;
     - a burst of 3 banner changes inside 150 ms produces exactly one `update()`, 150 ms after the first;
     - the header render triggers one fetch;
     - a fetch with no change does not call `update()`; a fetch with a change calls it once;
     - a second fetch while one is in flight is skipped;
     - a rejected fetch keeps the cached value, raises no error, and resets the guard, so a second fetch afterwards runs (`try/finally`);
     - plugin teardown during an in-flight fetch completes without throwing and resets the guard;
     - `refresh()` always calls `update()`;
     - the traced walkthrough (open after OAuth) runs to the expected 2 fetches and 1 `update()`;
     - the teardown registered through `deps.register` unsubscribes from NoticeCenter;
     - a connected/disconnected state change switches the Account row on the next build.
  3. Implement:
     - Constructor: subscribe to banners and register the unsubscribe through `deps.register`.
     - Implement `refreshAsyncFields(force)` with the guard and change check, then `scheduleUpdate()`.
     - Make the header render callback start the fetch.
     - Update `src/main.ts` to pass `register: (fn) => this.register(fn)` in the tab's deps. Nothing else in `main.ts` changes; the pre-fill stays.
  4. Validate:
     - All tests pass.
     - No `this.display()` anywhere in `src/` (`prefer-update-over-display` reports nothing).
     - Lint passes.
  5. Success:
     - Banners and account state update live `[ref: PRD/F3 AC1-3]`.
     - The refresh loop is bounded `[ref: PRD/Detailed Spec Rule 5]`.
     - No visible work happens while the modal is closed beyond `update()` refreshing the search index `[ref: PRD/F3 AC5]`.

- [ ] **T3.3 Raise minAppVersion to 1.14.4** `[activity: build-platform]` `[ref: SDD/Deployment View; PRD/F5 AC1-2]`

  1. Prime:
     - Read `manifest.json`, `versions.json` and `version-bump.mjs`.
     - Read the `.releaserc` `releaseRules` (`breaking → minor`).
  2. Test (red):
     - a small test asserts `manifest.json.minAppVersion === '1.14.4'`;
     - the same test compares `versions.json` against a committed snapshot of today's entries (0.1.0–0.7.9 → `1.5.0`, 0.8.0–0.11.x → `1.11.4`), which guards against hand edits. New file: `tests/release-metadata.test.ts`.
  3. Implement:
     - Set `minAppVersion` to `"1.14.4"` in `manifest.json`.
     - Leave `versions.json` alone; `version-bump.mjs` adds the new entry at release.
     - Remove the temporary `requireApiVersion('1.13.0')` guard (`markDestructive` in `src/ui/settings/customRows.ts`) and its "before Obsidian 1.13" test block in `tests/ui/settings-custom-rows.test.ts`; call `btn.setDestructive()` directly (added at the Phase 2 checkpoint).
     - Commit as `feat!: declarative settings — searchable in Obsidian settings search` with the footer `BREAKING CHANGE: requires Obsidian 1.14.4 or newer; older Obsidian keeps 0.11.x`.
  4. Validate:
     - `npm run lint` reports **zero** findings: `require-display` no longer applies and `no-deprecated-display` is clean.
     - `npm test` and `npm run build` pass.
  5. Success:
     - The version floor is declared `[ref: PRD/F5 AC1]`.
     - Users on older Obsidian keep 0.11.x through the existing `versions.json` entries `[ref: PRD/F5 AC2]`.
     - Lint is fully clean against 1.14.4 types `[ref: PRD/F6 AC2]`.

- [ ] **T3.4 Phase Validation** `[activity: validate]` `[ref: SDD/Acceptance Criteria F2, F3, F5/F6]`

  - Success: declarative tab live, lint fully clean against 1.14.4 `[ref: PRD/F1 AC1; PRD/F3; PRD/F6 AC2]`.

  - Full `npm test`, `npm run typecheck`, `npm run lint` (0 errors, 0 warnings from the settings-tab rules) and `npm run build`.
  - Grep `src/` for `display(`, `setWarning(` and `setDynamicTooltip(`; it must return nothing `[ref: SDD/Acceptance Criteria F5/F6 #2]`.
  - Commit per task.
