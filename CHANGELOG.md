## [0.11.2](https://github.com/MMoMM-org/obsidian-archivist/compare/0.11.1...0.11.2) (2026-06-17)


### Bug Fixes

* **net:** route Dropbox SDK through requestUrl to bypass CORS ([#77](https://github.com/MMoMM-org/obsidian-archivist/issues/77)) ([62d90cb](https://github.com/MMoMM-org/obsidian-archivist/commit/62d90cbb5a425dc305938b3a63f59ce8ae16a081))

## [0.11.1](https://github.com/MMoMM-org/obsidian-archivist/compare/0.11.0...0.11.1) (2026-06-11)


### Bug Fixes

* **ui:** surface vault-identity mismatch loudly and resolve it from settings ([#75](https://github.com/MMoMM-org/obsidian-archivist/issues/75)) ([5ae2e65](https://github.com/MMoMM-org/obsidian-archivist/commit/5ae2e655ce664e00d5619fb3feb7fae95409e79e))

# [0.11.0](https://github.com/MMoMM-org/obsidian-archivist/compare/0.10.0...0.11.0) (2026-06-04)


### Features

* **retention:** add Preview retention (dry run) command ([#61](https://github.com/MMoMM-org/obsidian-archivist/issues/61)) ([e31482e](https://github.com/MMoMM-org/obsidian-archivist/commit/e31482e9ffd7bba0bd457ec3de26cfb170484084))

# [0.10.0](https://github.com/MMoMM-org/obsidian-archivist/compare/0.9.1...0.10.0) (2026-06-01)


### Features

* **browser:** mark files modified in this snapshot ([#60](https://github.com/MMoMM-org/obsidian-archivist/issues/60)) ([dd26138](https://github.com/MMoMM-org/obsidian-archivist/commit/dd26138722171f22300e48985ebd427e8e1a1e14))

## [0.9.1](https://github.com/MMoMM-org/obsidian-archivist/compare/0.9.0...0.9.1) (2026-06-01)


### Bug Fixes

* **browser:** refresh preview when snapshot changes ([#57](https://github.com/MMoMM-org/obsidian-archivist/issues/57)) ([#59](https://github.com/MMoMM-org/obsidian-archivist/issues/59)) ([c8e334e](https://github.com/MMoMM-org/obsidian-archivist/commit/c8e334e89136e6c710143ace33fb06b304fb3d9f))

# [0.9.0](https://github.com/MMoMM-org/obsidian-archivist/compare/0.8.3...0.9.0) (2026-06-01)


### Features

* **brand:** Dropbox app icon (Lucide cloud-backup on brand tile, 64 + 256) ([#56](https://github.com/MMoMM-org/obsidian-archivist/issues/56)) ([326e64e](https://github.com/MMoMM-org/obsidian-archivist/commit/326e64e6861ef557c828b7630d8fa9aed199bd47)), closes [#8B5CF6](https://github.com/MMoMM-org/obsidian-archivist/issues/8B5CF6) [#5B3FB8](https://github.com/MMoMM-org/obsidian-archivist/issues/5B3FB8)

## [0.8.3](https://github.com/MMoMM-org/obsidian-archivist/compare/0.8.2...0.8.3) (2026-05-17)


### Bug Fixes

* **scheduler:** rescue missed scheduled FULLs + better lifecycle signals ([#45](https://github.com/MMoMM-org/obsidian-archivist/issues/45)) ([1fca22b](https://github.com/MMoMM-org/obsidian-archivist/commit/1fca22b2d3a3393005446bef0ed8c28a8cd61d5e))

## [0.8.2](https://github.com/MMoMM-org/obsidian-archivist/compare/0.8.1...0.8.2) (2026-05-13)


### Bug Fixes

* **manifest-cache:** avoid unsafe any + enable type-checked lint ([#44](https://github.com/MMoMM-org/obsidian-archivist/issues/44)) ([aecd1a4](https://github.com/MMoMM-org/obsidian-archivist/commit/aecd1a4dafb78e0cca5b46a2a69f53c3331030ae))

## [0.8.1](https://github.com/MMoMM-org/obsidian-archivist/compare/0.8.0...0.8.1) (2026-05-13)


### Bug Fixes

* **ci:** attest released build/ artifacts after semantic-release ([#43](https://github.com/MMoMM-org/obsidian-archivist/issues/43)) ([9606734](https://github.com/MMoMM-org/obsidian-archivist/commit/960673481d6edd4bce8a9e5533e02672784af967)), closes [#42](https://github.com/MMoMM-org/obsidian-archivist/issues/42)

# [0.8.0](https://github.com/MMoMM-org/obsidian-archivist/compare/0.7.9...0.8.0) (2026-05-13)


### Features

* migrate Dropbox tokens to Obsidian SecretStorage (ADR-21) ([#41](https://github.com/MMoMM-org/obsidian-archivist/issues/41)) ([f251f55](https://github.com/MMoMM-org/obsidian-archivist/commit/f251f55ce1afbdd4c032044a9484c13ecc3522a0)), closes [hi#severity](https://github.com/hi/issues/severity)

## [0.7.9](https://github.com/MMoMM-org/obsidian-archivist/compare/0.7.8...0.7.9) (2026-05-13)


### Bug Fixes

* **manifest:** remove email from author field ([#39](https://github.com/MMoMM-org/obsidian-archivist/issues/39)) ([4bf6583](https://github.com/MMoMM-org/obsidian-archivist/commit/4bf6583e8e1f2d93daaf0b57ace44a45707b85cb))

## [0.7.8](https://github.com/MMoMM-org/obsidian-archivist/compare/0.7.7...0.7.8) (2026-05-10)


### Bug Fixes

* **ui:** render preflight buttons, dismiss after full, show scheduled time ([#37](https://github.com/MMoMM-org/obsidian-archivist/issues/37)) ([28f6276](https://github.com/MMoMM-org/obsidian-archivist/commit/28f6276528fcaf00f4527a5d15c7e98eed1361fb))

## [0.7.7](https://github.com/MMoMM-org/obsidian-archivist/compare/0.7.6...0.7.7) (2026-05-08)


### Bug Fixes

* **fsm,ui:** break the retry loop on permanent config errors + add recovery UX ([#36](https://github.com/MMoMM-org/obsidian-archivist/issues/36)) ([ce406af](https://github.com/MMoMM-org/obsidian-archivist/commit/ce406af47765eefb92006f4137e2ae8f27050ec9))

## [0.7.6](https://github.com/MMoMM-org/obsidian-archivist/compare/0.7.5...0.7.6) (2026-05-08)


### Bug Fixes

* **ui:** surface backup failure details on status-bar click ([#35](https://github.com/MMoMM-org/obsidian-archivist/issues/35)) ([602dda8](https://github.com/MMoMM-org/obsidian-archivist/commit/602dda8c8f03b82c48710693269dca9cb1d65c9b))

## [0.7.5](https://github.com/MMoMM-org/obsidian-archivist/compare/0.7.4...0.7.5) (2026-04-29)


### Bug Fixes

* **soak:** await async fixture in four-weeks test ([#32](https://github.com/MMoMM-org/obsidian-archivist/issues/32)) ([05c811a](https://github.com/MMoMM-org/obsidian-archivist/commit/05c811a4fe9bc492c7335d6015324274e3d54332))

## [0.7.4](https://github.com/MMoMM-org/obsidian-archivist/compare/0.7.3...0.7.4) (2026-04-29)


### Bug Fixes

* **lint:** address obsidian review bot findings ([#31](https://github.com/MMoMM-org/obsidian-archivist/issues/31)) ([0e521fe](https://github.com/MMoMM-org/obsidian-archivist/commit/0e521fe25c0032b930af37eca3317b4d0096d5c5))

## [0.7.3](https://github.com/MMoMM-org/obsidian-archivist/compare/0.7.2...0.7.3) (2026-04-28)


### Performance Improvements

* **rate-limit:** conservative defaults to silence 429 cycles ([#30](https://github.com/MMoMM-org/obsidian-archivist/issues/30)) ([e40d2dd](https://github.com/MMoMM-org/obsidian-archivist/commit/e40d2dddc7b91c0ca88092e9f353a2d4375f42d5))

## [0.7.2](https://github.com/MMoMM-org/obsidian-archivist/compare/0.7.1...0.7.2) (2026-04-28)


### Bug Fixes

* pre-release polish — banner copy, OAuth scope, command names ([#29](https://github.com/MMoMM-org/obsidian-archivist/issues/29)) ([14d5545](https://github.com/MMoMM-org/obsidian-archivist/commit/14d5545dd2a29d60e64539a6d6c1ff90ae5cef9f))

## [0.7.1](https://github.com/MMoMM-org/obsidian-archivist/compare/0.7.0...0.7.1) (2026-04-28)


### Bug Fixes

* **manifest:** rename plugin id to "archivist", drop "Obsidian" from description ([#28](https://github.com/MMoMM-org/obsidian-archivist/issues/28)) ([b236e04](https://github.com/MMoMM-org/obsidian-archivist/commit/b236e0404b1da39b67b0a88889dde44fbd583de3)), closes [#12370](https://github.com/MMoMM-org/obsidian-archivist/issues/12370) [obsidian-releases#12370](https://github.com/obsidian-releases/issues/12370)

# [0.7.0](https://github.com/MMoMM-org/obsidian-archivist/compare/0.6.5...0.7.0) (2026-04-28)


### Features

* **store:** split device-block into device.json sidecar ([#26](https://github.com/MMoMM-org/obsidian-archivist/issues/26)) ([7a61712](https://github.com/MMoMM-org/obsidian-archivist/commit/7a61712f9c369a628746ad3c0bc1dfe61d1ebb7d))

## [0.6.5](https://github.com/MMoMM-org/obsidian-archivist/compare/0.6.4...0.6.5) (2026-04-28)


### Bug Fixes

* **security:** close 9 GitHub code-scanning alerts ([#25](https://github.com/MMoMM-org/obsidian-archivist/issues/25)) ([4176a5b](https://github.com/MMoMM-org/obsidian-archivist/commit/4176a5bcda07189a5f2783f0056f919f1fe567ee))

## [0.6.4](https://github.com/MMoMM-org/obsidian-archivist/compare/0.6.3...0.6.4) (2026-04-28)


### Bug Fixes

* **store:** serialize data.json read-modify-write to prevent lost updates ([#23](https://github.com/MMoMM-org/obsidian-archivist/issues/23)) ([14d19b7](https://github.com/MMoMM-org/obsidian-archivist/commit/14d19b762ed97eea5c883ff90d67455121080421))

## [0.6.3](https://github.com/MMoMM-org/obsidian-archivist/compare/0.6.2...0.6.3) (2026-04-28)


### Performance Improvements

* **browser:** cache file tree, Set lookups, LRU manifest cache ([#22](https://github.com/MMoMM-org/obsidian-archivist/issues/22)) ([1554206](https://github.com/MMoMM-org/obsidian-archivist/commit/15542062c17ef940b2b22d4a2007ab5f4d2c88eb))

## [0.6.2](https://github.com/MMoMM-org/obsidian-archivist/compare/0.6.1...0.6.2) (2026-04-28)


### Bug Fixes

* **backup:** cap chain-walk at 100 + add reason metadata on broken result ([#21](https://github.com/MMoMM-org/obsidian-archivist/issues/21)) ([fda8568](https://github.com/MMoMM-org/obsidian-archivist/commit/fda856815c5a0496729d060c337873ef3937938e))

## [0.6.1](https://github.com/MMoMM-org/obsidian-archivist/compare/0.6.0...0.6.1) (2026-04-28)


### Bug Fixes

* **repair:** parallel manifest downloads + register-repair-commands tests ([#20](https://github.com/MMoMM-org/obsidian-archivist/issues/20)) ([d0e1313](https://github.com/MMoMM-org/obsidian-archivist/commit/d0e1313a259e1746033b2b13ce09e5f675afacee)), closes [#14](https://github.com/MMoMM-org/obsidian-archivist/issues/14) [#15](https://github.com/MMoMM-org/obsidian-archivist/issues/15) [#16](https://github.com/MMoMM-org/obsidian-archivist/issues/16)

# [0.6.0](https://github.com/MMoMM-org/obsidian-archivist/compare/0.5.0...0.6.0) (2026-04-28)


### Features

* **vault-identity:** cache ownership + UUID guard + surface remote-corrupt ([#19](https://github.com/MMoMM-org/obsidian-archivist/issues/19)) ([4722d00](https://github.com/MMoMM-org/obsidian-archivist/commit/4722d00e89a4512459376c2e178f6de23ba32c3f))

# [0.5.0](https://github.com/MMoMM-org/obsidian-archivist/compare/0.4.1...0.5.0) (2026-04-28)


### Features

* **a11y:** announce banner + filter count, focus + Escape on browser search ([#16](https://github.com/MMoMM-org/obsidian-archivist/issues/16)) ([25c577e](https://github.com/MMoMM-org/obsidian-archivist/commit/25c577eadaff65ff8b7eba3049d4851abe04670b))

## [0.4.1](https://github.com/MMoMM-org/obsidian-archivist/compare/0.4.0...0.4.1) (2026-04-28)


### Bug Fixes

* **repair:** invalidate manifest cache + add Clear GC Lock command ([#15](https://github.com/MMoMM-org/obsidian-archivist/issues/15)) ([53d72a3](https://github.com/MMoMM-org/obsidian-archivist/commit/53d72a301c3cc5b0249de1735a379a786b049138))

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
