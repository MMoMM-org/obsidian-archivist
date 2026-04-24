---
title: "Archivist — Implementation Plan"
status: draft
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

## Specification Compliance Guidelines

### How to Ensure Specification Adherence

1. **Before Each Phase**: Complete the Pre-Implementation Specification Gate (read the linked SDD section).
2. **During Implementation**: Reference specific SDD sections in each task.
3. **After Each Task**: Run Specification Compliance checks (lint, typecheck, `npm test`).
4. **Phase Completion**: Verify all specification requirements are met against the acceptance criteria in PRD §Feature Requirements and SDD §Acceptance Criteria.

### Deviation Protocol

When implementation requires changes from the specification:
1. Document the deviation with clear rationale in the phase file.
2. Obtain approval before proceeding.
3. Update SDD when the deviation improves the design.
4. Record all deviations in the Decisions Log of the spec README.

## Metadata Reference

- `[parallel: true]` - Tasks that can run concurrently within the same phase
- `[ref: document/section; lines: X-Y]` - Links to specifications
- `[activity: type]` - Hint for specialist selection (e.g. `domain-modeling`, `backend-api`, `frontend-ui`, `integration`, `validate`, `tooling`, `security`, `testing`)

---

## Context Priming

*GATE: Read all files in this section before starting any implementation.*

**Specification**:

- `docs/XDD/specs/001-archivist-plugin/requirements.md` — Product Requirements
- `docs/XDD/specs/001-archivist-plugin/solution.md` — Solution Design
- `docs/XDD/specs/001-archivist-plugin/README.md` — Spec status & decisions log
- `2026-04-23-archivist-plugin.md` — Source brainstorm (rationale only; PRD/SDD supersede)

**Key Design Decisions** (from SDD §Architecture Decisions):

- **ADR-1**: Content-Addressed Storage (SHA-256) — dedup + integrity + clean GC boundary.
- **ADR-2**: Hybrid change detection — vault events + reconcile scan; hash is the authority.
- **ADR-3**: Commit protocol — upload blobs → upload manifest → update HEAD. Crash-safe.
- **ADR-4**: Rename is first-class in the Inc manifest — `renames: {from, to}[]`.
- **ADR-5**: GC lock marker file; list content AFTER manifest upload.
- **ADR-6**: Designated-device with startup HEAD-conflict detection.
- **ADR-7**: Token in dedicated `tokens.json` (plaintext, OUTSIDE `data.json`) via `app.vault.adapter.write`; README disclosure + chmod 600; `safeStorage` deferred. `data.json` holds only settings + device block.
- **ADR-8**: PKCE code-verifier Map (cap 5, TTL 10 min); cleared on `onunload`.
- **ADR-10**: WebCrypto `crypto.subtle.digest` — cross-platform (desktop + mobile).
- **ADR-11**: `index.json` OUTSIDE `data.json` — avoids Obsidian Sync churn.
- **ADR-12**: `isDesktopOnly: true` — mobile deferred post-V1; Phase 11 (mobile + a11y) removed from the plan; accessibility folds into phases 8 and 9.
- **ADR-13**: `MarkdownRenderer.render()` only for previews — rules out XSS-to-Electron-RCE.
- **ADR-14**: Pinned Dropbox SDK + lockfile + Dependabot + `npm audit` CI gate.
- **ADR-16**: Transitive chain-integrity for retention via topological walk.
- **ADR-17**: Retention runs after each successful backup, throttled to once per 24h.

**Implementation Context**:

```bash
# Testing
npm test                    # Unit tests (vitest)
npm run test:watch          # vitest watch
npm run test:coverage       # vitest with v8 coverage

# Quality
npm run lint                # eslint (obsidianmd rules + local innerHTML ban)
npm run build               # tsc --noEmit + esbuild production bundle
npm run dev                 # esbuild watch (development)

# Supply chain
npm audit                   # must pass on high/critical before release
```

---

## Implementation Phases

Each phase is defined in a separate file. Tasks follow red-green-refactor: **Prime** (understand context), **Test** (red), **Implement** (green), **Validate** (refactor + verify).

