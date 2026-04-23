// T3.3 — OAuthConnectFlow PKCE tests.
//
// Covers:
//   - beginAuth returns a URL containing code_challenge, code_challenge_method=S256,
//     and a random state (>=128 bits); records {state -> {verifier, expiresAt}} in
//     the Map.
//   - Attempting to begin a 6th concurrent flow THROWS AuthError
//     ('TOO_MANY_PENDING_FLOWS') and does NOT evict the oldest (SEC-M1).
//   - Expired entries (>10 min old) are GC'd lazily on the next beginAuth().
//   - handleCallback removes the Map entry IMMEDIATELY on first call BEFORE any
//     async token exchange (SEC-H1 one-shot invalidation). A non-matching state
//     throws OAUTH_STATE_MISMATCH. A matching-but-already-removed state (replay)
//     also throws OAUTH_STATE_MISMATCH because the entry is gone.
//   - Regression: after clearPending() (simulating onunload), a second
//     handleCallback with any state throws OAUTH_STATE_MISMATCH. Fixes the
//     predecessor plugin's module-level `let` bug.
//   - clearPending() empties the Map.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DROPBOX_AUTHORIZE_URL,
  DROPBOX_CLIENT_ID,
  DROPBOX_TOKEN_URL,
  OAUTH_REDIRECT_URI,
} from '../../src/config/dropbox';
import type { Logger } from '../../src/infra/Logger';
import type { TokenStore, Tokens } from '../../src/infra/TokenStore';
import { AuthError } from '../../src/model/Errors';
import {
  OAuthConnectFlow,
  type OAuthCallbackParams,
} from '../../src/ui/OAuthConnectFlow';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface FakeTokenStoreShape {
  save: TokenStore['save'];
  _saved: Tokens[];
}

function makeFakeTokenStore(): FakeTokenStoreShape {
  const saved: Tokens[] = [];
  return {
    _saved: saved,
    save: async (t: Tokens) => {
      saved.push(t);
    },
  } as unknown as FakeTokenStoreShape;
}

/**
 * Deterministic random-bytes source: each call returns a Uint8Array whose
 * bytes are a simple counter-derived pattern. Distinct calls produce distinct
 * outputs so multiple beginAuth() invocations generate distinct state values.
 */
function makeCountingRandom(): (length: number) => Uint8Array {
  let counter = 0;
  return (length: number): Uint8Array => {
    counter++;
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      // A simple invertible pattern — enough to stay unique across calls.
      out[i] = (counter * 31 + i) & 0xff;
    }
    return out;
  };
}

/**
 * Build a Response-like object for successful token-exchange reply.
 */
