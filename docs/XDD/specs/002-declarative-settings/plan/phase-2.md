---
title: "Phase 2: Definition building blocks"
status: pending
version: "1.0"
phase: 2
---

# Phase 2: Definition building blocks

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Internal API Changes]`: `FieldSpec` additions and the `DefinitionBuilderHost` interface.
- `[ref: SDD/Application Data Models]`: the `FieldSpec.kind` → definition mapping table and the `DefinitionBuildResult` shape.
- `[ref: SDD/Implementation Examples]`: the write guard and the active window rows.
- `[ref: SDD/Implementation Gotchas]`: dropdown option order and render-row naming.
- `[ref: SDD/User Interface & UX]`: the existing `archivist-*` classes are kept.

**Key Decisions**:
- ADR-1: the builder is the only place where Obsidian declarative types appear. Sections stay free of Obsidian types.
- ADR-2: input kinds become `control` rows keyed by dotted `PluginSettings` paths. The non-setting key `ui.device_designated` is reserved.
- ADR-4: every non-input kind becomes a `render` row. Internal names are `header`, `banner:<code>` and `static:<section>:<n>`.

**Dependencies**:
- Phase 1 complete: 1.14.4 types installed, mock extended.

---

## Tasks

This phase delivers a tested, standalone translation from Archivist's `FieldSpec` stream to Obsidian setting definitions. It isn't wired into the tab yet.

- [ ] **T2.1 FieldSpec keys and styling vocabulary** `[activity: domain-modeling]` `[ref: SDD/Internal API Changes; PRD/F2, F4]`

  1. Prime:
     - Read `src/ui/settings/SectionHost.ts:14-159` and all five `src/ui/settings/sections/*.ts`.
     - Read `src/model/Settings.ts` for the exact field paths.
  2. Test (red). Update the section suites (`tests/ui/settings-*.test.ts`):
     - every input field each section emits carries the expected dotted `key`, e.g. `schedule.full_cadence`, `retention.daily_days`, `advanced.vault_prefix`;
     - the designated toggle uses `ui.device_designated`;
     - keys are unique within a section;
     - the Dropbox connected-state Disconnect action has `destructive: true` and Re-authenticate does not;
     - Connect has neither.
  3. Implement:
     - Add a required `key` to the input `FieldSpec` kinds.
     - Add optional `visible` and `aliases` to all kinds.
     - Rename `ActionRowFieldSpec.actions[].warning` to `destructive`.
     - Add keys to every section emission. This is a mechanical change; `onChange` bodies stay as they are (#110 boundary).
     - Keep `ObsidianSectionHost` compiling by mapping `destructive` to the old `setWarning()` until Phase 3 deletes it.
     - Declare the `CustomRowRenderers` interface (one method per non-input kind, each `(setting: Setting, spec) => void | (() => void)`) in `SectionHost.ts`, so T2.2 and T2.3 can proceed in parallel against it.
  4. Validate:
     - All section suites pass.
     - The existing order, label and bound assertions are unchanged.
     - Typecheck passes.
  5. Success:
     - Every inventory input has a stable, unique key that matches its `data.json` path `[ref: SDD/Data Storage Changes]`.
     - Destructive intent is expressed in the model `[ref: PRD/F4 AC1-2]`.

- [ ] **T2.2 DefinitionBuilderHost** `[activity: build-feature]` `[parallel: true]` `[ref: SDD/Application Data Models; SDD/Implementation Examples]`

  1. Prime:
     - Read the mapping table and the `DefinitionBuilderHost` interface `[ref: SDD/Internal API Changes]`.
     - Read the 1.14.4 d.ts `SettingDefinitionGroup` / `SettingControl` / `SettingDefinitionRender` / `SettingDefinitionBase`.
  2. Test (red). New `tests/ui/settings-definition-builder.test.ts`:
     - `heading()` opens a new group with that heading;
     - `topBanner()` and `header()` go into the untitled first group, with the header first;
     - each input kind maps to its `control` type with `key`, min/max/step, placeholder and options;
     - dropdown options keep the emitted order for the actual option sets;
     - a text spec's `validate` null/message maps to `undefined`/message;
     - `name`, `desc`, `aliases` and `visible` are copied through;
     - non-input kinds become `render` rows with `searchable:false` and internal names (link and actionRow stay searchable with name = label);
     - `result().registry` maps each key to its spec;
     - a duplicate key within a group throws;
     - dropdown options for day-of-week (`"0"`–`"6"`) and interval (`"5"`, `"15"`, `"30"`, `"60"`) keep their emitted order in the options record;
     - a top group with zero banners holds only the header;
     - a group whose rows all have `visible: () => false` is still emitted, with every predicate attached.
  3. Implement:
     - Create `src/ui/settings/DefinitionBuilderHost.ts` (file-level "why" comment) implementing `SectionHost` plus `header()` and `result()`.
     - It depends on `CustomRowRenderers` through an injected interface, so it can be tested with a fake.
  4. Validate:
     - The new suite passes.
     - Lint passes with no `innerHTML` and no Obsidian DOM in the builder.
     - The file stays well under 300 lines.
  5. Success:
     - Every `FieldSpec` kind has a defined, tested mapping `[ref: SDD/Acceptance Criteria F1 #1-3]`.
     - Every text-entry row is a `control` `[ref: SDD/Acceptance Criteria F3 #6]`.

- [ ] **T2.3 CustomRowRenderers** `[activity: build-feature]` `[parallel: true]` `[ref: SDD/Components (CustomRowRenderers); SDD/User Interface & UX]`

  1. Prime:
     - Read today's DOM code in `src/ui/SettingsTab.ts`: `renderHeader` at 140-161, static at 205, link at 263-270, banner at 272-298, actionRow at 251-261.
     - Read `styles.css:7-123` (including the banner severity classes at 113-123).
  2. Test (red). New `tests/ui/settings-custom-rows.test.ts`, run against the mock `Setting`:
     - the header renders the plugin name, `v<version>`, the author link (falling back to the README) and the Documentation link;
     - a banner renders its message with severity classes, a CTA "Resolve" when `action` is set, and Dismiss with `dismissLabel ?? 'Dismiss'` when `onDismiss` is set;
     - static text renders as a paragraph with `archivist-static-text`;
     - the link renders an anchor with `archivist-doc-link`;
     - an action row renders the buttons in order, with `setDestructive()` only on destructive actions and `setCta()` only on CTA actions;
     - every renderer clears the default name text where today's look has none.
  3. Implement:
     - Create `src/ui/settings/customRows.ts` (file-level "why" comment) by moving the DOM code out of `ObsidianSectionHost`.
     - Use `setDestructive()` instead of `setWarning()`.
     - Use only `Setting`/`createEl` APIs.
  4. Validate:
     - The new suite passes.
     - The local `no-unsafe-innerhtml` rule passes.
     - `@typescript-eslint/no-deprecated` reports nothing for this file.
  5. Success:
     - The header, banners and static content look as they do today `[ref: PRD/F2 AC2]`.
     - Disconnect is destructive and Connect is neutral `[ref: PRD/F4 AC1-2]`.

- [ ] **T2.4 Phase Validation** `[activity: validate]` `[ref: SDD/Application Data Models (mapping table)]`

  - Success: every `FieldSpec` kind maps as the SDD table says, with tests `[ref: PRD/F1 AC1; PRD/F2 AC1]`.

  - Run all Phase 2 suites, `npm run typecheck` and `npm run lint`. The accepted findings are still only the old `SettingsTab.ts` ones.
  - Cross-check the builder against the SDD mapping table row by row.
  - Commit per task: `refactor(settings): add control keys…`, `feat(settings): definition builder…`, `refactor(settings): extract custom row renderers…`.
