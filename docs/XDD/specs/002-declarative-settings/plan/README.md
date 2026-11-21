---
title: "Searchable settings — declarative settings tab for Archivist"
status: approved
version: "1.0"
---

# Implementation Plan

## Validation Checklist

### CRITICAL GATES (Must Pass)

- [x] All `[NEEDS CLARIFICATION: ...]` markers have been addressed
- [x] All specification file paths are correct and exist
- [x] Each phase follows TDD: Prime → Test → Implement → Validate
- [x] Every task has verifiable success criteria
- [x] A developer could follow this plan independently

### QUALITY CHECKS (Should Pass)

- [x] Context priming section is complete
- [x] All implementation phases are defined with linked phase files
- [x] Dependencies between phases are clear (no circular dependencies)
- [x] Parallel work is properly tagged with `[parallel: true]`
- [x] Activity hints provided for specialist selection `[activity: type]`
- [x] Every phase references relevant SDD sections
- [x] Every test references PRD acceptance criteria
- [x] Integration & E2E tests defined in final phase
- [x] Project commands match actual project setup

---

## Output Schema

### PLAN Status Report

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| specId | string | Yes | Spec identifier (NNN-name format) |
| title | string | Yes | Feature title |
| status | enum: `DRAFT`, `IN_REVIEW`, `COMPLETE` | Yes | Document readiness |
| phases | PhaseStatus[] | Yes | Status of each implementation phase |
| totalTasks | number | Yes | Total tasks across all phases |
| parallelTasks | number | Yes | Tasks marked `[parallel: true]` |
| specReferences | number | Yes | Count of `[ref: ...]` specification links |
| clarificationsRemaining | number | Yes | Count of `[NEEDS CLARIFICATION]` markers |

### PhaseStatus

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| phase | number | Yes | Phase number |
| name | string | Yes | Phase name |
| status | enum: `COMPLETE`, `NEEDS_CLARIFICATION`, `IN_PROGRESS` | Yes | Current state |
| tasks | number | Yes | Task count in this phase |
| file | string | Yes | Path to phase file (phase-N.md) |
| detail | string | No | What needs clarification or what's in progress |

---

## Specification Compliance Guidelines

### How to Ensure Specification Adherence

1. **Before Each Phase**: Complete the Pre-Implementation Specification Gate
2. **During Implementation**: Reference specific SDD sections in each task
3. **After Each Task**: Run Specification Compliance checks
4. **Phase Completion**: Verify all specification requirements are met

### Deviation Protocol

When implementation requires changes from the specification:
1. Document the deviation with clear rationale
2. Obtain approval before proceeding
3. Update SDD when the deviation improves the design
4. Record all deviations in this plan for traceability

## Metadata Reference

- `[parallel: true]` - Tasks that can run concurrently
- `[component: component-name]` - For multi-component features
- `[ref: document/section; lines: 1, 2-3]` - Links to specifications, patterns, or interfaces and (if applicable) line(s)
- `[activity: type]` - Activity hint for specialist agent selection
- `[model: routine|hard|frontier]` - Overrides the spec's model tier for this task

### Success Criteria

**Validate** = Process verification ("did we follow TDD?")
**Success** = Outcome verification ("does it work correctly?")

```markdown
# Single-line format
- Success: [Criterion] `[ref: PRD/AC-X.Y]`

# Multi-line format
- Success:
  - [ ] [Criterion 1] `[ref: PRD/AC-X.Y]`
  - [ ] [Criterion 2] `[ref: SDD/Section]`
```

---

## Context Priming

*GATE: Read all files in this section before starting any implementation.*

**Specification**:

