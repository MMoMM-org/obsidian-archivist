---
title: "Phase 13: Token Storage Migration to Obsidian SecretStorage"
status: approved
version: "1.0"
phase: 13
---

# Phase 13: Token Storage Migration to Obsidian SecretStorage

> **STATUS: APPROVED 2026-05-13.** ADR-21 has been lifted into `solution.md` (after ADR-19, before Quality Requirements); ADR-7 marked Superseded; Data Storage Changes, Key Decisions, Glossary, Carry-Forward Debt, `plan/README.md` Key Design Decisions and Implementation Phases all updated; Decisions Log row added to `001-archivist-plugin/README.md`. The Open Design Questions (Q1/Q2/Q3) were resolved by an empirical probe on macOS on 2026-05-13. Implementation tasks T13.2–T13.7 are ready to start (T13.1 — apply SDD edits — is complete; see commit history).

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

## Canonical Records

- **ADR-21** (canonical) lives in `solution.md` — search for "ADR-21 (2026-05-13)" (inserted after ADR-19, before the Quality Requirements section).
- **ADR-7** is marked *Superseded by ADR-21* in `solution.md` and kept as historical record of the V1.0 decision.
- **Decisions Log** row in `001-archivist-plugin/README.md` dated 2026-05-13.

## Applied SDD Edits (T13.1, 2026-05-13)

The following edits were applied in the commit that flipped this file's status from `draft` to `approved`:

- `solution.md` Key Decisions bullet (token storage line) — rewritten to reference ADR-21.
- `solution.md` Data Storage Changes — local-files YAML block: `tokens.json` block removed (now lives in `SecretStorage`); legend line "auth: split OUT of data.json into tokens.json (ADR-7)" → "auth: held in app.secretStorage (ADR-21, supersedes ADR-7)".
- `solution.md` ADR-7 entry — title prefixed with "(Superseded by ADR-21, 2026-05-13)"; trailing Status line added; body preserved as historical record.
- `solution.md` ADR-21 — full record inserted after ADR-19 (before Quality Requirements section).
- `solution.md` Carry-forward debt to V2 — removed the "Token plaintext storage (ADR-7) → migrate to electron.safeStorage" line; added a "Closed ahead of V2" footnote pointing at ADR-21.
- `solution.md` Glossary — `tokens.json` entry rewritten as legacy/historical; new `app.secretStorage` entry added.
- `plan/README.md` Key Design Decisions — ADR-7 line annotated as superseded; new ADR-21 line added.
- `plan/README.md` Implementation Phases — `Phase 13` link appended.
- `001-archivist-plugin/README.md` Decisions Log — row added for 2026-05-13 ADR-21.

---

## Open Design Questions — RESOLVED (probed 2026-05-13, macOS)

All three answers are locked. No further runtime validation required before T13.3.

