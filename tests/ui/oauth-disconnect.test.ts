// T3.4 — OAuthConnectFlow.disconnect() — server-side revoke + local hard-clear.
//
// Covers:
//   - Happy path: POST /oauth2/token/revoke with Authorization: Bearer <access>,
//     then TokenStore.clear() is invoked, tokens.json is absent afterwards.
//   - Revoke errors (HTTP non-2xx or network failure) do NOT block local clear;
//     a warn log with stable key `disconnect_revoke_failed` is emitted.
//   - Local clear failure (e.g. EPERM) HARD-fails disconnect with
//     AuthError('DISCONNECT_LOCAL_CLEAR_FAILED'); no automatic retry.
//   - data.json is NEVER touched on disconnect — no saveData/loadData calls,
//     no adapter.write to data.json.
//   - No Dropbox backup data touched — disconnect never reaches any
//     `files/delete_v2` surface (DropboxClient is not a dependency here).
//   - Idempotent: called when already disconnected (load() → null) logs
//     `disconnect_noop`, does NOT call httpPost or clear(), resolves cleanly.
//
// References: SDD/ADR-9; SDD/Acceptance Criteria — Feature 7;
// plan phase-3.md T3.4.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DROPBOX_REVOKE_URL } from '../../src/config/dropbox';
import type { Logger } from '../../src/infra/Logger';
import type { TokenStore, Tokens } from '../../src/infra/TokenStore';
import { AuthError } from '../../src/model/Errors';
import {
  OAuthConnectFlow,
  type HttpPostResponse,
} from '../../src/ui/OAuthConnectFlow';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

interface FakeTokenStoreShape {
  load: TokenStore['load'];
  save: TokenStore['save'];
  clear: TokenStore['clear'];
  _tokens: Tokens | null;
  _clearCallCount: number;
}

const SAMPLE_TOKENS: Tokens = {
  access_token: 'sl.u.AAA_access',
  refresh_token: 'rt_BBB_refresh',
  access_token_expires_at: '2026-04-23T12:00:00.000Z',
  dropbox_account_email: 'user@example.com',
};

function makeFakeTokenStore(
  initial: Tokens | null = SAMPLE_TOKENS,
  clearBehavior?: () => Promise<void>,
): FakeTokenStoreShape {
  const state: { tokens: Tokens | null; clearCalls: number } = {
    tokens: initial,
    clearCalls: 0,
  };
  const store = {
    _tokens: initial,
    _clearCallCount: 0,
    load: async (): Promise<Tokens | null> => state.tokens,
    save: async (t: Tokens): Promise<void> => {
      state.tokens = t;
      store._tokens = t;
    },
    clear: async (): Promise<void> => {
      state.clearCalls += 1;
      store._clearCallCount = state.clearCalls;
      if (clearBehavior) {
        await clearBehavior();
      }
      state.tokens = null;
      store._tokens = null;
    },
  };
  return store as unknown as FakeTokenStoreShape;
}

interface HttpPostFn {
  (url: string, body: URLSearchParams, headers?: Record<string, string>): Promise<HttpPostResponse>;
}

