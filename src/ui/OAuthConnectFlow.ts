// OAuthConnectFlow — PKCE authorization-code flow for Dropbox (T3.3).
//
// Responsibilities (logic only — UI wiring lives in main.ts / Phase 7):
//   1. beginAuth(): generate code_verifier + state, store them in a bounded,
//      per-instance Map, and return the authorization URL.
//   2. handleCallback(): consume the Map entry ONE-SHOT (SEC-H1), verify state,
//      exchange the authorization code for tokens, and persist via TokenStore.
//   3. clearPending(): wipe the Map on plugin onunload.
//
// Invariants:
//   - The pending-flows Map is PER INSTANCE. This fixes the predecessor plugin's
//     module-level `let` bug, where state leaked across plugin unload/reload.
//   - MAX_PENDING_FLOWS = 5 with REJECT-at-cap (SEC-M1). Never evict the oldest
//     entry — an attacker who can force beginAuth() calls could otherwise kick
//     the user's real in-progress flow out of the Map before they return from
//     the browser.
//   - FLOW_TTL_MS = 10 min. Expired entries are GC'd lazily at the top of each
//     beginAuth() call.
//   - handleCallback() deletes the Map entry IMMEDIATELY on entry — BEFORE any
//     async token exchange, REGARDLESS of whether the state matches. Replay
//     with the same state then returns OAUTH_STATE_MISMATCH because the entry
//     is gone (SEC-H1).
//   - Errors must NEVER embed the verifier, tokens, or authorization code.
//
// References: SDD/ADR-8, SDD/System-Wide Patterns/Security, SDD/Acceptance
// Criteria — OAUTH_STATE_MISMATCH; plan phase-3.md T3.3.

import { requestUrl } from 'obsidian';
import {
  DROPBOX_AUTHORIZE_URL,
  DROPBOX_CLIENT_ID,
  DROPBOX_REVOKE_URL,
  DROPBOX_TOKEN_URL,
  DROPBOX_USERS_GET_CURRENT_ACCOUNT_URL,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPE,
} from '../config/dropbox';
import type { Logger } from '../infra/Logger';
import type { TokenStore, Tokens } from '../infra/TokenStore';
import { AuthError, NetworkError } from '../model/Errors';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BeginAuthResult {
  /** Fully-formed Dropbox authorization URL the caller should open. */
  url: string;
  /** The random state value — exposed so callers can log / test it. */
  state: string;
}

export interface OAuthCallbackParams {
  state: string;
  code: string;
  error?: string;
  error_description?: string;
}

export interface ExchangedTokens {
  access_token: string;
  refresh_token: string;
  /** ISO-8601 UTC instant. */
  access_token_expires_at: string;
  /** Populated in Phase 7 via /2/users/get_current_account; empty for now. */
  dropbox_account_email: string;
}

/**
 * Minimal response contract for the token-exchange call. Kept narrower than
 * the DOM `Response` so both Obsidian's `requestUrl` and whatever tests inject
 * can satisfy it without extra ceremony.
 */
export interface HttpPostResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export interface OAuthConnectFlowDeps {
  tokenStore: TokenStore;
  logger: Logger;
  /**
   * HTTP POST for the token-exchange and revoke endpoints. Injectable so tests
   * can return crafted responses without touching the network. Defaults to
   * Obsidian's `requestUrl` (wrapped into the {@link HttpPostResponse} shape).
   *
   * The optional `headers` parameter was added for T3.4 so disconnect can send
   * `Authorization: Bearer <access_token>` to the revoke endpoint. Token
   * exchange does NOT use it (PKCE: no client auth header).
   */
  httpPost?: (
    url: string,
    body: URLSearchParams,
    headers?: Record<string, string>,
  ) => Promise<HttpPostResponse>;
  /** Time source (epoch millis). Testability hook. */
  now?: () => number;
  /** Random-bytes source. Defaults to `crypto.getRandomValues`. */
  randomBytes?: (length: number) => Uint8Array;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const MAX_PENDING_FLOWS = 5;
const FLOW_TTL_MS = 10 * 60 * 1000; // 10 minutes
// 32 bytes = 256 bits entropy for the code_verifier (RFC 7636 allows 43-128
// base64url chars; 32 bytes → 43 chars, the minimum).
const VERIFIER_BYTES = 32;
// 16 bytes = 128 bits entropy for the state parameter (SDD minimum).
const STATE_BYTES = 16;

interface PendingFlow {
  /** base64url-encoded code_verifier string (what the RFC actually hashes). */
  verifier: string;
  /** Absolute expiry time in epoch millis. */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// OAuthConnectFlow
// ---------------------------------------------------------------------------

export class OAuthConnectFlow {
  private readonly tokenStore: TokenStore;
  private readonly logger: Logger;
  private readonly httpPost: (
    url: string,
    body: URLSearchParams,
    headers?: Record<string, string>,
  ) => Promise<HttpPostResponse>;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;