> **Tracking Principle**: Track logical units that produce verifiable outcomes. The TDD cycle is the method, not separate tracked items.

- [x] [Phase 1: Foundation & Scaffolding](phase-1.md)
- [x] [Phase 2: Domain Models & Infrastructure Primitives](phase-2.md)
- [x] [Phase 3: Dropbox Client & OAuth](phase-3.md)
- [x] [Phase 4: Change Detection & Event Queue](phase-4.md)
- [x] [Phase 5: Backup Pipeline & Device Coordination](phase-5.md)
- [x] [Phase 6: Retention & Garbage Collection](phase-6.md)
- [x] [Phase 7: Scheduler FSM, Ribbon Status & Settings UI](phase-7.md)
- [ ] [Phase 8: Restore Engine & Rename-Aware History](phase-8.md)
- [ ] [Phase 9: Backup Browser, File-History Modal & Restore UI (incl. accessibility)](phase-9.md)
- [ ] [Phase 10: Integration, Soak Tests & Release Readiness](phase-10.md)

---

## Plan Verification

Before this plan is ready for implementation, verify:

| Criterion | Status |
|-----------|--------|
| A developer can follow this plan without additional clarification | ✅ |
| Every task produces a verifiable deliverable | ✅ |
| All PRD acceptance criteria map to specific tasks | ✅ |
| All SDD components have implementation tasks | ✅ |
| Dependencies are explicit with no circular references | ✅ |
| Parallel opportunities are marked with `[parallel: true]` | ✅ |
| Each task has specification references `[ref: ...]` | ✅ |
| Project commands in Context Priming are accurate | ✅ |
| All phase files exist and are linked from this manifest as `[Phase N: Title](phase-N.md)` | ✅ |

## PRD Acceptance-Criteria → Phase Traceability

| PRD Feature | Acceptance Criteria | Implementing Phase(s) |
|---|---|---|
| F1 Automatic backups + quiet period | schedule, grace/quiet, catch-up, pre-flight | 5, 7 |
| F2 Hierarchical retention + storage ceiling | 3-tier math, GC completeness, hard-limit warning | 6, 7 |
| F3 File-level restore (command palette) | version list, preview, restore fidelity, rename tracking | 8, 9 |
| F4 Backup Browser tab | 3-column, empty state, deleted-directory restore, binary-preview placeholder | 9 |
| F5 Multi-device coordination | designated toggle, conflict detection | 5, 7 |
| F6 External-sync robustness | reconcile + hash-as-authority | 4 |
| F7 OAuth + secure disconnect | PKCE, revoke, persistent re-auth notice | 3, 7 |
| F8 First-run predecessor plugin warning | one-time notice | 7 |
| S1 Exclusion globs | glob matcher + settings row | 2, 4, 7 |
| S2 Manual "Back up now" | command + ribbon | 7, 9 |
| S3 Storage usage estimate | retention preview in Settings | 7 |
| S5 Pre-flight notice for full | scheduler + notice | 7 |
| S6 Standalone Restore CLI | zero-dep Node script + parity test | 8, 10 |

_S4 (Mobile Restore) was removed — mobile deferred post-V1; `isDesktopOnly: true` in manifest._

## SDD-Component → Phase Traceability

| SDD Component | Phase |
|---|---|
| UI/RibbonIcon | 7 |
| UI/SettingsTab | 7 |
| UI/BackupBrowserView | 9 |
| UI/FileHistoryModal | 9 |
| UI/ConfirmRestoreModal | 9 |
| UI/OAuthConnectFlow | 3 (logic) + 7 (settings surface) |
| UI/NoticeCenter | 7 |
| Services/SchedulerFSM | 7 |
| Services/BackupService | 5 |
| Services/RestoreService | 8 |
| Services/RetentionService | 6 |
| Services/GCService | 6 |
| Services/DeviceCoordinator | 5 |
| Services/ChangeDetector | 4 |
| Infra/DropboxClient | 3 |
| Infra/VaultAdapter | 4 |
| Infra/PluginStore | 4 |
| Infra/Hasher | 2 |
| Infra/EventQueue | 4 |
| Infra/Logger | 2 |
| Model/* | 2 |
| Util/* | 2 |
