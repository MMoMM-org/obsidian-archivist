# Specification: 001-archivist-plugin

## Status

| Field | Value |
|-------|-------|
| **Created** | 2026-04-23 |
| **Current Phase** | Ready |
| **Last Updated** | 2026-04-23 |

## Documents

| Document | Status | Notes |
|----------|--------|-------|
| requirements.md | completed | 8 Must-Have + 5 Should + 5 Could + 12 Won't features; 36 Gherkin acceptance criteria |
| solution.md | completed | 18 ADRs; modular layered architecture; 3 traced-walkthrough algorithms (merge, retention, commit protocol) |
| plan/ | completed | 12 phases, ~65 tasks; TDD structure (Prime→Test→Implement→Validate); phase-level parallelism tags; full PRD↔SDD↔Phase traceability |

**Status values**: `pending` | `in_progress` | `completed` | `skipped`

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-23 | Scaffolded spec 001-archivist-plugin | Brainstorm doc ready for XDD flow |
| 2026-04-23 | Feature branch `feat/xdd-001-archivist-plugin` | Main branch is protected by block-main-edits hook |
| 2026-04-23 | Full PRD → SDD → PLAN pipeline | User confirmed full sequence despite rich brainstorm; open questions (§10) and rejected alternatives (§11) warrant audit |
| 2026-04-23 | Agent Team mode | Cross-cutting concerns (security, perf, UX, Obsidian API, Dropbox API) warrant persistent peer collaboration |
| 2026-04-23 | V1 scope locked: 12 Won't-Have items | Single-maintainer, 8–12 week budget; defer full-vault-restore, dynamic takeover, timeline viz, diff viewer, encryption, i18n, large-vault beyond 20k files |
| 2026-04-23 | File-History command is the lead use case | Research found it was buried in §5.2 but is the everyday recovery flow; PRD positions it as primary (Feature 3), Backup Browser is Feature 4 |
| 2026-04-23 | No telemetry in V1 (author preference, open for revisit) | Privacy-first default; schema defined so V2 can add opt-in without retrofit |
| 2026-04-23 | No automatic migration from obsidian-dropbox-backups | First-run detection + warning only (Feature 8); old Dropbox folder left untouched |
| 2026-04-23 | SDD: 18 ADRs captured — CAS, hybrid change-detection, commit protocol, rename as first-class, GC lock, designated device, plaintext token w/ disclosure, PKCE TTL Map, WebCrypto, index outside data.json, isDesktopOnly=false, MarkdownRenderer-only, pinned SDK, no encryption V1, transitive chain-integrity, retention-after-backup, vault prefix normalized | All auto-confirmed in Auto Mode; flagged for post-hoc review before implementation begins |
| 2026-04-23 | Architecture pattern: modular layered + reactive event pipeline | Single-component plugin; UI → Services → Infrastructure; no microservices, no event bus |
| 2026-04-23 | PLAN: 12 sequenced phases | Foundation → Models → Dropbox/OAuth → Change Detection → Backup → Retention/GC → Scheduler → Restore → Browser UI → Settings UI → Mobile/A11y → Release |

## Context

Source brainstorm: `/Volumes/Moon/Coding/obsidian-archivist/2026-04-23-archivist-plugin.md`

Archivist is an Obsidian community plugin that performs versioned vault backups to Dropbox using a content-addressed storage model, hierarchical retention, and a file-level restore browser. Replaces the abandoned `obsidian-dropbox-backups` plugin. Desktop-first, TypeScript strict, esbuild. See brainstorm doc for full context including vault profile (10k+ files, ~2 GB), retention tiers, CAS design, Dropbox integration, and V1 success criteria.

---
*This file is managed by the xdd-meta skill.*