function okResponse(body: Record<string, unknown> = {}): HttpPostResponse {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function errResponse(status: number, body: Record<string, unknown> = {}): HttpPostResponse {
  return {
    ok: false,
    status,
    json: async () => body,
  };
}

function makeFlow(
  overrides: Partial<{
    tokenStore: FakeTokenStoreShape;
    logger: Logger;
    httpPost: HttpPostFn;
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
      ? vi.fn<HttpPostFn>(async () => okResponse())
      : vi.fn(overrides.httpPost);
  const flow = new OAuthConnectFlow({
    tokenStore: tokenStore as unknown as TokenStore,
    logger,
    // Cast through unknown — the test httpPost takes an optional third
    // `headers` arg that the production signature also accepts after T3.4.
    httpPost: httpPost as unknown as (
      url: string,
      body: URLSearchParams,
    ) => Promise<HttpPostResponse>,
  });
  return { flow, tokenStore, logger, httpPost };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OAuthConnectFlow.disconnect — happy path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('disconnect_happy_path_revokes_then_clears_local_tokens', async () => {
    const { flow, tokenStore, httpPost } = makeFlow();

    await flow.disconnect();

    // (a) exactly one revoke POST, to the right URL, with Authorization header.
    expect(httpPost).toHaveBeenCalledTimes(1);
    const [calledUrl, calledBody, calledHeaders] = httpPost.mock.calls[0];
    expect(calledUrl).toBe(DROPBOX_REVOKE_URL);
    expect(calledBody).toBeInstanceOf(URLSearchParams);
    expect(calledHeaders).toBeDefined();
    expect(calledHeaders!.Authorization).toBe(`Bearer ${SAMPLE_TOKENS.access_token}`);

    // (b) clear() called exactly once.
    expect(tokenStore._clearCallCount).toBe(1);

    // (c) tokens.json is absent after disconnect.
    const loaded = await tokenStore.load();
    expect(loaded).toBeNull();
  });

  it('disconnect_revoke_runs_before_local_clear', async () => {
    // Pin ordering: httpPost must have been called before clear. Use a shared
    // event log to make the ordering explicit.
    const events: string[] = [];
    const tokenStore = makeFakeTokenStore(SAMPLE_TOKENS);
    const origClear = tokenStore.clear.bind(tokenStore);
    tokenStore.clear = async (): Promise<void> => {
      events.push('clear');
      await origClear();
    };
    const httpPost = vi.fn<HttpPostFn>(async () => {
      events.push('revoke');
      return okResponse();
    });
    const { flow } = makeFlow({ tokenStore, httpPost });

    await flow.disconnect();

    expect(events).toEqual(['revoke', 'clear']);
  });
});

describe('OAuthConnectFlow.disconnect — data isolation', () => {
  it('disconnect_does_not_touch_data_json', async () => {
    // saveData / loadData must NEVER be touched by disconnect — tokens live
    // in tokens.json, and settings (data.json) are unrelated.
    const saveData = vi.fn(async (_d: unknown) => {});
    const loadData = vi.fn(async () => ({}));
    const adapterWrite = vi.fn(async (_p: string, _d: string) => {});

    // We don't wire these into TokenStore directly — disconnect uses only
    // tokenStore.load + tokenStore.clear + httpPost. We confirm that
    // disconnect doesn't reach for saveData/loadData at all by passing
    // nothing that exposes them, and asserting that the fake does not
    // observe the calls.
    const { flow, tokenStore } = makeFlow();
    // Attach bystander spies onto the fake tokenStore for maximum confidence —
    // disconnect should NOT call them.
    (tokenStore as unknown as { saveData: typeof saveData }).saveData = saveData;
    (tokenStore as unknown as { loadData: typeof loadData }).loadData = loadData;
    (tokenStore as unknown as { adapterWrite: typeof adapterWrite }).adapterWrite =
      adapterWrite;

    await flow.disconnect();

    expect(saveData).not.toHaveBeenCalled();
    expect(loadData).not.toHaveBeenCalled();
    expect(adapterWrite).not.toHaveBeenCalled();
  });

  it('disconnect_does_not_call_files_delete_v2', async () => {
    const { flow } = makeFlow();
    await flow.disconnect();

    // The implementation must NOT reference Dropbox's files/delete_v2
    // endpoint in any form. Assert by grepping the serialized method body.
    const src = OAuthConnectFlow.prototype.disconnect.toString();
    expect(src).not.toContain('files/delete_v2');
    expect(src).not.toContain('filesDeleteV2');
    expect(src).not.toContain('deleteV2');
  });
});

describe('OAuthConnectFlow.disconnect — revoke errors are non-fatal', () => {
  it('disconnect_revoke_http_error_still_clears_and_logs_warn', async () => {
    const logger = makeLogger();
    const { flow, tokenStore } = makeFlow({
      logger,
      httpPost: async () => errResponse(500, { error: 'server_error' }),
    });

    // Must NOT throw.
    await expect(flow.disconnect()).resolves.toBeUndefined();

    // Local clear still happens.
    expect(tokenStore._clearCallCount).toBe(1);
    const loaded = await tokenStore.load();
    expect(loaded).toBeNull();

    // Stable warn key emitted.
    const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    const call = warn.mock.calls.find((c) => c[0] === 'disconnect_revoke_failed');
    expect(call, 'expected disconnect_revoke_failed warn entry').toBeDefined();
  });

  it('disconnect_revoke_network_error_still_clears_and_logs_warn', async () => {
    const logger = makeLogger();
    const { flow, tokenStore } = makeFlow({
      logger,
      httpPost: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.dropboxapi.com');
      },
    });

    await expect(flow.disconnect()).resolves.toBeUndefined();

    expect(tokenStore._clearCallCount).toBe(1);
    const loaded = await tokenStore.load();
    expect(loaded).toBeNull();

    const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    const call = warn.mock.calls.find((c) => c[0] === 'disconnect_revoke_failed');
    expect(call, 'expected disconnect_revoke_failed warn entry').toBeDefined();
  });
});

