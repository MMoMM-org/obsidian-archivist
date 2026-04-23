---
title: "Phase 3: Dropbox Client & OAuth"
status: pending
version: "1.0"
phase: 3
---

# Phase 3: Dropbox Client & OAuth

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/External Interfaces/Interface Specifications — Dropbox]`
- `[ref: SDD/Runtime View/Error Handling — Dropbox error matrix]`
- `[ref: SDD/System-Wide Patterns/Security — PKCE, token storage]`
- `[ref: SDD/Interface Specifications/Application Data Models — ArchivistError hierarchy]`
- `[ref: SDD/ADR-3, ADR-7, ADR-8, ADR-9, ADR-14]`
- `[ref: SDD/Risks/Implementation Gotchas — SDK does not auto-retry 429; list_folder not snapshot-isolated]`

**Key Decisions**:
- `DropboxClient` is a singleton that **owns** retry/backoff and error classification; callers receive `ArchivistError` subclasses only — never raw SDK errors.
- OAuth uses PKCE; `code_verifier` is stored in an in-memory `Map<state, { verifier, expiresAt }>` with cap 5 and TTL 10 min; cleared on `onunload`.
- Disconnect calls `POST /oauth2/token/revoke` BEFORE clearing local tokens; failure to revoke does not block local clearing.
- Upload uses `mode: 'overwrite'` on CAS paths (idempotent — same content → same hash).
- Chunked uploads kick in above 150 MB (Dropbox single-shot limit) using 8 MB chunks by default.

**Dependencies**: Phase 1 (build), Phase 2 (types, retry util, Logger, Hasher).

---

## Tasks

Establishes the sole network boundary. Every other service calls Dropbox **only** through `DropboxClient`. No SDK types leak past this layer.

- [ ] **T3.1 DropboxClient — SDK wrap, error classification, retry** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/Runtime View/Error Handling]` (the full error matrix) and `[ref: SDD/ADR-14]`.
  2. Test: Given a mocked SDK that returns `{ status: 401, error: { '.tag': 'expired_access_token' } }`, client auto-refreshes once then retries; given 429 with `Retry-After: 3`, client waits ≥ 3 s before retry; given 507, client throws `QuotaExceededError` and does NOT retry; given network error (no status), client retries with exponential backoff up to 5 tries; given 409 `path/conflict`, client throws `PathError`; given malformed JSON from a JSON endpoint, client throws `IntegrityError('MANIFEST_CORRUPT')` only for manifest endpoints (other endpoints surface as `NetworkError`).
  3. Implement: Create `src/infra/DropboxClient.ts`. Constructor accepts a `Dropbox` instance + a `TokenStore` (from Phase 4). Exposes `uploadBlob`, `uploadJson`, `downloadBytes`, `downloadJson`, `listFolder` (auto-paginates via `list_folder/continue`), `deleteV2`, `uploadSession.*` for chunked (threshold 150 MB, chunk 8 MB by default from settings). Every public method goes through `withRetry(op, classifyError)` using `util/retry.ts`. `classifyError` maps SDK errors to the `ArchivistError` hierarchy.
  4. Validate: Unit tests mock the SDK and exhaustively exercise the error matrix (≥ 12 cases); a contract test asserts that no method returns an SDK type.
  5. Success: Error classification covers every branch in the SDD error matrix `[ref: SDD/Runtime View/Error Handling]`; 429 `Retry-After` honored `[ref: SDD/Acceptance Criteria — 429]`; 507 does not retry `[ref: SDD/Acceptance Criteria — 507]`; malformed manifest is parse-isolated `[ref: SDD/Risks/Implementation Gotchas]`.