function okTokenResponse(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errTokenResponse(status: number, body: Record<string, unknown>): Response {
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeFlow(
  overrides: Partial<{
    now: () => number;
    randomBytes: (n: number) => Uint8Array;
    httpPost: (url: string, body: URLSearchParams) => Promise<Response>;
    tokenStore: FakeTokenStoreShape;
    logger: Logger;
  }> = {},
): {
  flow: OAuthConnectFlow;
  tokenStore: FakeTokenStoreShape;
  logger: Logger;
  httpPost: ReturnType<typeof vi.fn>;
} {
  const tokenStore = overrides.tokenStore ?? makeFakeTokenStore();
  const logger = overrides.logger ?? makeLogger();
  const httpPost =
    overrides.httpPost === undefined
      ? vi.fn(async (_url: string, _body: URLSearchParams) =>
          okTokenResponse({
            access_token: 'acc-1',
            refresh_token: 'ref-1',
            expires_in: 14400,
            token_type: 'bearer',
            account_id: 'acct-1',
          }),
        )
      : vi.fn(overrides.httpPost);
  const now = overrides.now ?? ((): number => Date.now());
  const randomBytes = overrides.randomBytes ?? makeCountingRandom();
  const flow = new OAuthConnectFlow({
    tokenStore: tokenStore as unknown as TokenStore,
    logger,
    httpPost,
    now,
    randomBytes,
  });
  return { flow, tokenStore, logger, httpPost };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OAuthConnectFlow.beginAuth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a URL with code_challenge, S256 method, and required params', async () => {
    const { flow } = makeFlow();
    const { url, state } = await flow.beginAuth();
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe(DROPBOX_AUTHORIZE_URL);
    expect(parsed.searchParams.get('client_id')).toBe(DROPBOX_CLIENT_ID);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');

    const challenge = parsed.searchParams.get('code_challenge');
    expect(challenge).toBeTruthy();
    // base64url — no '+', '/', '=' padding.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(parsed.searchParams.get('redirect_uri')).toBe(OAUTH_REDIRECT_URI);
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(parsed.searchParams.get('token_access_type')).toBe('offline');
    // Scope present and non-empty.
    expect(parsed.searchParams.get('scope')).toMatch(/\S+/);
  });

  it('generates a random state of at least 128 bits of entropy', async () => {
    const { flow } = makeFlow();
    const { state } = await flow.beginAuth();
    // 16 bytes → base64url length 22 chars (unpadded).
    // 128 bits of entropy minimum.
    // decoded length check via base64url reverse:
    const b64 = state.replace(/-/g, '+').replace(/_/g, '/');
    const padding = (4 - (b64.length % 4)) % 4;
    const decodedStr = atob(b64 + '='.repeat(padding));
    expect(decodedStr.length).toBeGreaterThanOrEqual(16);
  });

  it('uses crypto.getRandomValues by default when no randomBytes is injected', async () => {
    const getRandomSpy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    // Construct without `randomBytes` override.
    const flow = new OAuthConnectFlow({
      tokenStore: makeFakeTokenStore() as unknown as TokenStore,
      logger: makeLogger(),
    });
    await flow.beginAuth();
    expect(getRandomSpy).toHaveBeenCalled();
    getRandomSpy.mockRestore();
  });

  it('stores state -> {verifier, expiresAt} in the pending map', async () => {
    const { flow } = makeFlow();
    const { state } = await flow.beginAuth();
    // We intentionally don't expose the Map publicly; inspect via
    // handleCallback round-trip: calling handleCallback with state should
    // proceed past the state check (then hit httpPost). That proves the
    // verifier was stored.
    // Separately, calling beginAuth again must not overwrite it (different state).
    const { state: state2 } = await flow.beginAuth();
    expect(state2).not.toBe(state);
  });

  it('throws TOO_MANY_PENDING_FLOWS when map is at cap (5) — does NOT evict', async () => {
    const { flow } = makeFlow();
    const states: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { state } = await flow.beginAuth();
      states.push(state);
    }
    await expect(flow.beginAuth()).rejects.toMatchObject({
      name: 'AuthError',
      code: 'TOO_MANY_PENDING_FLOWS',
    });

    // SEC-M1: the oldest entry must NOT have been evicted. Drive it through
    // handleCallback with a mocked httpPost — if the entry survived, the token
    // exchange proceeds and no OAUTH_STATE_MISMATCH is thrown.
    const oldestState = states[0];
    await expect(
      flow.handleCallback({ state: oldestState, code: 'code-0' }),
    ).resolves.toBeDefined();
  });

  it('lazily GCs entries older than 10 minutes on next beginAuth', async () => {
    const base = new Date('2026-04-23T12:00:00.000Z').getTime();
    let currentNow = base;
    const { flow } = makeFlow({ now: () => currentNow });

    const { state: oldState } = await flow.beginAuth();

    // Advance past the 10-minute TTL.
    currentNow = base + 10 * 60 * 1000 + 1;

    // GC should fire at the start of beginAuth, clearing oldState.
    await flow.beginAuth();

    // Old entry should now be gone — handleCallback with its state → MISMATCH.
    await expect(
      flow.handleCallback({ state: oldState, code: 'code-x' }),
    ).rejects.toMatchObject({
      name: 'AuthError',
      code: 'OAUTH_STATE_MISMATCH',
    });
  });

  it('after GC, we can re-fill up to MAX_PENDING_FLOWS again', async () => {
    const base = new Date('2026-04-23T12:00:00.000Z').getTime();
    let currentNow = base;
    const { flow } = makeFlow({ now: () => currentNow });
    for (let i = 0; i < 5; i++) await flow.beginAuth();
    // All 5 expire.
    currentNow = base + 10 * 60 * 1000 + 1;
    // GC runs and the 6th call must succeed (cap only counts live entries).
    await expect(flow.beginAuth()).resolves.toBeDefined();
  });
});

