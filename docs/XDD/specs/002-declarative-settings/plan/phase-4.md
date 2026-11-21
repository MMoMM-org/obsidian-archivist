---
title: "Phase 4: Conditional rows and search synonyms"
status: pending
version: "1.0"
phase: 4
---

# Phase 4: Conditional rows and search synonyms

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Implementation Examples (active window rows)]`
- `[ref: SDD/Acceptance Criteria F7 / F8]`: the minimum alias set.
- `[ref: PRD/F7, F8]`

**Key Decisions**:
- F7: the active-window rows are always emitted, with `visible: () => ctx.getSettings().schedule.active_window_enabled`.
  - Their `onChange` reads `ctx.getSettings()` fresh. That is allowed only because F7 restructures these rows anyway.
  - The other sections keep their `onChange` bodies (#110 boundary).
- F8: aliases live in `src/ui/strings.ts` (English only) and are attached through `FieldSpec.aliases`.

**Dependencies**:
- Phase 3 complete: the declarative tab is live and the builder honours `visible` and `aliases`.

---

## Tasks

This phase delivers the two Should-have features on top of the declarative tab.

- [ ] **T4.1 Active-window rows react live (F7)** `[activity: build-feature]` `[ref: SDD/Implementation Examples; PRD/F7 AC1-2]`

  1. Prime:
     - Read `src/ui/settings/sections/BackupSchedule.ts:141-180`.
     - Read the "active-window pickers only when on" assertion in `tests/ui/settings-backup-schedule.test.ts`.
  2. Test (red):
     - the window start and end specs are always emitted with a `visible` predicate;
     - the predicate is false while `active_window_enabled` is off and true after the setting flips, with no re-run of the section;
     - `findField` (default, which skips hidden rows) does not find them while off;
     - `findField({ includeHidden: true })` finds them;
     - a write to one window field preserves a just-written value of the other, because the fresh read is used.
  3. Implement:
     - Remove the `if (active_window_enabled)` branch.
     - Emit both rows with the `visible` predicate and fresh-read `onChange`.
     - Fix the file-header comment, which today says "disabled unless toggle on".
  4. Validate:
     - The schedule suite passes.
     - The other suites are unchanged.
  5. Success:
     - The rows appear and disappear immediately and drop out of search while hidden `[ref: PRD/F7 AC1-2; PRD/F1 AC3]`.

- [ ] **T4.2 Search synonyms (F8)** `[activity: build-feature]` (after T4.1 — both edit `sections/BackupSchedule.ts`) `[ref: SDD/Acceptance Criteria F7/F8 #2; PRD/F8]`

  1. Prime:
     - Read `src/ui/strings.ts` conventions and `tests/ui/strings.test.ts`.
     - Read the PRD Settings inventory.
  2. Test (red):
     - every alias constant is a non-empty array of lowercase, trimmed, unique strings;
     - every row in the PRD F8 synonym table carries exactly its listed synonyms;
     - no alias equals a different row's label, which prevents misleading hits;
     - the builder copies the aliases onto the definitions.
  3. Implement:
     - Add `S.ALIASES_*` constants.
     - Attach them in the sections.
     - Implement exactly the synonym table in PRD F8 (requirements.md, Feature 8). No additions without updating that table first.
  4. Validate:
     - The strings and section suites pass.
     - Lint passes.
  5. Success:
     - Synonyms find their rows; unrelated words don't produce Archivist hits `[ref: PRD/F8 AC1-2]`.

- [ ] **T4.3 Phase Validation** `[activity: validate]` `[ref: PRD/F7, F8]`

  - Success: F7 and F8 acceptance criteria covered by passing tests `[ref: PRD/F7 AC1-2; PRD/F8 AC1-2]`.

  - Full `npm test`, `npm run lint`, `npm run typecheck` and `npm run build`.
  - Commit per task: `feat(settings): active window rows react immediately`, `feat(settings): search synonyms for settings`.