- [ ] **T3.2 TokenStore & auto-refresh wiring** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/ADR-7]`, `[ref: SDD/Interface Specifications/Data Storage — data.json.auth]`, Dropbox OAuth guide linked in SDD.
  2. Test: Storing tokens persists the shape documented in `data.json.auth`; loading tokens returns them intact; `accessTokenExpiresAt` older than 60 s triggers proactive refresh before the next API call; Dropbox SDK's built-in auto-refresh is also enabled (defense-in-depth); permission 600 is applied to `data.json` on desktop (assertion: new `fs.stat(path).mode & 0o777 === 0o600`); on mobile the permission step is skipped silently.
  3. Implement: Create `src/infra/TokenStore.ts` with `load(): Promise<Tokens | null>`, `save(tokens)`, `clear()`. Uses Obsidian's `this.plugin.loadData/saveData` for `data.json.auth`. After save on desktop, calls `fs.chmod(dataPath, 0o600)` via the plugin's `FileSystemAdapter` (`app.vault.adapter.getBasePath()`). Guarded with `platform.isDesktopApp`.
  4. Validate: Unit tests with a fake data-adapter; permission assertion runs only on a desktop test fixture.
  5. Success: Token lifecycle matches ADR-7 disclosure policy `[ref: SDD/ADR-7]`; permissions tightened where platform supports it.

- [ ] **T3.3 PKCE OAuth flow with bounded-TTL state map** `[activity: security]`

  1. Prime: Read `[ref: SDD/ADR-8]`, `[ref: SDD/System-Wide Patterns/Security]`, `[ref: SDD/Acceptance Criteria — OAUTH_STATE_MISMATCH]`.
  2. Test:
     - `beginAuth()` returns a URL containing `code_challenge`, `code_challenge_method=S256`, and a random `state` (≥ 128 bits); stores `{state → {verifier, expiresAt}}` in the Map.
     - Attempting to begin > 5 concurrent flows evicts the oldest and/or rejects; expired entries (> 10 min) are GC'd lazily.
     - `handleCallback(url)` with a matching state exchanges the code for tokens and clears the Map entry; with a non-matching state throws `AuthError('OAUTH_STATE_MISMATCH')`.
     - `onunload` clears the Map entirely.
  3. Implement: Create `src/ui/OAuthConnectFlow.ts` (logic only — UI wiring happens in Phase 10). Use `crypto.getRandomValues` for verifier/state. Verifier is base64url-encoded 32 random bytes. Challenge is base64url of SHA-256(verifier). Callback URL registered via Obsidian's `registerObsidianProtocolHandler('archivist-oauth', ...)`.
  4. Validate: Unit tests use fake crypto + fake timers; verifies TTL expiry; verifies state mismatch throws; verifies Map size cap.
  5. Success: Fixes predecessor's module-level bug `[ref: SDD/ADR-8]`; state-CSRF prevention `[ref: SDD/Acceptance Criteria — OAUTH_STATE_MISMATCH]`.

- [ ] **T3.4 Disconnect flow (revoke + local clear)** `[activity: security]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/ADR-9]`, `[ref: SDD/Acceptance Criteria — Feature 7]`.
  2. Test: `disconnect()` calls `POST /oauth2/token/revoke` with the current access token; then clears `data.json.auth`; does NOT call any `files/delete_v2` on Dropbox; if revoke returns an error, the local clear still happens and a warning is logged; if network is offline, the local clear still happens and a notice tells the user "server-side revoke failed — consider revoking the app in Dropbox settings."
  3. Implement: Add `disconnect()` to `DropboxClient` (or `OAuthConnectFlow` — place it where the TokenStore handle lives). Logs via `Logger`.
  4. Validate: Unit tests mock the revoke endpoint for success/error/offline; assert no destructive Dropbox path is called.
  5. Success: Server-side token revocation on Disconnect `[ref: SDD/Acceptance Criteria — Feature 7]`; Dropbox backup data preserved `[ref: PRD/F7 AC-4]`.

- [ ] **T3.5 Phase Validation** `[activity: validate]`

  - Run all Phase 3 tests. Exercise the error matrix end-to-end. Confirm no raw SDK types escape `DropboxClient`. Confirm `code_verifier` Map is cleared on `onunload` via a plugin lifecycle test. Lint and typecheck pass.
