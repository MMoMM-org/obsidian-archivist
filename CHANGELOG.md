# [0.4.0](https://github.com/MMoMM-org/obsidian-archivist/compare/0.3.0...0.4.0) (2026-04-28)


### Bug Fixes

* **vault:** vault_id fingerprint + repair commands + cross-vault docs ([#14](https://github.com/MMoMM-org/obsidian-archivist/issues/14)) ([5757dec](https://github.com/MMoMM-org/obsidian-archivist/commit/5757decf15b41aa06c31c1c9dd1a5ff55caf605f))


### Features

* **browser:** fuzzy search in Backup Browser files column ([#13](https://github.com/MMoMM-org/obsidian-archivist/issues/13)) ([751c582](https://github.com/MMoMM-org/obsidian-archivist/commit/751c5823c3e7b22dd7b15d520caf7863a22ad33a))

# [0.3.0](https://github.com/MMoMM-org/obsidian-archivist/compare/0.2.3...0.3.0) (2026-04-28)


### Features

* **recovery:** show banner when chain-walk falls back to FULL ([#12](https://github.com/MMoMM-org/obsidian-archivist/issues/12)) ([5bf2a6d](https://github.com/MMoMM-org/obsidian-archivist/commit/5bf2a6deb161b556df467c3f86ed6e3895a9ea67))

## [0.2.3](https://github.com/MMoMM-org/obsidian-archivist/compare/0.2.2...0.2.3) (2026-04-28)


### Bug Fixes

* **dropbox:** probe parent manifest, not just HEAD, for chain corruption ([#11](https://github.com/MMoMM-org/obsidian-archivist/issues/11)) ([ca4692f](https://github.com/MMoMM-org/obsidian-archivist/commit/ca4692ff89bcb4384e51f8bf883ee46e213970c5)), closes [#9](https://github.com/MMoMM-org/obsidian-archivist/issues/9) [#9](https://github.com/MMoMM-org/obsidian-archivist/issues/9)

## [0.2.2](https://github.com/MMoMM-org/obsidian-archivist/compare/0.2.1...0.2.2) (2026-04-27)


### Bug Fixes

* **dropbox:** add proactive token bucket on top of reactive gate ([#10](https://github.com/MMoMM-org/obsidian-archivist/issues/10)) ([e59daba](https://github.com/MMoMM-org/obsidian-archivist/commit/e59daba63a74b86354f28b269e49a00fceceee0a))

## [0.2.1](https://github.com/MMoMM-org/obsidian-archivist/compare/0.2.0...0.2.1) (2026-04-27)


### Bug Fixes

* **dropbox:** detect corrupt remote state, surface chain breaks, allow manual full ([#9](https://github.com/MMoMM-org/obsidian-archivist/issues/9)) ([3e8fca1](https://github.com/MMoMM-org/obsidian-archivist/commit/3e8fca1f5f369efbf1cdc0ea3c39c8474eb62065)), closes [#8](https://github.com/MMoMM-org/obsidian-archivist/issues/8)

# [0.2.0](https://github.com/MMoMM-org/obsidian-archivist/compare/0.1.1...0.2.0) (2026-04-27)


### Features

* **progress:** live backup progress in status-bar tooltip ([#8](https://github.com/MMoMM-org/obsidian-archivist/issues/8)) ([58c4925](https://github.com/MMoMM-org/obsidian-archivist/commit/58c492599196cb49883ccdc88e05a18d3c8c8ff9))

## [0.1.1](https://github.com/MMoMM-org/obsidian-archivist/compare/0.1.0...0.1.1) (2026-04-27)


### Bug Fixes

* **dropbox:** share rate-limit gate across parallel ops ([#7](https://github.com/MMoMM-org/obsidian-archivist/issues/7)) ([7639abc](https://github.com/MMoMM-org/obsidian-archivist/commit/7639abc906bcb22cc22694416f91c126e6422c4e))

# Changelog

All notable changes to Archivist are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-04-25 (initial release)

The first public release. Everything below is new in this version.

### Added

**Core backup pipeline**
- Content-addressed blob storage in `Apps/Archivist/<vault-prefix>/content/<bucket>/<sha256>` — automatic dedup across files and across versions.
- Manifest-based snapshots (full + incremental) with explicit rename tracking; restoration walks the manifest chain to reconstruct any past vault state.
- Crash-safe commit protocol: blobs upload first, then manifest, then HEAD. A crash at any step leaves recoverable state — orphan blobs are cleaned by the next garbage-collection pass.

**Scheduling**
- Strict 8-state finite-state machine (`LOADING → GRACE → QUIET_WAIT → READY ↔ {BACKUP_RUNNING | ERROR | PASSIVE | AUTH_LOST}`).
- Configurable startup grace period (default 10 min) + quiet period after vault edits (default 2 min) — backups never fire while you're typing.
- Pre-flight notice 5 minutes before each scheduled full with *Start now / Postpone 1h / Skip* actions.
- Catch-up backup on next startup if the plugin was offline during a scheduled full.
- Manual *Back up now* command for immediate incremental.

**Retention**
- Three-tier hierarchical retention: never-prune window (default 14 days), daily for a month (default 30 days), monthly for years (default 3 years), plus a high-frequency window for the last 24 hours.
- Storage hard-limit (default 200 GB) with configurable warning threshold (default 80%).
- Garbage collection of orphaned content blobs after each successful backup, throttled to once per 24 h.
- Transitive chain-integrity: an Inc kept by a tier rule pins all its ancestors up to the nearest Full.

**Restore**
- File-level restore with rename-aware history (Algorithm 3, ROB-004 path-reuse safe).
- Pre-write hash verification before any disk write.
- Per-path mutex prevents concurrent restores from corrupting state.
- Restore-in-place + restore-as-copy + copy-to-clipboard (text only).
- Atomic write via `<path>.archivist-tmp` + rename; failed writes leave no partial files.

**UI**
- **Backup Browser** — three-column `ItemView` (snapshots / files / preview) with date grouping, keyboard navigation, deleted-file marker, and a banner region for storage warnings.
- **File-History modal** — paginated 50-at-a-time, rename markers, single-click preview + restore, focus trap, Enter inert on the destructive button.
- **Confirm-Restore modal** — Cancel-default destructive-action safety, in-place + creates-dir variants.
- **Ribbon icon** — hybrid `archive-restore` / `history` with eight color-coded states + state-aware tooltip and aria-label.
- **Settings tab** — five sections (Schedule / Retention / Notifications / Advanced / Dropbox) with live retention estimate.

**Multi-device safety**
- One designated device per vault; HEAD conflict detection at startup + before manifest write.
- Predecessor-plugin advisory (one-time notice if `obsidian-dropbox-backups` is also enabled).
- iCloud / sync-folder advisory if `data.json` lives under a known sync path.

**Dropbox**
- OAuth PKCE flow with bounded pending-flow map (cap 5, TTL 10 min) and one-shot state-parameter validation.
- Token storage in plaintext `tokens.json` outside `data.json` (disclosed in README and Settings).
- Disconnect calls `POST /oauth2/token/revoke` before clearing local credentials.

**Security**
- Markdown previews exclusively via `MarkdownRenderer.render` — no `innerHTML` on user content (XSS-to-Electron-RCE class ruled out).
- ESLint rule + CI grep gate prevent regressions.
- Co-installed plugin advisory when Dataview / Templater / Tasks is enabled (preview content runs in your live plugin environment).
- Path-redacted logging by default; full paths only when *Diagnostic logging* is on.

**Standalone Restore CLI**
- Zero-dependency Node script (`scripts/restore.mjs`) — only stdlib (`node:fs`, `node:crypto`, `node:path`).
- `--list-snapshots`, `--at <id|prefix|date|latest>`, `--output`, `--dry-run`, `--verify-only`.
- Atomic-dir output (`<output>.tmp` → rename); cleans up on any failure.
- HEAD-missing fallback to newest-by-`created_at`.
- Byte-for-byte parity with the in-plugin restore (verified in CI).

**Tests**
- 1014 unit + integration tests passing.
- 13 end-to-end scenarios under `tests/integration/` (first-run, incremental cycle, rename history, restore in place, restore to deleted dir, retention 35d, GC orphans, device conflict, external sync, auth revoked, catch-up full, quota full, CLI parity).
- Per-phase lifecycle tests under `tests/lifecycle/`.
- Performance SLO regression gates under `tests/perf/`.

### Known limitations (V1)

- **Desktop only** (`isDesktopOnly: true`). Mobile is on the V2 roadmap.
- Plaintext token storage (see README). System-keychain integration is V2.
- No client-side encryption of backup content (CAS dedup requires plaintext content for hashing). The Dropbox account holds the data, so this matches the trust model of any cloud-storage-first backup.
- Backups are designated-device only — multiple devices uploading to the same vault folder is unsupported in V1 (the plugin detects conflicts and aborts safely, but doesn't merge).

[Unreleased]: https://github.com/MMoMM-org/obsidian-archivist/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MMoMM-org/obsidian-archivist/releases/tag/v0.1.0