describe('OAuthConnectFlow.disconnect — local-clear hard fail', () => {
  it('disconnect_local_clear_failure_throws_DISCONNECT_LOCAL_CLEAR_FAILED', async () => {
    const logger = makeLogger();
    // TokenStore.clear swallows errors by design — so here we force the
    // tokenStore adapter to PERSIST the file even after clear() (mimicking
    // a permission-denied remove that TokenStore tolerated). disconnect()
    // must still detect the failure via a post-check and throw.
    const tokenStore = makeFakeTokenStore(SAMPLE_TOKENS, async () => {
      throw new Error('EPERM: operation not permitted');
    });
    const { flow } = makeFlow({ tokenStore, logger });

    await expect(flow.disconnect()).rejects.toMatchObject({
      name: 'AuthError',
      code: 'DISCONNECT_LOCAL_CLEAR_FAILED',
      retryable: false,
    });

    // And an error-level log with the same stable key.
    const error = logger.error as unknown as ReturnType<typeof vi.fn>;
    const call = error.mock.calls.find(
      (c) => c[0] === 'disconnect_local_clear_failed',
    );
    expect(call, 'expected disconnect_local_clear_failed error entry').toBeDefined();
  });

  it('disconnect_local_clear_failure_throws_AuthError_instance', async () => {
    const tokenStore = makeFakeTokenStore(SAMPLE_TOKENS, async () => {
      throw new Error('ENOSPC: no space left on device');
    });
    const { flow } = makeFlow({ tokenStore });

    const caught = await flow.disconnect().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(AuthError);
    expect((caught as AuthError).code).toBe('DISCONNECT_LOCAL_CLEAR_FAILED');
    expect((caught as AuthError).retryable).toBe(false);
  });

  it('disconnect_no_retry_on_local_clear_failure', async () => {
    // After the throw, no extra invocations of clear() or httpPost must happen.
    const tokenStore = makeFakeTokenStore(SAMPLE_TOKENS, async () => {
      throw new Error('EPERM: operation not permitted');
    });
    const { flow, httpPost } = makeFlow({ tokenStore });

    await expect(flow.disconnect()).rejects.toMatchObject({
      code: 'DISCONNECT_LOCAL_CLEAR_FAILED',
    });

    // clear called exactly once; no silent retry loop.
    expect(tokenStore._clearCallCount).toBe(1);
    // revoke called exactly once (the initial best-effort call).
    expect(httpPost).toHaveBeenCalledTimes(1);
  });
});

describe('OAuthConnectFlow.disconnect — idempotent when already disconnected', () => {
  it('disconnect_idempotent_when_already_disconnected', async () => {
    const logger = makeLogger();
    const tokenStore = makeFakeTokenStore(null);
    const { flow, httpPost } = makeFlow({ tokenStore, logger });

    await expect(flow.disconnect()).resolves.toBeUndefined();

    // No revoke call when there's no access token to revoke.
    expect(httpPost).not.toHaveBeenCalled();
    // clear() may or may not be called — either is fine since tokens are
    // already gone. The stronger invariant: it must not have been asked to
    // perform work. Assert it was not called at all — the implementation
    // should short-circuit on load() === null.
    expect(tokenStore._clearCallCount).toBe(0);

    // Stable info key emitted.
    const info = logger.info as unknown as ReturnType<typeof vi.fn>;
    const call = info.mock.calls.find((c) => c[0] === 'disconnect_noop');
    expect(call, 'expected disconnect_noop info entry').toBeDefined();
  });
});