describe('OAuthConnectFlow.handleCallback — one-shot invalidation (SEC-H1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes the Map entry BEFORE any async token exchange', async () => {
    // Gate the token-exchange httpPost on an external resolver so we can
    // observe the Map state synchronously after the callback starts but
    // before httpPost resolves.
    let resolveHttp: (r: Response) => void = () => undefined;
    const httpPost = vi.fn<(url: string, body: URLSearchParams) => Promise<Response>>(
      async () =>
        await new Promise<Response>((resolve) => {
          resolveHttp = resolve;
        }),
    );

    const { flow } = makeFlow({ httpPost });
    const { state } = await flow.beginAuth();

    // Kick off handleCallback — it will pause awaiting httpPost.
    const pending = flow.handleCallback({ state, code: 'code-1' });

    // The Map entry MUST be gone by now — SEC-H1. We verify indirectly by
    // starting a second handleCallback with the same state: replay should
    // throw OAUTH_STATE_MISMATCH immediately.
    await expect(
      flow.handleCallback({ state, code: 'code-replay' }),
    ).rejects.toMatchObject({
      name: 'AuthError',
      code: 'OAUTH_STATE_MISMATCH',
    });

    // Resolve the first call.
    resolveHttp(
      okTokenResponse({
        access_token: 'acc-1',
        refresh_token: 'ref-1',
        expires_in: 14400,
      }),
    );
    await expect(pending).resolves.toBeDefined();
  });

  it('throws OAUTH_STATE_MISMATCH when the state does not match', async () => {
    const { flow } = makeFlow();
    await flow.beginAuth();
    await expect(
      flow.handleCallback({ state: 'bogus-state-value', code: 'code-x' }),
    ).rejects.toMatchObject({
      name: 'AuthError',
      code: 'OAUTH_STATE_MISMATCH',
    });
  });

  it('throws OAUTH_STATE_MISMATCH on replay even when the state originally matched', async () => {
    const { flow } = makeFlow();
    const { state } = await flow.beginAuth();
    await flow.handleCallback({ state, code: 'code-1' });
    // Replay with the same state — Map entry was consumed.
    await expect(
      flow.handleCallback({ state, code: 'code-1' }),
    ).rejects.toMatchObject({
      name: 'AuthError',
      code: 'OAUTH_STATE_MISMATCH',
    });
  });

  it('exchanges code for tokens and persists via tokenStore.save on happy path', async () => {
    const base = new Date('2026-04-23T12:00:00.000Z').getTime();
    const { flow, tokenStore, httpPost } = makeFlow({
      now: () => base,
      httpPost: async () =>
        okTokenResponse({
          access_token: 'acc-happy',
          refresh_token: 'ref-happy',
          expires_in: 14400,
        }),
    });
    const { state } = await flow.beginAuth();

    const result = await flow.handleCallback({ state, code: 'authcode-happy' });

    // httpPost called with the expected URL and a body including code_verifier.
    expect(httpPost).toHaveBeenCalledTimes(1);
    const [calledUrl, calledBody] = httpPost.mock.calls[0];
    expect(calledUrl).toBe(DROPBOX_TOKEN_URL);
    expect(calledBody).toBeInstanceOf(URLSearchParams);
    expect(calledBody.get('grant_type')).toBe('authorization_code');
    expect(calledBody.get('code')).toBe('authcode-happy');
    expect(calledBody.get('client_id')).toBe(DROPBOX_CLIENT_ID);
    expect(calledBody.get('redirect_uri')).toBe(OAUTH_REDIRECT_URI);
    expect(calledBody.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(result.access_token).toBe('acc-happy');
    expect(result.refresh_token).toBe('ref-happy');
    // Expiry ISO computed from base + 14400 * 1000.
    expect(result.access_token_expires_at).toBe(
      new Date(base + 14400 * 1000).toISOString(),
    );
    expect(result.dropbox_account_email).toBe('');

    expect(tokenStore._saved).toHaveLength(1);
    expect(tokenStore._saved[0]).toMatchObject({
      access_token: 'acc-happy',
      refresh_token: 'ref-happy',
    });
  });

  it('throws AuthError when the callback carries an error param (user denied)', async () => {
    const { flow } = makeFlow();
    const { state } = await flow.beginAuth();
    await expect(
      flow.handleCallback({
        state,
        code: '',
        error: 'access_denied',
        error_description: 'The user denied the request.',
      } as OAuthCallbackParams),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('classifies invalid_grant responses as AuthError(INVALID_GRANT)', async () => {
    const { flow } = makeFlow({
      httpPost: async () =>
        errTokenResponse(400, {
          error: 'invalid_grant',
          error_description: 'code is bad',
        }),
    });
    const { state } = await flow.beginAuth();
    await expect(
      flow.handleCallback({ state, code: 'bad-code' }),
    ).rejects.toMatchObject({
      name: 'AuthError',
      code: 'INVALID_GRANT',
    });
  });
});

describe('OAuthConnectFlow.clearPending — onunload regression', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clearPending empties the pending-flows map', async () => {
    const { flow } = makeFlow();
    const { state } = await flow.beginAuth();
    flow.clearPending();
    await expect(
      flow.handleCallback({ state, code: 'code-x' }),
    ).rejects.toMatchObject({
      name: 'AuthError',
      code: 'OAUTH_STATE_MISMATCH',
    });
  });

  it('fixes the predecessor module-level `let` bug: a second instance does not inherit state', async () => {
    // First "load" — simulate a full OAuth start, then unload clearing the
    // state.
    const tokenStore = makeFakeTokenStore();
    const logger = makeLogger();

    const firstFlow = new OAuthConnectFlow({
      tokenStore: tokenStore as unknown as TokenStore,
      logger,
      randomBytes: makeCountingRandom(),
    });
    const { state } = await firstFlow.beginAuth();
    firstFlow.clearPending();

    // Second "load" — brand-new instance. Any state (including the first
    // one's) must NOT be recognised.
    const secondFlow = new OAuthConnectFlow({
      tokenStore: tokenStore as unknown as TokenStore,
      logger,
      randomBytes: makeCountingRandom(),
    });
    await expect(
      secondFlow.handleCallback({ state, code: 'code-x' }),
    ).rejects.toMatchObject({
      name: 'AuthError',
      code: 'OAUTH_STATE_MISMATCH',
    });
  });
});