  /** Per-instance state → pending-flow map. Fixes predecessor's module-level `let` bug. */
  private readonly pending: Map<string, PendingFlow> = new Map();

  constructor(deps: OAuthConnectFlowDeps) {
    this.tokenStore = deps.tokenStore;
    this.logger = deps.logger;
    this.httpPost = deps.httpPost ?? defaultHttpPost;
    this.now = deps.now ?? ((): number => Date.now());
    this.randomBytes = deps.randomBytes ?? defaultRandomBytes;
  }

  /**
   * Generate a fresh {verifier, state} pair, store it, and return the
   * authorization URL. Lazy-GCs expired entries before the cap check.
   *
   * @throws AuthError('TOO_MANY_PENDING_FLOWS') when the pending map is at
   *   MAX_PENDING_FLOWS live entries. Reject-at-cap is intentional (SEC-M1 —
   *   never evict the oldest, or an attacker could DoS a legitimate in-flight
   *   flow out of the Map before the user returns from the browser).
   */
  async beginAuth(): Promise<BeginAuthResult> {
    this.gcExpired();

    if (this.pending.size >= MAX_PENDING_FLOWS) {
      throw new AuthError(
        'TOO_MANY_PENDING_FLOWS',
        'Too many pending OAuth flows',
        false,
      );
    }

    const verifier = base64url(this.randomBytes(VERIFIER_BYTES));
    const state = base64url(this.randomBytes(STATE_BYTES));
    const challenge = await sha256Base64Url(verifier);

    this.pending.set(state, {
      verifier,
      expiresAt: this.now() + FLOW_TTL_MS,
    });

    const params = new URLSearchParams({
      client_id: DROPBOX_CLIENT_ID,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: OAUTH_REDIRECT_URI,
      state,
      scope: OAUTH_SCOPE,
      token_access_type: 'offline',
    });

    const url = `${DROPBOX_AUTHORIZE_URL}?${params.toString()}`;
    this.logger.info('oauth_begin', { pending_count: this.pending.size });
    return { url, state };
  }

  /**
   * Consume the pending entry for `state` — deletes it IMMEDIATELY (before any
   * async work, regardless of match) for SEC-H1 one-shot invalidation — then
   * verify state, exchange the authorization code for tokens, and persist.
   *
   * @throws AuthError('OAUTH_STATE_MISMATCH') when state is unknown, expired,
   *   or already consumed.
   * @throws AuthError('OAUTH_USER_DENIED' | 'INVALID_GRANT' | …) on provider
   *   errors.
   * @throws NetworkError on transport failures.
   */
  async handleCallback(params: OAuthCallbackParams): Promise<ExchangedTokens> {
    // SEC-H1: consume the map entry FIRST, before any async work, regardless
    // of whether the state matches. A replay of the same state after this
    // point correctly sees no entry and throws OAUTH_STATE_MISMATCH.
    const entry = this.pending.get(params.state);
    this.pending.delete(params.state);

    // Provider-signalled error (e.g. user denied consent) short-circuits.
    if (params.error) {
      const description = params.error_description ?? params.error;
      throw new AuthError('OAUTH_USER_DENIED', description, false);
    }

    if (!entry) {
      throw new AuthError(
        'OAUTH_STATE_MISMATCH',
        'OAuth state not recognized or expired',
        false,
      );
    }
    if (entry.expiresAt <= this.now()) {
      // Same recovery path as state-mismatch — treat an expired entry as
      // unrecognised to keep the UI copy simple.
      throw new AuthError(
        'OAUTH_STATE_MISMATCH',
        'OAuth state not recognized or expired',
        false,
      );
    }

    const body = new URLSearchParams({
      code: params.code,
      grant_type: 'authorization_code',
      code_verifier: entry.verifier,
      client_id: DROPBOX_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
    });

    const tokenResponse = await this.exchangeCode(body);

    const expiresInMs = Math.max(0, tokenResponse.expires_in * 1000);
    const accessTokenExpiresAt = new Date(this.now() + expiresInMs).toISOString();

    const tokens: Tokens = {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      access_token_expires_at: accessTokenExpiresAt,
      // Phase 7 will populate this via a follow-up /2/users/get_current_account
      // call from the settings UI. Keeping the auth flow itself to one network
      // call reduces surface area.
      dropbox_account_email: '',
    };

    await this.tokenStore.save(tokens);
    this.logger.info('oauth_callback_ok');

    return { ...tokens };
  }

