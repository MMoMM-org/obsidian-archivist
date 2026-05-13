---
title: "Phase 13: Token Storage Migration to Obsidian SecretStorage"
status: draft
version: "0.1"
phase: 13
---

# Phase 13: Token Storage Migration to Obsidian SecretStorage

> **STATUS: DRAFT — pending review.** Contains the proposed ADR-21 verbatim, the planned `solution.md` edits, the three open design questions that need runtime validation in Obsidian before implementation, and the TDD task list. Once approved, ADR-21 moves into `solution.md` after ADR-20, this file's status flips to `approved`, the planned edits are applied in a single commit, and implementation tasks T13.1–T13.7 begin.

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/ADR-7]` (current — to be superseded)
- `[ref: SDD/ADR-21]` (this phase introduces it)
- `[ref: SDD/Data Storage Changes — tokens.json block]` (will be amended)
- `[ref: SDD/Risks/Implementation Gotchas]` (Obsidian API platform variance)
- Obsidian TypeScript API: `obsidian.d.ts:458` (`app.secretStorage`) and `obsidian.d.ts:5468–5496` (`SecretStorage` class), `@since 1.11.4`.

**Key Decisions** (proposed; ratified by ADR-21):
- Tokens move from `<plugin-data>/tokens.json` (plaintext + best-effort `chmod 0o600`) into `app.secretStorage` (OS-keychain–backed).
- Single secret id `archivist-dropbox-tokens` holding a JSON-encoded `Tokens` blob — atomic write, single identity check, simple migration.
- `manifest.json` `minAppVersion` bumps `1.5.0` → `1.11.4`. Acceptable since the plugin is not yet listed in the official Obsidian community-plugin registry (`obsidianmd/obsidian-releases/community-plugins.json`); effective user base = 1.
- One-shot migration from the legacy `tokens.json` runs on the first `onload()` after upgrade. After two patch releases (target V0.9.0) the migration code is removed.

**Dependencies**: Phase 3 (TokenStore, OAuth flow, DropboxClient — currently the only consumers of the storage).

---

## Proposed ADR-21 (verbatim text to be inserted after ADR-20 in `solution.md`)

```markdown
- [ ] **ADR-21 (2026-05-13, DRAFT): Token storage migrated from on-disk `tokens.json` to Obsidian `SecretStorage` (OS keychain) for V1.1.**
  - Decision: Replace `<plugin-data>/tokens.json` storage with `app.secretStorage` (introduced in Obsidian 1.11.4). Tokens are persisted as a single JSON-encoded string under secret id `archivist-dropbox-tokens`. Bumps `manifest.json` `minAppVersion` from `1.5.0` to `1.11.4`. Supersedes ADR-7.
  - Rationale: ADR-7's `tokens.json` is plaintext on disk protected only by best-effort `chmod 0o600` (silently skipped on Mobile, Windows, and non-`FileSystemAdapter` vaults). The Obsidian `SecretStorage` API delegates encryption to the OS Keychain (macOS Keychain / Windows Credential Manager via DPAPI / Linux libsecret-kwallet), closing the at-rest plaintext exposure on Desktop where the plugin runs. Migration cost is near-zero: plugin is not yet in the official community-plugin registry; download stats on `community.obsidian.md/plugins/archivist` (≈ 25 across 26 releases) reflect dev-machine installs by the maintainer plus a handful of GitHub-curious visitors.
  - Consequence:
    - `src/infra/TokenStore.ts` rewritten around `app.secretStorage.getSecret/setSecret/listSecrets`; no `fs.chmod`, no `adapter.read/write/remove` for token paths, no `tokensPath` resolution, no `FileSystemAdapter` guard.
    - One-shot migration on `onload()` before any token read: if `getSecret('archivist-dropbox-tokens')` returns `null` AND legacy `tokens.json` exists, read the JSON, write to SecretStorage, delete the legacy file, log `tokens_migrated`. The migration path is removed at target V0.9.0 (≥ 2 patch releases after V1.1 ships).
    - "Disconnect Dropbox" overwrites the secret with the empty string (the SecretStorage API offers no `removeSecret` as of 1.11.4); `load()` treats `''` as absent. Full removal from the OS Keychain remains available to the user via Obsidian Settings UI.
    - `manifest.json` `minAppVersion` becomes `1.11.4`; users on older Obsidian releases will not see the plugin in the in-app browser. Acceptable given current registry status.
    - Multi-vault scoping of `SecretStorage` is not specified in `obsidian.d.ts`. V1.1 ships single-vault by maintainer assumption; if cross-vault collisions surface, the namespaced id (`archivist-dropbox-tokens`) bounds the failure mode to "all vaults share one Dropbox auth" — the same shape as today's shared OAuth client.
  - Trade-offs:
    - First `setSecret` call on macOS may surface a Keychain access prompt; occurs inside the OAuth modal where an authorization flow is already in progress.
    - No `removeSecret` API as of 1.11.4 → full clear requires the user to use Obsidian Settings UI; programmatic clear is overwrite-with-empty.
    - Loses on-disk inspectability of the previous token file. Acceptable — tokens are recoverable via the standard re-auth flow.
    - Soft pin to Obsidian ≥ 1.11.4 means users on older builds cannot install. Acceptable per current registry status; revisit when registry submission is filed.
  - Rejected alternatives:
    - **Keep `tokens.json` + envelope encryption with a user-provided passphrase**: introduces a UX surface (passphrase prompt on every restart) and a new failure mode (forgotten passphrase = lost auth). Out of proportion for the present V1.1 step.
    - **One SecretStorage entry per field** (`archivist-access-token`, `archivist-refresh-token`, …): non-atomic writes; a crash mid-update could desync fields. Rejected in favor of a single JSON-encoded blob.
    - **Direct Electron `safeStorage`**: only accessible from the main process; Obsidian plugins run in the renderer. `SecretStorage` is Obsidian's official renderer-accessible wrapper.
    - **Defer to V2 (ADR-7's original carry-forward debt)**: rejected — the API now exists; deferring loses nothing and costs an unnecessary release of plaintext storage.
  - Supersedes: ADR-7 (token storage in `tokens.json` with `chmod 0o600`). ADR-7 stays in the SDD as historical record with a `Superseded by ADR-21` marker.
  - Migration removed at: target V0.9.0 (two patch releases after V1.1).
  - Confirmed (DRAFT — author Marcus Breiden, 2026-05-13; pending review).
```

---

## Planned `solution.md` edits (apply after ADR-21 is approved)

| Section | Line(s) | Change |
|---|---|---|
| Key Decisions | 289 | Replace "tokens.json (outside data.json) with disclosure — keeps tokens off the Obsidian-Sync path (ADR-7, consistent with ADR-11 for index.json); electron.safeStorage migration path reserved for V2." → "tokens held in Obsidian `SecretStorage` (OS-keychain–backed) — V1.1 (ADR-21, supersedes ADR-7); single secret id, single JSON blob; not on Obsidian-Sync path by construction." |
| Data Storage Changes (`tokens.json` block) | 471–476 | Replace block with: comment "tokens: held in `app.secretStorage` under id `archivist-dropbox-tokens` (ADR-21); JSON-encoded `{ schema_version, access_token, refresh_token, access_token_expires_at, dropbox_account_email }`; on-disk `tokens.json` only present during one-shot migration window (V1.1 → V0.9.0)." |
| Data Storage Changes (`auth:` legend line) | 497 | Update "auth: split OUT of data.json into tokens.json (ADR-7)" → "auth: stored in `app.secretStorage` (ADR-21, supersedes ADR-7)" |
| ADR-7 entry | 1314 | Prefix title with "**ADR-7 (Superseded by ADR-21, 2026-05-13)**: …" and leave body as historical record. Do not delete. |
| ADR-7 trailer | 1324 | Append "Status: Superseded by ADR-21 — kept for context on the V1 release rationale." |
| Carry-forward debt to V2 | 1531 | Remove the line "Token plaintext storage (ADR-7) → migrate to `electron.safeStorage`." (now resolved by ADR-21). |
| Glossary | 1569 | Replace `tokens.json` entry with: "(legacy, removed in V1.1) Plugin-data file that previously held Dropbox tokens. Replaced by `app.secretStorage` under id `archivist-dropbox-tokens` (ADR-21)." |
| plan/README.md — Key Design Decisions | 77 | Replace ADR-7 line with: "**ADR-21 (V1.1, supersedes ADR-7)**: Dropbox tokens held in Obsidian `SecretStorage` (OS keychain); one-shot migration from legacy `tokens.json` on `onload`." |
| plan/README.md — Implementation Phases | 122 | Add: "- [ ] [Phase 13: Token Storage Migration to Obsidian SecretStorage](phase-13.md)" |
| spec README.md — Decisions Log | (new row) | "2026-05-13 | ADR-21: SecretStorage migration | Closes the V2-deferred plaintext-token debt now that Obsidian 1.11.4 ships the API; phase 13 drafted." |

---

## Open Design Questions (need runtime validation in Obsidian before T13.3 begins)

| # | Question | Proposed answer | Validation |
|---|---|---|---|
| Q1 | Encoding: single JSON-encoded secret vs one secret per field? | **Single JSON blob** under id `archivist-dropbox-tokens`. Atomic write (one keychain call), simple migration, single identity check. | Implicit — design choice, no runtime test required. Accept now. |
| Q2 | Clear semantics without `removeSecret`: what happens when we call `setSecret(id, '')`? Does `listSecrets()` still return the id? Does `getSecret(id)` return `''` or `null`? | **`load()` treats both `''` and `null` as absent.** Document in `PRIVACY.md` that full Keychain removal goes through Obsidian Settings UI. | **Marcus to validate in a real Obsidian (≥1.11.4) vault**: (a) `setSecret('archivist-test', 'x')`, (b) `getSecret('archivist-test') === 'x'`, (c) `setSecret('archivist-test', '')`, (d) confirm `getSecret('archivist-test') === '' or null`, (e) confirm `listSecrets()` still contains/excludes the id. Two-minute spike in Developer Console; result recorded here before T13.3 starts. |
| Q3 | Is `setSecret` blocking on the main thread? On macOS, does the first call surface a Keychain permission dialog? | `.d.ts` returns `void` (not `Promise<void>`), so it is synchronous from the caller's perspective. On macOS, the first call after install likely shows a Keychain prompt — acceptable because it lands inside the OAuth modal where the user already expects an authorization flow. | **Marcus to validate**: instrument with `console.time/timeEnd` around `setSecret` in the developer console on each supported OS (macOS first; Windows/Linux later). If wall-clock > 50 ms in steady state (post-prompt), wrap subsequent saves in `queueMicrotask` to yield the UI thread. Record observed timings here before T13.3. |

> Q2 and Q3 outcomes feed directly into T13.3's test assertions and `TokenStore.clear()` implementation. **Implementation must not begin until both are answered.**

---

## Migration Strategy

On `onload()` (in `src/main.ts`, before `tokenStore.load()` is called by any consumer):

1. Probe `app.secretStorage.getSecret('archivist-dropbox-tokens')`.
2. **If non-empty:** steady state — proceed.
3. **If null or empty:** try legacy file path `<plugin-data>/tokens.json`:
   - File missing → genuine first-run; nothing to do; user goes through OAuth.
   - File present and parseable → JSON-encode the validated `Tokens` shape, `setSecret('archivist-dropbox-tokens', encoded)`, then `adapter.remove(legacyPath)`. Log `tokens_migrated` at info. If `adapter.remove` fails, log `tokens_migrate_legacy_cleanup_failed` at warn but DO NOT block — the migration succeeded; the file is orphaned and harmless after the secret-store path takes over.
   - File present and corrupt → log `tokens_corrupt` (existing key), `adapter.remove`, user re-authenticates. Same recovery path as today.
4. After two patch releases (V0.9.0), the legacy-file branch is deleted entirely. Tracked as a follow-up issue at the time of V1.1 cutover.

No dual-read in steady state. No "fallback to disk" after migration. Single source of truth from V1.1 onward.

---

## Tasks

Establishes one new ADR, replaces the storage backend behind `TokenStore`, and threads the migration through `onload`. Existing refresh / single-flight / proactive-refresh logic in `DropboxClient` is unchanged — only the storage shim is replaced.

- [ ] **T13.1 Approve ADR-21 and apply `solution.md` edits** `[activity: tooling]`

  1. Prime: Re-read this document end-to-end; confirm Q1, Q2, Q3 answers are recorded above.
  2. Test: N/A (doc-only).
  3. Implement: Move the ADR-21 markdown block from this file into `solution.md` after ADR-20. Apply all rows in the "Planned `solution.md` edits" table. Update `plan/README.md` Key Design Decisions + Implementation Phases. Add the Decisions Log row to `001-archivist-plugin/README.md`. Flip this file's frontmatter `status: draft` → `status: approved`.
  4. Validate: `grep -n "ADR-21" docs/XDD/specs/001-archivist-plugin/` returns hits in `solution.md`, `plan/README.md`, `plan/phase-13.md`, `README.md`.
  5. Success: SDD/Plan/Spec-README all cite ADR-21; ADR-7 marked Superseded; phase-13 linked from plan manifest.

- [ ] **T13.2 SecretStorage mock in `tests/fixtures/obsidian-mock.ts`** `[activity: testing]`

  1. Prime: Read `obsidian.d.ts:458, 5468–5496` (SecretStorage surface).
  2. Test: A unit "self-test" exercises the mock: `setSecret('a-b', 'x')` then `getSecret('a-b') === 'x'`; `listSecrets()` returns `['a-b']`; `setSecret('a-b', '')` followed by `getSecret('a-b')` returns whatever Q2 resolves to. Mock honors the id constraint (lowercase alphanumeric + dashes) by throwing on invalid ids.
  3. Implement: Add a `SecretStorage`-shaped class to the mock with a `Map<string,string>` backing store. Expose a `_reset()` helper for tests. Wire `App.secretStorage` to a fresh instance per test.
  4. Validate: Self-tests pass; existing tests that import the mock still pass (no surface regression).
  5. Success: Test infra is ready for T13.3.

- [ ] **T13.3 TokenStore rewrite (RED → GREEN)** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/ADR-21]`, this phase document, Q2/Q3 observed answers.
  2. Test (RED — write failing first):
     - `save({access_token, refresh_token, access_token_expires_at, dropbox_account_email})` calls `app.secretStorage.setSecret('archivist-dropbox-tokens', <json>)` and the stored value is the exact JSON-encoded object (including `schema_version: "1.0"`).
     - `load()` after `save()` returns the same `Tokens` shape; field-by-field assertion.
     - `load()` on an empty store returns `null`.
     - `load()` when the stored value is `''` returns `null` (Q2 outcome).
     - `load()` on malformed JSON returns `null` and logs `tokens_corrupt`.
     - `load()` on JSON missing a required field returns `null` and logs `tokens_corrupt` with reason `missing_required_fields` (same key as today).
     - `clear()` overwrites with `''`; subsequent `load()` returns `null`.
     - `isAccessTokenNearExpiry` predicate behaves identically to current (carry test as-is).
     - **NEGATIVE:** assertions that `app.vault.adapter.write/read/remove` are NOT called from `TokenStore` for any path containing "tokens" — explicit guard against accidental dual-write regression.
  3. Implement: Rewrite `src/infra/TokenStore.ts`:
     - Remove `FileSystemAdapter`, `Platform`, `fs` import, `chmodIfDesktop`, `tokensPath`, `TOKENS_FILENAME`, `DEFAULT_CHMOD`.
     - Add private `static readonly SECRET_ID = 'archivist-dropbox-tokens'`.
     - `load()`: read secret → if `null` or `''` return `null`; else `JSON.parse` + `toTokens` (keep validator); on parse error, log `tokens_corrupt` and return `null`.
     - `save(tokens)`: stringify with `schema_version: "1.0"` + 4 fields; `app.secretStorage.setSecret(SECRET_ID, payload)`.
     - `clear()`: `setSecret(SECRET_ID, '')`.
     - Keep `isAccessTokenNearExpiry` unchanged.
     - File header comment updates to point at ADR-21.
  4. Validate: All T13.3 tests pass; coverage on `TokenStore` remains 100 %; `dropbox-client.test.ts` (which uses TokenStore through its mocks) still passes without changes.
  5. Success: `TokenStore` matches ADR-21; no filesystem code path remains; refresh + proactive-refresh tests in `dropbox-client.test.ts` continue to assert single-flight behavior.

- [ ] **T13.4 One-shot legacy-`tokens.json` migration in `main.ts`** `[activity: backend-api]`

  1. Prime: Read this document's Migration Strategy section.
  2. Test:
     - Given `tokens.json` exists with valid JSON AND `secretStorage` is empty → on plugin load, `secretStorage` contains the JSON-encoded blob, `tokens.json` is removed, `tokens_migrated` is logged at info, subsequent `tokenStore.load()` returns the migrated `Tokens`.
     - Given `tokens.json` exists with malformed JSON → log `tokens_corrupt`, remove the file, `secretStorage` stays empty, user is led through re-auth (existing UX).
     - Given `secretStorage` already populated AND `tokens.json` also exists (paranoid case) → keep `secretStorage` value; remove the stale `tokens.json`; log `tokens_legacy_orphan_removed` at info.
     - Given neither exists → fresh-install path; no migration log, no error.
     - Given `secretStorage` empty AND `tokens.json` present but `adapter.remove` fails → migration is recorded as successful (secret was written); log `tokens_migrate_legacy_cleanup_failed` at warn; do NOT throw.
  3. Implement: In `src/main.ts:onload`, between `new TokenStore(...)` and the first consumer call, insert `await this.maybeMigrateLegacyTokens(tokenStore)`. The method lives in `main.ts` (one-shot, not part of TokenStore's permanent surface). It uses the existing `vault.adapter` directly to read/remove the legacy file path computed the same way ADR-7 computed it.
  4. Validate: Integration test fixture stages a `tokens.json` in a fake adapter and asserts the full lifecycle.
  5. Success: Single-load migration matches ADR-21 Consequence; no dual-read code remains in steady state.

- [ ] **T13.5 OAuthConnectFlow disconnect + user-facing strings** `[activity: backend-api]` `[parallel: true]`

  1. Prime: Read `src/ui/OAuthConnectFlow.ts:127–375` and `src/ui/strings.ts:143`.
  2. Test:
     - `disconnect()` calls `tokenStore.clear()`; afterwards `tokenStore.load()` returns `null`. The previous `AuthError('DISCONNECT_LOCAL_CLEAR_FAILED')` path is retired (overwriting a secret cannot fail in the same way deleting a file could); a new branch covers `setSecret` throwing (if it ever does) — assert that the error surfaces with a NEW key `AuthError('DISCONNECT_SECRET_CLEAR_FAILED')` and the disconnect is NOT considered complete.
     - `strings.ts:tokens_storage_disclosure` (line 143) is rewritten and a unit-string test pins the new text.
  3. Implement: Adapt the error class enum + the user-facing string. Update the inline-jsdoc references to ADR-7 in `OAuthConnectFlow.ts` to point at ADR-21.
  4. Validate: All tests green; no string references to "tokens.json" remain in `src/`.
  5. Success: Disconnect flow matches ADR-21 Consequence; user-facing copy reflects keychain storage.

- [ ] **T13.6 `manifest.json` + user docs** `[activity: tooling]` `[parallel: true]`

  1. Prime: Read `README.md:103–201`, `PRIVACY.md:13, 36, 44`, `docs/troubleshooting/dropbox-corruption.md`.
  2. Test: N/A (doc-only); manual sighting checklist below.
  3. Implement:
     - `manifest.json`: `"minAppVersion": "1.11.4"`.
     - `README.md`: rewrite the "Token storage" / "Security" / "Troubleshooting" snippets to describe SecretStorage; remove file-permission language; add a note about the one-time Keychain prompt on macOS.
     - `PRIVACY.md`: replace lines 13, 36, 44; reference the OS Keychain on each platform; explain that the user can remove the secret via Obsidian Settings UI.
     - `docs/troubleshooting/dropbox-corruption.md`: scrub any `tokens.json` path references.
  4. Validate: `grep -n "tokens.json" README.md PRIVACY.md docs/` returns only historical/migration references (e.g. "tokens previously stored in tokens.json (V1.0); migrated to SecretStorage in V1.1"); no stale guidance.
  5. Success: External documentation matches the new contract; no instruction asks users to look for `tokens.json` going forward.

- [ ] **T13.7 Phase Validation + E2E manual walkthrough** `[activity: validate]`

  1. Run all phase-13 tests + full suite (`npm test`, `npm run lint`, `npm run typecheck`, `npm run build`).
  2. Spec compliance: `grep -n "ADR-7\|ADR-21\|SecretStorage\|tokens\.json" -r src tests docs` — all hits explained by ADR-21 or historical/migration code.
  3. Manual E2E on a real Obsidian ≥ 1.11.4 (Marcus's vault):
     - **Fresh install**: install plugin, connect via OAuth, verify Keychain prompt appears, verify `tokens.json` is NOT created, restart Obsidian, verify auth survives.
     - **Migration**: stage a v0.7.x install with a real `tokens.json`, upgrade to V1.1, restart, verify the file is gone, verify auth survives, verify `archivist-dropbox-tokens` exists in Obsidian Settings → Secrets.
     - **Disconnect**: trigger "Disconnect Dropbox", verify the secret is empty/null, verify re-auth works.
     - **Re-install scenario**: uninstall plugin, reinstall — secret persists in keychain (Obsidian keeps secrets per-vault by default); document observed behavior in this section as the validation result for the multi-vault assumption (ADR-21 Consequence).
  4. Lock `phase-13.md` frontmatter to `status: completed`.
  5. Success: Plugin behaves per ADR-21 across all three paths; no regression in DropboxClient refresh/single-flight/proactive-refresh tests; documentation matches behavior.

---

## Risks & Notes

- **Single point of validation**: Q2 (`setSecret('','')` semantics) and Q3 (sync vs async, Keychain prompt timing) are the only places where the design depends on observed Obsidian behavior. If Q2 returns `''` instead of `null` for cleared secrets, `load()`'s `''→null` mapping covers it. If Q3 shows ≥ 50 ms blocking in steady state, `save()` becomes `queueMicrotask(() => secretStorage.setSecret(...))` with the same external behavior. Both contingencies are absorbed inside `TokenStore` without changing its public surface.
- **Multi-vault assumption**: documented in ADR-21 Consequence as "single-vault by maintainer assumption". If a user reports a cross-vault token collision, ADR-21 is revisited; the namespace constant moves to per-vault (e.g. `archivist-${vaultId}-dropbox-tokens`).
- **Registry submission timing**: this migration should ship BEFORE Marcus submits the plugin to `obsidianmd/obsidian-releases` — otherwise users on Obsidian < 1.11.4 would install V1.0 (plaintext tokens) and then be unable to upgrade past V1.1's `minAppVersion` gate without first upgrading Obsidian itself. Recommended ordering: V1.1 ship → soak 1 week → submit to registry with `minAppVersion: 1.11.4`.
- **Migration removal**: after V0.9.0 ships, the legacy-file branch in `main.ts` is deleted in a follow-up PR with the title `chore(tokens): drop legacy tokens.json migration path` and a one-line note in CHANGELOG referencing ADR-21.

---

## Definition of Done

- ADR-21 in `solution.md` confirmed (not draft).
- All planned `solution.md`, `plan/README.md`, and spec `README.md` edits applied.
- `src/infra/TokenStore.ts` rewritten; no `fs`/`chmod`/`adapter.write` for tokens.
- `src/main.ts` one-shot migration tested.
- `manifest.json` `minAppVersion: "1.11.4"`.
- `README.md`, `PRIVACY.md`, `docs/troubleshooting/` updated.
- E2E walkthrough completed and logged in T13.7.
- This file's frontmatter is `status: completed`.
