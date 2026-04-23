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
| 2026-04-23 | ADR-7 revised: tokens in `tokens.json`, not `data.json` | Predecessor plugin uses a dedicated hidden file for the same reason (`.__dropbox_backups_token_store__`) — Obsidian Sync synchronizes `data.json` by default, which would silently spread tokens across devices. ADR-11 already applies the same reasoning to `index.json`; now consistently applied to tokens. Data-Storage-Changes section updated. |
| 2026-04-23 | ADR-19 added: standalone restore CLI (`scripts/restore.mjs`) | Zero npm deps, pure Node.js, ships in every release zip. The on-disk `Apps/Archivist/` format is a public documented contract — users must be able to recover WITHOUT the plugin (disaster recovery, abandonment insurance, trust-but-verify). Implemented in Phase 8 T8.5, parity-tested in Phase 12. Added as PRD S6. |
| 2026-04-23 | `validate` multi-perspective sweep (Completeness + Consistency + Coverage + Ambiguity) | 4 HIGH/MEDIUM FAILs all traced to ADR-7 revision not fully propagated; fixed this pass: `plan/README.md:L77`, `plan/phase-3.md` T3.2/T3.4, `solution.md` Solution Strategy bullet, `solution.md` Security narrative, audit_log moved to dedicated `audit_log.json`, `LocalIndex` gained `last_retention_at` + `index_missing_recovery_required`, 10 dangling `[ref:]` fixed, Glossary gained entries for data.json/tokens.json/index.json/pending_changes.json/audit_log.json + "backup owner" alias; PRD gained Gherkin ACs for S6 (CLI), F4 binary-preview, F2 hard-limit-breach; two Ambiguity rewrites (persona "few percent" → 5%, "resilient in case of future bugs" → explicit defensive-invariant rationale, "typically" → "commonly" in CLI contract). Ambiguity score 98/100. |
| 2026-04-23 | PRD Open Questions closed (6 decisions) | (d) storage hard-limit default = 200 GB, 10 GB–unlimited configurable; (e) no telemetry in V1 — V2 schema retained as `<details>` reference; (f) diagnostic logging = two-level (default + verbose) gated by `advanced.diagnostic_logging`, default emits only lifecycle + connection + backup-markers + errors (no paths/hashes/content); license = MIT (community norm); plugin-ID `obsidian-archivist` confirmed free in obsidianmd/obsidian-releases registry. V1 Prerequisites section added listing the still-open Dropbox app registration (owner: Marcus) required before Phase 3 T3.3. |
| 2026-04-23 | ADR-14 refined | Use latest stable Dropbox SDK at first build (currently `dropbox@10.34.0`, last modified 2025-10-13), pin exactly, then Dependabot-drive updates. Does NOT mean `@latest` in package.json — pinning at build time ensures reproducible bundles. |
| 2026-04-23 | Dropbox CLIENT_ID placement | `src/config/dropbox.ts` as compile-time constant. PKCE CLIENT_ID is not a secret (transmitted in auth URL); no env var or user config. Do NOT reuse predecessor's `40ig42vaqj3762d` — Marcus registers a new app in Dropbox "App folder" mode before Phase 3. |
| 2026-04-23 | Dropbox app registered — `ObsidianArchivist` / folder `Archivist` / CLIENT_ID `aanoqah5sn73rjb` | Three scopes granted (`files.content.write`, `files.content.read`, `files.metadata.read`), redirect URI `obsidian://archivist-oauth`, publisher Marcus Breiden. Privacy Policy URL → `PRIVACY.md` in repo (stub committed this pass; fuller version before V1 release). App icon deferred to Phase 12 T12.6a. CLIENT_ID lands in `src/config/dropbox.ts` when Phase 3 starts. |
| 2026-04-23 | Remaining 16 ADRs approved as-is | User reviewed the list (ADRs 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18) and accepted each without modification. All 19 ADRs now explicitly user-approved (previously ADR-7 and ADR-19 only). |

## Context

Source brainstorm: `/Volumes/Moon/Coding/obsidian-archivist/2026-04-23-archivist-plugin.md`

Archivist is an Obsidian community plugin that performs versioned vault backups to Dropbox using a content-addressed storage model, hierarchical retention, and a file-level restore browser. Replaces the abandoned `obsidian-dropbox-backups` plugin. Desktop-first, TypeScript strict, esbuild. See brainstorm doc for full context including vault profile (10k+ files, ~2 GB), retention tiers, CAS design, Dropbox integration, and V1 success criteria.

---
*This file is managed by the xdd-meta skill.*