  /**
   * Best-effort fetch of the connected Dropbox account's email via
   * `/2/users/get_current_account`. Kept SEPARATE from `handleCallback` so the
   * auth flow's HTTP contract stays limited to the token-exchange call (and
   * existing tests don't need to mock a second URL). Returns null on any
   * failure — the caller can still proceed; the email is purely a display
   * value.
   *
   * Bypasses `httpPost` because the shared helper hardcodes
   * `contentType: 'application/x-www-form-urlencoded'` for the OAuth
   * token-exchange endpoint. `/2/users/get_current_account` rejects that
   * header with HTTP 400 — Dropbox requires either `application/json` (with
   * a JSON body) or no Content-Type at all for parameter-less endpoints. We
   * use the latter and call `requestUrl` directly.
   *
   * Wired by `main.ts` after `handleCallback` succeeds and from the onload
   * backfill path; the email is persisted into tokens.json so it survives a
   * plugin reload.
   */
  async fetchAccountEmail(accessToken: string): Promise<string | null> {
    try {
      const resp = await requestUrl({
        url: DROPBOX_USERS_GET_CURRENT_ACCOUNT_URL,
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        throw: false,
      });
      if (resp.status < 200 || resp.status >= 300) {
        this.logger.debug('account_email_fetch_failed', { status: resp.status });
        return null;
      }
      const parsed = (resp.json ?? JSON.parse(resp.text)) as unknown;
      const email = extractString(parsed, 'email');
      return email && email.length > 0 ? email : null;
    } catch (err) {
      this.logger.debug('account_email_fetch_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Wipe the pending-flows map. Called from `main.ts` `onunload`. */
  clearPending(): void {
    this.pending.clear();
  }

  /**
   * Revoke server-side (best-effort) then hard-clear local tokens.
   *
   * Algorithm (ADR-9):
   *   1. Load current tokens. If none, log `disconnect_noop` and return —
   *      idempotent.
   *   2. Best-effort POST to `/oauth2/token/revoke` with
   *      `Authorization: Bearer <access_token>`. Transport OR HTTP errors are
   *      logged at warn (`disconnect_revoke_failed`) and do NOT block step 3.
   *      The UI should surface "server-side revoke failed — consider
   *      revoking at dropbox.com".
   *   3. `tokenStore.clear()`, then verify via `tokenStore.load()` that
   *      tokens.json is absent. If load() still returns tokens (e.g. the
   *      adapter silently swallowed an EPERM on remove), throw
   *      `AuthError('DISCONNECT_LOCAL_CLEAR_FAILED')` — the user must delete
   *      the file manually. No automatic retry is attempted (SEC-H2).
   *
   * Disconnect NEVER touches Dropbox backup data — it does not call
   * `files/delete_v2` or any other Dropbox files endpoint.
   *
   * @throws AuthError('DISCONNECT_LOCAL_CLEAR_FAILED') when tokens.json could
   *   not be removed from local disk.
   */
  async disconnect(): Promise<void> {
    const tokens = await this.tokenStore.load();
    if (tokens === null) {
      this.logger.info('disconnect_noop');
      return;
    }

    // Step 2 — best-effort revoke. Never rethrow from this block; the
    // authoritative completion step is the local clear below.
    try {
      const response = await this.httpPost(
        DROPBOX_REVOKE_URL,
        new URLSearchParams(),
        { Authorization: `Bearer ${tokens.access_token}` },
      );
      if (!response.ok) {
        this.logger.warn('disconnect_revoke_failed', { status: response.status });
      }
    } catch (err) {
      this.logger.warn('disconnect_revoke_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Step 3 — local clear is the authoritative completion step. Catch any
    // throw from clear() but still verify via load() — TokenStore.clear()
    // intentionally swallows adapter errors (tokens_clear_failed warn), so
    // we confirm removal here rather than trust the return.
    let clearThrew: unknown;
    try {
      await this.tokenStore.clear();
    } catch (err) {
      clearThrew = err;
    }

    const post = await this.tokenStore.load().catch(() => null);
    if (post !== null) {
      this.logger.error('disconnect_local_clear_failed', {
        error: clearThrew instanceof Error ? clearThrew.message : String(clearThrew),
      });
      throw new AuthError(
        'DISCONNECT_LOCAL_CLEAR_FAILED',
        'Disconnect incomplete — tokens.json could not be deleted. Please delete it manually.',
        false,
        clearThrew,
      );
    }

    this.logger.info('disconnect_ok');
  }

  // ---- internals --------------------------------------------------------

  private gcExpired(): void {
    const now = this.now();
    for (const [state, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(state);
    }
  }

  private async exchangeCode(body: URLSearchParams): Promise<TokenExchangeBody> {
    let response: HttpPostResponse;
    try {
      response = await this.httpPost(DROPBOX_TOKEN_URL, body);
    } catch (err) {
      // Transport-layer failure (DNS, TCP, abort). Never log the body.
      throw new NetworkError(
        'NETWORK_ERROR',
        `Token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
        err,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new NetworkError(
        'JSON_PARSE',
        'Token exchange returned malformed JSON',
        true,
        err,
      );
    }

    if (!response.ok) {
      const errorCode = extractString(parsed, 'error');
      const description = extractString(parsed, 'error_description') ?? errorCode ?? 'unknown';
      if (errorCode === 'invalid_grant') {
        throw new AuthError('INVALID_GRANT', description, false);
      }
      if (errorCode === 'invalid_client') {
        throw new AuthError('INVALID_CLIENT', description, false);
      }
      throw new AuthError(
        'OAUTH_EXCHANGE_FAILED',
        `Token exchange rejected: ${description}`,
        false,
      );
    }

    const access = extractString(parsed, 'access_token');
    const refresh = extractString(parsed, 'refresh_token');
    const expiresIn = extractNumber(parsed, 'expires_in');
    if (!access || !refresh || expiresIn === undefined) {
      throw new AuthError(
        'OAUTH_EXCHANGE_FAILED',
        'Token exchange response missing required fields',
        false,
      );
    }
    return { access_token: access, refresh_token: refresh, expires_in: expiresIn };
  }
}

// ---------------------------------------------------------------------------
// Token-exchange body shape (internal)
// ---------------------------------------------------------------------------

interface TokenExchangeBody {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractString(raw: unknown, key: string): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

function extractNumber(raw: unknown, key: string): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * base64url (RFC 4648 §5) encode. Uses `btoa` — present in both Obsidian's
 * Electron renderer and Node (the vitest runtime), and doesn't require
 * `@types/node` in the project's type surface.
 */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * PKCE S256: SHA-256 over the UTF-8 bytes of the base64url-encoded verifier
 * STRING, base64url-encoded. Uses WebCrypto — same stack as src/infra/Hasher.
 */
async function sha256Base64Url(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  // Copy into a fresh ArrayBuffer so non-standard Uint8Array backings don't
  // trip crypto.subtle.digest's type guard (mirrors Hasher.ts behaviour).
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return base64url(new Uint8Array(digest));
}

function defaultRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/**
 * Production HTTP POST — uses Obsidian's `requestUrl`, which bypasses CORS and
 * is the sanctioned network primitive for community plugins
 * (no-restricted-globals/fetch). `throw: false` lets us surface non-2xx bodies
 * via the same response contract as the success case.
 */
async function defaultHttpPost(
  url: string,
  body: URLSearchParams,
  headers?: Record<string, string>,
): Promise<HttpPostResponse> {
  const resp = await requestUrl({
    url,
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    headers,
    body: body.toString(),
    throw: false,
  });
  return {
    ok: resp.status >= 200 && resp.status < 300,
    status: resp.status,
    json: (): Promise<unknown> => {
      // requestUrl eagerly parses JSON; fall back to parsing `text` if the
      // eager parse failed (upstream sets `.json` to null in that case).
      const parsed =
        resp.json !== null && resp.json !== undefined
          ? (resp.json as unknown)
          : (JSON.parse(resp.text) as unknown);
      return Promise.resolve(parsed);
    },
  };
}