- `docs/XDD/specs/002-declarative-settings/requirements.md`: product requirements. Features F1–F8 and the Settings inventory.
- `docs/XDD/specs/002-declarative-settings/solution.md`: solution design. Components, mapping table, refresh algorithm, ADR-1 to ADR-6, EARS criteria.
- `docs/XDD/specs/002-declarative-settings/README.md`: decisions log, research summary, out-of-scope issues #109–#113.
- External: https://docs.obsidian.md/Plugins/User+interface/Settings and the 1.14.4 `obsidian.d.ts` (after T1.1, at `node_modules/obsidian/obsidian.d.ts`).

**Key Design Decisions**:

- **ADR-1:** `FieldSpec` is translated into definitions. Sections keep emitting `FieldSpec`. The new `DefinitionBuilderHost` turns them into Obsidian definitions. `display()` and `ObsidianSectionHost` are deleted.
- **ADR-2:** inputs become `control` rows with dotted keys. `get`/`setControlValue` route through a per-build key → spec registry into the section's `onChange`. The write guard keeps today's silent rejections.
- **ADR-3:** a debounced `update()` drives every refresh:
  - the banner subscription is created in the constructor and torn down on unload;
  - the async fetch starts when the header row renders;
  - `refresh()` forces an update;
  - the `refreshing` guard plus a change check prevent loops.
- **ADR-4:** non-input content becomes `render` rows with `searchable:false` and internal names. `setDestructive()` replaces `setWarning()`. F7 uses `visible` predicates and F8 uses `aliases`.
- **ADR-5:** `obsidian` 1.14.4 and `eslint-plugin-obsidianmd` 0.6.0, both exact pins. `minAppVersion` becomes 1.14.4 and browserslist stays at `chrome 139` (ADR-6).

**Implementation Context**:

```bash
# Install — run OUTSIDE the Bash sandbox (npm cache ~/.npm is outside the write set)
npm install

# Testing
npm test                    # vitest unit tests (obsidian aliased to tests/fixtures/obsidian-mock.ts)
npm run test:coverage       # with v8 coverage

# Quality
npm run lint                # eslint src/ && stylelint styles.css
npm run typecheck           # tsc --noEmit

# Full validation
npm run build               # tsc --noEmit + esbuild production build
```

---

## Implementation Phases

Each phase is defined in a separate file. Tasks follow red-green-refactor: **Prime** (understand context), **Test** (red), **Implement** (green), **Validate** (refactor + verify).

> **Tracking Principle**: Track logical units that produce verifiable outcomes. The TDD cycle is the method, not separate tracked items.

- [x] [Phase 1: Tooling and test foundation](phase-1.md)
- [x] [Phase 2: Definition building blocks](phase-2.md)
- [x] [Phase 3: Declarative settings tab](phase-3.md)
- [x] [Phase 4: Conditional rows and search synonyms](phase-4.md)
- [ ] [Phase 5: Docs, integration and release readiness](phase-5.md)

**Dependencies:** Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 (linear). Parallel tasks exist only inside phases.

**Commit cadence:** one conventional commit per task (`chore(deps)`, `test`, `refactor`, `feat`, `docs`). The task that raises `minAppVersion` (T3.3) uses `feat!:` with a `BREAKING CHANGE:` footer. `.releaserc` maps `breaking → minor`, so this releases **0.12.0** (it stays below 1.0, which is deliberate) and the changelog lists it as breaking.

---

## Plan Verification

Before this plan is ready for implementation, verify:

| Criterion | Status |
|-----------|--------|
| A developer can follow this plan without additional clarification | ✅ |
| Every task produces a verifiable deliverable | ✅ |
| All PRD acceptance criteria map to specific tasks | ✅ (traceability table in phase-5.md) |
| All SDD components have implementation tasks | ✅ |
| Dependencies are explicit with no circular references | ✅ |
| Parallel opportunities are marked with `[parallel: true]` | ✅ |
| Each task has specification references `[ref: ...]` | ✅ |
| Project commands in Context Priming are accurate | ✅ (from package.json) |
| All phase files exist and are linked from this manifest as `[Phase N: Title](phase-N.md)` | ✅ |
