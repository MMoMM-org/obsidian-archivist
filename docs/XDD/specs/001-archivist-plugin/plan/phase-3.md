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
- `[ref: SDD/Implementation Context/External Interfaces/Interface Specifications]` (Dropbox outbound bindings)
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

  1. Prime: Read `[ref: SDD/ADR-7]` (revised — tokens in `tokens.json`, NOT `data.json`), `[ref: SDD/Data Storage Changes — tokens.json block]`, Dropbox OAuth guide linked in SDD.
  2. Test: Storing tokens persists the shape documented in the `tokens.json` YAML block (access_token, refresh_token, access_token_expires_at, dropbox_account_email) at `<plugin-data>/tokens.json` via `app.vault.adapter.write` — NOT via `loadData/saveData`; loading tokens returns them intact; `accessTokenExpiresAt` older than 60 s triggers proactive refresh before the next API call; Dropbox SDK's built-in auto-refresh is also enabled (defense-in-depth); permission 600 is applied to `tokens.json` on desktop (assertion: `fs.stat(tokensPath).mode & 0o777 === 0o600`); `tokens.json` does NOT appear inside `data.json` (Obsidian Sync isolation).
  3. Implement: Create `src/infra/TokenStore.ts` with `load(): Promise<Tokens | null>`, `save(tokens)`, `clear()`. Reads/writes `<plugin-data>/tokens.json` via `this.plugin.app.vault.adapter.read/write`. After save on desktop, resolves the absolute path via `FileSystemAdapter.getFullPath(...)` (or `getBasePath() + tokensPath`) and calls Node `fs.chmod(abs, 0o600)`. Guarded with `platform.isDesktopApp`. Missing-file on load returns `null` (not an error).
  4. Validate: Unit tests with a fake adapter + a desktop-only permission fixture; assertion that `data.json` contents never contain `access_token` keys.
  5. Success: Token lifecycle matches ADR-7 (revised) `[ref: SDD/ADR-7]`; Obsidian-Sync isolation preserved `[ref: SDD/ADR-11 consistency — tokens treated like index.json]`.

- [ ] **T3.3 PKCE OAuth flow with bounded-TTL state map** `[activity: security]`

  1. Prime: Read `[ref: SDD/ADR-8]`, `[ref: SDD/System-Wide Patterns/Security]`, `[ref: SDD/Acceptance Criteria — OAUTH_STATE_MISMATCH]`.
  2. Test:
     - `beginAuth()` returns a URL containing `code_challenge`, `code_challenge_method=S256`, and a random `state` (≥ 128 bits from `crypto.getRandomValues`); stores `{state → {verifier, expiresAt}}` in the Map.
     - Attempting to begin a 6th concurrent flow THROWS `AuthError('TOO_MANY_PENDING_FLOWS')` — does NOT evict the oldest (SEC-M1 DoS-protection). Expired entries (> 10 min) are GC'd lazily on the next `beginAuth()` call.
     - `handleCallback(url)` removes the Map entry IMMEDIATELY on first call — BEFORE any async token exchange — regardless of whether `state` matches (SEC-H1 one-shot invalidation). A non-matching state throws `AuthError('OAUTH_STATE_MISMATCH')`; a matching-but-already-removed state (replay) also throws `OAUTH_STATE_MISMATCH` because the entry is gone. Verified by: start flow, handleCallback once → OK; handleCallback the same state again → OAUTH_STATE_MISMATCH.
     - Regression test for predecessor's module-level `let` bug: after `onunload` clears the Map, a second load + `handleCallback` with any state throws `OAUTH_STATE_MISMATCH` (state → verifier mapping does not survive unload).
     - `onunload` clears the Map entirely.
  3. Implement: Create `src/ui/OAuthConnectFlow.ts` (logic only — UI wiring happens in Phase 10). Use `crypto.getRandomValues` for verifier/state. Verifier is base64url-encoded 32 random bytes. Challenge is base64url of SHA-256(verifier). Callback URL registered via Obsidian's `registerObsidianProtocolHandler('archivist-oauth', ...)`. **Dropbox CLIENT_ID** (see PRD V1 Prerequisites) is kept as a compile-time constant in `src/config/dropbox.ts`: `export const DROPBOX_CLIENT_ID = 'aanoqah5sn73rjb';` — PKCE CLIENT_ID is not a secret (it is transmitted in the authorization URL), so no env var / user config is needed. Do NOT reuse the predecessor plugin's CLIENT_ID (`40ig42vaqj3762d`).
  4. Validate: Unit tests use fake crypto + fake timers; verifies TTL expiry; verifies state mismatch throws; verifies Map size cap.
  5. Success: Fixes predecessor's module-level bug `[ref: SDD/ADR-8]`; state-CSRF prevention `[ref: SDD/Acceptance Criteria — OAUTH_STATE_MISMATCH]`.

- [ ] **T3.4 Disconnect flow (revoke + local clear)** `[activity: security]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/ADR-9]`, `[ref: SDD/Acceptance Criteria — Feature 7]`.
  2. Test: `disconnect()` calls `POST /oauth2/token/revoke` with the current access token; then deletes `tokens.json` via `adapter.remove`; verifies `tokens.json` is absent AFTER the delete (SEC-H2 hard-fail); does NOT touch `data.json`; does NOT call any `files/delete_v2` on Dropbox. Error paths:
     - revoke returns an error → local clear still happens + warning logged; UI shows "server-side revoke failed — consider revoking at dropbox.com";
     - network offline → local clear still happens + same notice;
     - **adapter.remove fails (disk full, permission denied) → disconnect is NOT considered complete**; throws `AuthError('DISCONNECT_LOCAL_CLEAR_FAILED')`; UI surfaces a persistent error: "Disconnect incomplete — tokens.json could not be deleted at &lt;path&gt;. Please delete it manually." A later automatic retry is NOT attempted — the user must resolve.
  3. Implement: Add `disconnect()` to `DropboxClient` (or `OAuthConnectFlow` — place it where the TokenStore handle lives). Logs via `Logger`.
  4. Validate: Unit tests mock the revoke endpoint for success/error/offline; assert no destructive Dropbox path is called.
  5. Success: Server-side token revocation on Disconnect `[ref: SDD/Acceptance Criteria — Feature 7]`; Dropbox backup data preserved `[ref: PRD/F7 AC-4]`.

- [ ] **T3.5 Phase Validation** `[activity: validate]`

  - Run all Phase 3 tests. Exercise the error matrix end-to-end. Confirm no raw SDK types escape `DropboxClient`. Confirm `code_verifier` Map is cleared on `onunload` via a plugin lifecycle test. Lint and typecheck pass.