| # | Question | Decision | Evidence |
|---|---|---|---|
| Q1 | Encoding: single JSON-encoded secret vs one secret per field? | **Single JSON blob** under id `archivist-dropbox-tokens`. | Design choice — atomic write, simple migration, single identity check. No probe needed. |
| Q2 | Clear semantics without `removeSecret`: what does `setSecret(id, '')` actually do? | **`load()` treats both `''` and `null` as absent.** | Probed 2026-05-13: `getSecret(neverSetId)` → `null`; after `setSecret(id, '')`, `getSecret(id)` → `""` and id remains in `listSecrets()`. Both states map to "no token" in `TokenStore.load()`. |
| Q3 | Is `setSecret` blocking on the main thread? Does macOS surface a Keychain prompt? | **No wrap required.** Synchronous from caller; no observable UI block; no Keychain prompt. | Probed 2026-05-13: first `setSecret` = 0.50 ms, steady-state mean = 0.42 ms over 5 samples, `getSecret` ≈ 0 ms. No Keychain dialog appeared; master-key entry "Obsidian Safe Storage" was already in the login Keychain (created 2026-03-13 on Obsidian's first run on this machine). Disk grep for the plaintext sentinel returned zero hits; sentinel survived an Obsidian quit + relaunch → encrypted on disk. |

> All decisions feed into T13.3's test assertions and `TokenStore.clear()` implementation. **Linux behavior (libsecret available/unavailable) is NOT probed in this phase** — disclosed in ADR-21 Trade-offs; user can re-validate on Linux if/when relevant.

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

- [x] **T13.1 Approve ADR-21 and apply `solution.md` edits** `[activity: tooling]` — COMPLETED 2026-05-13.

  Outcome: ADR-21 added to `solution.md` after ADR-19; ADR-7 marked Superseded; all related Data Storage / Key Decisions / Glossary / Carry-Forward Debt edits applied; `plan/README.md` updated (Key Design Decisions + Implementation Phases); Decisions Log row added to `001-archivist-plugin/README.md`; this file's status flipped to `approved`. Validation: `grep -n "ADR-21" docs/XDD/specs/001-archivist-plugin/` returns hits in `solution.md`, `plan/README.md`, `plan/phase-13.md`, `README.md` — verified.

- [ ] **T13.2 SecretStorage mock in `tests/fixtures/obsidian-mock.ts`** `[activity: testing]`

  1. Prime: Read `obsidian.d.ts:458, 5468–5496` (SecretStorage surface).
  2. Test: A unit "self-test" exercises the mock: `setSecret('a-b', 'x')` then `getSecret('a-b') === 'x'`; `listSecrets()` returns `['a-b']`; `setSecret('a-b', '')` followed by `getSecret('a-b')` returns `''` and `listSecrets()` still contains `'a-b'` (matches Q2 observed behavior); `getSecret('never-set')` returns `null`. Mock honors the id constraint (lowercase alphanumeric + dashes) by throwing on invalid ids.
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

  1. **Automated gates — DONE 2026-05-13.** `npm run typecheck` clean; `npm run lint` clean (after `manifest.json:minAppVersion` bump to 1.11.4 in T13.3 — the `obsidianmd/no-unsupported-api` rule pins API surface against minAppVersion); `npm test` reports 94 test files / 1295 tests pass (up from 1260 pre-phase: +22 SecretStorage-mock self-tests, +15 TokenStore tests, +13 LegacyTokenMigration tests, -16 retired ADR-7 disk/chmod tests, +1 net from manifest test rewrite); `npm run build` produces a clean bundle.
  2. **Spec-compliance grep — DONE 2026-05-13.** `grep -rn "ADR-7\|ADR-21\|SecretStorage\|tokens\.json\|safeStorage\|secretStorage" src/` yields 28 hits across `main.ts`, `TokenStore.ts`, `LegacyTokenMigration.ts`, `OAuthConnectFlow.ts`, `PluginStore.ts`, `Logger.ts`, `ui/settings/sections/Dropbox.ts`. Each is either: (a) a current-behaviour citation to ADR-21 / `app.secretStorage`, (b) the one-shot migration code in `LegacyTokenMigration.ts`, or (c) an ADR-7 historical reference clearly annotated as superseded. Zero stale "current behaviour" mentions of the legacy `tokens.json`.
  3. **Manual E2E on a real Obsidian ≥ 1.11.4 (Marcus's test vault)** — PENDING. Run the checklist in `docs/XDD/specs/001-archivist-plugin/plan/phase-13.md#manual-e2e-checklist` (below) and record outcomes inline.
  4. Lock `phase-13.md` frontmatter to `status: completed` only after step 3 produces no surprises.
  5. Success: Plugin behaves per ADR-21 across fresh-install / migration / disconnect / reinstall paths; no regression in DropboxClient refresh/single-flight/proactive-refresh tests; documentation matches behavior.

### Manual E2E Checklist (T13.7 step 3)

Run in order on a real Obsidian ≥ 1.11.4. Tick each box and append the observed outcome on the same line so a future reader (or the next maintainer) can audit the V1.1 cutover.

- [ ] **Fresh install — connect path.** Install Archivist V1.1 in an Obsidian vault that has never been authenticated to Dropbox. Open Settings → Archivist → Dropbox → Connect Dropbox. Complete the OAuth flow.
  - Expected: no macOS Keychain prompt (the "Obsidian Safe Storage" master key already exists from prior Obsidian use; probed 2026-05-13). No `tokens.json` is created at `<vault>/.obsidian/plugins/archivist/`. The settings tab updates to "Connected as <email>".
  - Observed: _____
- [ ] **Fresh install — restart survival.** Quit Obsidian fully and reopen. Reopen Settings → Archivist → Dropbox.
  - Expected: still "Connected as <email>" without re-authentication. The Settings → Secrets panel (if open) lists `archivist-dropbox-tokens`.
  - Observed: _____
- [ ] **Legacy migration.** Quit Obsidian. Install Archivist V1.0 (e.g. tag 0.7.9) into a separate test vault, authenticate, then quit Obsidian and verify `tokens.json` exists at `<vault>/.obsidian/plugins/archivist/`. Replace the plugin assets in place with the V1.1 build. Reopen Obsidian.
  - Expected: on first onload, the migration writes the secret and removes `tokens.json` — verify the file is gone and `archivist-dropbox-tokens` is present in Obsidian's Settings → Secrets. The connected-account email still shows in Archivist's settings tab without re-authenticating. Console log `tokens_migrated` is emitted at info.
  - Observed: _____
- [ ] **Disconnect.** From the V1.1 test vault, click *Disconnect Dropbox* in Settings → Archivist.
  - Expected: confirm modal → Disconnect → status becomes "Not connected" without errors. In Obsidian Settings → Secrets, `archivist-dropbox-tokens` remains listed but with an empty value (per ADR-21 Consequence: no `removeSecret` API). Reconnect works on the next OAuth flow and re-populates the secret.
  - Observed: _____
- [ ] **Uninstall / reinstall.** From the V1.1 test vault, disable + uninstall the plugin via Settings → Community plugins. Reinstall.
  - Expected: the keychain master key persists (it's per-Obsidian-installation, not per-plugin); the previously-set secret survives the uninstall *unless* Obsidian itself wipes secrets on plugin removal. Document observed behaviour — this is the only ADR-21 Consequence claim we have not pre-verified.
  - Observed: _____
- [ ] **No regression in the soak / integration suite (optional).** If you maintain a "soak vault" that runs the plugin for an extended period: a 1-hour run should produce the same backup/restore behaviour as pre-V1.1, with no new error log keys appearing. (Skip if you don't keep one.)
  - Observed: _____

---

## Risks & Notes

- **Validation status**: Q2 and Q3 were probed on macOS 2026-05-13 (results in the Open Design Questions table). Q2 returned `''` for cleared secrets → `TokenStore.load()` maps both `''` and `null` to "absent" as planned. Q3 returned sub-millisecond steady-state with no Keychain prompt → no `queueMicrotask` wrap needed. Windows/Linux behavior is documented in ADR-21 Trade-offs but not empirically validated; revisit if a user reports issues on those platforms.
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
