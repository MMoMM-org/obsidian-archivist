// T3.1 — DropboxClient error-matrix, retry orchestration, and contract tests.
//
// Goals:
//   - Exhaustively exercise the error matrix from SDD/Runtime View/Error Handling.
//   - Confirm 401 expired_access_token triggers one-shot refresh + retry.
//   - Confirm 429 honors Retry-After; 507 does not retry.
//   - Confirm manifest endpoints parse-isolate malformed JSON as CorruptionError.
//   - Prove the SDK/Archivist boundary: public methods never surface an SDK type.
//
// Tests inject fake sleep/now via `retry.RetryOptions` to keep the suite fast.

import { describe, expect, it, vi } from 'vitest';

import {
  DropboxClient,
  type DropboxClientOptions,
  type ListFolderEntry,
} from '../../src/infra/DropboxClient';
import { TokenStore, type Tokens } from '../../src/infra/TokenStore';
import type { Logger } from '../../src/infra/Logger';
import {
  AuthError,
  CorruptionError,
  NetworkError,
  PathError,
  QuotaExceededError,
} from '../../src/model/Errors';
import {
  makeFakeSdk,
  sdkError,
  sdkResponse,
  type FakeDropbox,
  type FakeSdkConfig,
} from '../fixtures/dropbox-sdk-mock';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// Build a TokenStore-compatible double. We avoid standing up the real plugin
// stack because TokenStore depends on Obsidian runtime; DropboxClient only
// needs `save` / `load` / `isAccessTokenNearExpiry`. Cast via `as unknown as
// TokenStore` so the production code sees the real class in its signature.
interface FakeTokenStoreShape {
  load: (typeof TokenStore.prototype)['load'];
  save: (typeof TokenStore.prototype)['save'];
  clear: (typeof TokenStore.prototype)['clear'];
  isAccessTokenNearExpiry: (typeof TokenStore.prototype)['isAccessTokenNearExpiry'];
  _saved: Tokens[];
}

function makeFakeTokenStore(initial?: Tokens, opts?: { nearExpiry?: boolean }): FakeTokenStoreShape {
  const saved: Tokens[] = [];
  let current: Tokens | null = initial ?? null;
  const near = opts?.nearExpiry ?? false;
  return {
    load: (async () => current) as FakeTokenStoreShape['load'],
    save: (async (t: Tokens) => {
      saved.push(t);
      current = t;
    }) as FakeTokenStoreShape['save'],
    clear: (async () => {
      current = null;
    }) as FakeTokenStoreShape['clear'],
    isAccessTokenNearExpiry: ((_t: Tokens, _s: number, _n?: () => Date) => near) as FakeTokenStoreShape['isAccessTokenNearExpiry'],
    _saved: saved,
  };
}

const SAMPLE_TOKENS: Tokens = {
  access_token: 'sl.u.OLD',
  refresh_token: 'rt_static',
  access_token_expires_at: '2026-04-23T12:00:00.000Z',
  dropbox_account_email: 'user@example.com',
};

// Retry options that keep tests deterministic and fast. `sleep` records
// every requested delay so assertions can inspect 429 Retry-After handling,
// exponential backoff, etc.
function fastRetry(): DropboxClientOptions['retry'] & { delays: number[] } {
  const delays: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  const r: DropboxClientOptions['retry'] & { delays: number[] } = {
    maxAttempts: 5,
    baseMs: 1000,
    capMs: 60_000,
    jitter: false,
    sleep,
    delays,
  };
  return r;
}

function buildClient(
  cfg: FakeSdkConfig,
  tokenOpts?: { nearExpiry?: boolean; initial?: Tokens },
): {
  client: DropboxClient;
  sdk: FakeDropbox;
  tokenStore: FakeTokenStoreShape;
  retry: ReturnType<typeof fastRetry>;
} {
  const sdk = makeFakeSdk(cfg);
  const tokenStore = makeFakeTokenStore(tokenOpts?.initial ?? SAMPLE_TOKENS, {
    nearExpiry: tokenOpts?.nearExpiry,
  });
  const retry = fastRetry();
  const client = new DropboxClient(
    sdk as never,
    tokenStore as unknown as TokenStore,
    makeLogger(),
    { retry },
  );
  return { client, sdk, tokenStore, retry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DropboxClient', () => {
  it('401_expired_access_token_triggers_auto_refresh_then_retry', async () => {
    let calls = 0;
    const { client, sdk, tokenStore } = buildClient({
      filesDeleteV2: () => {
        calls += 1;
        if (calls === 1) {
          throw sdkError(401, { error: { '.tag': 'expired_access_token' } });
        }
        return sdkResponse({ metadata: {} });
      },
      getAccessToken: () => 'sl.u.NEW_FROM_SDK',
    });

    await expect(client.deleteV2('/foo.bin')).resolves.toBeUndefined();

    expect(sdk.auth.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    // Persisted new token via TokenStore.save — defense-in-depth beyond SDK's
    // own auto-refresh.
    expect(tokenStore._saved.length).toBeGreaterThanOrEqual(1);
    expect(tokenStore._saved[tokenStore._saved.length - 1]!.access_token).toBe('sl.u.NEW_FROM_SDK');
  });

  it('429_with_retry_after_waits_then_retries', async () => {
    let calls = 0;
    const { client, retry } = buildClient({
      filesDeleteV2: () => {
        calls += 1;
        if (calls === 1) {
          throw sdkError(429, { error: { '.tag': 'too_many_requests' } }, { 'retry-after': '3' });
        }
        return sdkResponse({ metadata: {} });
      },
    });

    await client.deleteV2('/foo.bin');

    expect(calls).toBe(2);
    // retry.ts converts RateLimitError.retryAfterSeconds → ms; honoring
    // Retry-After means we waited ≥ 3000 ms.
    const waited = retry.delays[0] ?? 0;
    expect(waited).toBeGreaterThanOrEqual(3000);
  });

  it('507_insufficient_space_throws_quota_error_no_retry', async () => {
    let calls = 0;
    const { client } = buildClient({
      filesUpload: () => {
        calls += 1;
        throw sdkError(507, { error: { '.tag': 'insufficient_space' } });
      },
    });

    await expect(client.uploadBlob('/foo.bin', new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    expect(calls).toBe(1);
  });

  it('network_error_no_status_retries_exponential_backoff_up_to_5', async () => {
    let calls = 0;
    const { client, retry } = buildClient({
      filesDeleteV2: () => {
        calls += 1;
        throw new TypeError('fetch failed');
      },
    });

    await expect(client.deleteV2('/foo.bin')).rejects.toBeInstanceOf(NetworkError);
    // 5 total attempts → 4 sleeps between them.
    expect(calls).toBe(5);
    expect(retry.delays.length).toBe(4);
  });

  it('409_path_conflict_throws_path_error_no_retry', async () => {
    let calls = 0;
    const { client } = buildClient({
      filesDeleteV2: () => {
        calls += 1;
        throw sdkError(409, { error: { '.tag': 'path_lookup', path_lookup: { '.tag': 'not_found' } } });
      },
    });

    await expect(client.deleteV2('/missing')).rejects.toBeInstanceOf(PathError);
    await expect(client.deleteV2('/missing')).rejects.toMatchObject({
      // nested `.tag: not_found` must classify as PATH_NOT_FOUND so callers
      // like DeviceCoordinator.verifyNoConflict can distinguish "fresh folder"
      // from other path conflicts that must propagate.
      code: 'PATH_NOT_FOUND',
    });
    expect(calls).toBe(2);
  });

  it('400_malformed_request_throws_path_or_config_error', async () => {
    let calls = 0;
    const { client } = buildClient({
      filesDeleteV2: () => {
        calls += 1;
        throw sdkError(400, { error_summary: 'bad_request' });
      },
    });

    // PathError is the approved mapping for now — see design contract table.
    await expect(client.deleteV2('/foo')).rejects.toBeInstanceOf(PathError);
    expect(calls).toBe(1);
  });

  it('500_server_error_retries_up_to_5', async () => {
    let calls = 0;
    const { client, retry } = buildClient({
      filesDeleteV2: () => {
        calls += 1;
        throw sdkError(500, { error_summary: 'internal_server_error' });
      },
    });

    await expect(client.deleteV2('/foo')).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toBe(5);
    expect(retry.delays.length).toBe(4);
  });

  it('manifest_endpoint_malformed_json_throws_corruption_error', async () => {
    // JSON download that returns a string the client tries to JSON.parse.
    // SyntaxError + context.isManifestEndpoint=true → CorruptionError.
    const { client } = buildClient({
      filesDownload: () =>
        sdkResponse({
          fileBinary: new TextEncoder().encode('{"broken":'),
        }),
    });

    await expect(
      client.downloadJson('/Archivist/Manifests/xyz.json', { isManifestEndpoint: true }),
    ).rejects.toBeInstanceOf(CorruptionError);
  });

  it('non_manifest_endpoint_malformed_json_throws_network_error', async () => {
    const { client } = buildClient({
      filesDownload: () =>
        sdkResponse({
          fileBinary: new TextEncoder().encode('{"broken":'),
        }),
    });

    await expect(
      client.downloadJson('/Archivist/scratch.json'),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('too_many_write_operations_throws_rate_limit_error', async () => {
    let calls = 0;
    const { client, retry } = buildClient({
      filesDeleteV2: () => {
        calls += 1;
        if (calls === 1) {
          // 409 with too_many_write_operations is Dropbox's rate-limit idiom
          // for mutation endpoints. Classify as RateLimitError with the
          // retry_after from the body.
          throw sdkError(409, {
            error: { '.tag': 'too_many_write_operations' },
            retry_after: 2,
          });
        }
        return sdkResponse({ metadata: {} });
      },
    });

    await client.deleteV2('/foo');
    // Classified as RateLimitError → retry waits ≥ 2000 ms.
    expect(calls).toBe(2);
    expect(retry.delays[0] ?? 0).toBeGreaterThanOrEqual(2000);
  });

  it('chunked_upload_above_150mb_uses_upload_session_with_8mb_chunks', async () => {
    // We don't need to allocate the real 150 MB threshold to exercise the
    // chunked path — we shrink singleShotMaxBytes + uploadChunkBytes so the
    // math is deterministic and fast, then assert on the cursor progression
    // and total bytes to prove we neither drop nor duplicate a byte.
    const startBodies: Uint8Array[] = [];
    const appendBodies: Uint8Array[] = [];
    const finishBodies: Uint8Array[] = [];
    const appendOffsets: number[] = [];
    let finishOffset = -1;

    const sdk = makeFakeSdk({
      filesUploadSessionStart: (arg) => {
        const a = arg as { contents: Uint8Array };
        startBodies.push(a.contents);
        return sdkResponse({ session_id: 's1' });
      },
      filesUploadSessionAppendV2: (arg) => {
        const a = arg as { contents: Uint8Array; cursor: { offset: number } };
        appendBodies.push(a.contents);
        appendOffsets.push(a.cursor.offset);
        return sdkResponse(undefined);
      },
      filesUploadSessionFinish: (arg) => {
        const a = arg as { contents: Uint8Array; cursor: { offset: number } };
        finishBodies.push(a.contents);
        finishOffset = a.cursor.offset;
        return sdkResponse({ id: 'id:1', rev: 'r1', size: 0, server_modified: '2026-04-23T00:00:00Z' });
      },
    });
    const tokenStore = makeFakeTokenStore(SAMPLE_TOKENS);
    const retry = fastRetry();
    const client = new DropboxClient(
      sdk as never,
      tokenStore as unknown as TokenStore,
      makeLogger(),
      { retry, singleShotMaxBytes: 16, uploadChunkBytes: 8 },
    );

    // 20 bytes, chunk=8 → start(8) + append(8) + finish(4).
    // Use a distinctive payload so we can prove byte-exact reassembly.
    const payload = new Uint8Array(20);
    for (let i = 0; i < payload.length; i++) payload[i] = i + 1;

    await client.uploadLarge('/big.bin', payload);

    // Call counts first so failures point at the structural problem.
    expect(sdk.filesUploadSessionStart).toHaveBeenCalledTimes(1);
    expect(sdk.filesUploadSessionAppendV2).toHaveBeenCalledTimes(1);
    expect(sdk.filesUploadSessionFinish).toHaveBeenCalledTimes(1);

    // Start call receives the first chunk; finish call receives the last.
    expect(startBodies[0]).toEqual(payload.subarray(0, 8));
    expect(finishBodies[0]).toEqual(payload.subarray(16, 20));

    // Cursor offsets are monotonic and equal cumulative bytes so far:
    // append[0] at offset 8 (after start=8 bytes); finish at offset 16 (after
    // start + append = 16 bytes).
    expect(appendOffsets).toEqual([8]);
    expect(finishOffset).toBe(16);

    // Total bytes across start + append + finish equals the payload length —
    // no dropped or duplicated bytes.
    const totalBytes =
      startBodies.reduce((sum, b) => sum + b.byteLength, 0) +
      appendBodies.reduce((sum, b) => sum + b.byteLength, 0) +
      finishBodies.reduce((sum, b) => sum + b.byteLength, 0);
    expect(totalBytes).toBe(payload.length);

    // Reassembled payload matches exactly.
    const reassembled = new Uint8Array(totalBytes);
    let pos = 0;
    for (const b of [...startBodies, ...appendBodies, ...finishBodies]) {
      reassembled.set(b, pos);
      pos += b.byteLength;
    }
    expect(reassembled).toEqual(payload);
  });

  it('list_folder_auto_paginates_via_continue', async () => {
    let continueCalls = 0;
    const { client, sdk } = buildClient({
      filesListFolder: () =>
        sdkResponse({
          entries: [
            { '.tag': 'file', path_lower: '/a.md', path_display: '/a.md', name: 'a.md', rev: 'r1', size: 1, server_modified: '2026-04-23T00:00:00Z' },
          ],
          cursor: 'c1',
          has_more: true,
        }),
      filesListFolderContinue: () => {
        continueCalls += 1;
        if (continueCalls === 1) {
          return sdkResponse({
            entries: [
              { '.tag': 'file', path_lower: '/b.md', path_display: '/b.md', name: 'b.md', rev: 'r2', size: 1, server_modified: '2026-04-23T00:00:01Z' },
            ],
            cursor: 'c2',
            has_more: true,
          });
        }
        return sdkResponse({
          entries: [
            { '.tag': 'folder', path_lower: '/sub', path_display: '/sub', name: 'sub' },
            { '.tag': 'deleted', path_lower: '/gone.md', path_display: '/gone.md', name: 'gone.md' },
          ],
          cursor: 'c3',
          has_more: false,
        });
      },
    });

    const entries = await client.listFolder('/');

    expect(sdk.filesListFolder).toHaveBeenCalledTimes(1);
    expect(sdk.filesListFolderContinue).toHaveBeenCalledTimes(2);
    expect(entries).toHaveLength(4);
    expect(entries.map((e: ListFolderEntry) => e.tag)).toEqual([
      'file',
      'file',
      'folder',
      'deleted',
    ]);
    // Archivist-owned shape — only our canonical keys should appear. This is
    // strictly stronger than a prototype check: the SDK can't slip extra
    // fields (path_lower, id, .tag, etc.) past us even by accident.
    const ALLOWED = ['path', 'tag', 'rev', 'size', 'server_modified', 'content_hash'];
    for (const entry of entries) {
      for (const k of Object.keys(entry)) {
        expect(ALLOWED).toContain(k);
      }
    }
  });

  it('contract_test_no_public_method_returns_sdk_type', async () => {
    // Every public method must return an Archivist-owned value — never an
    // SDK DropboxResponse, FileMetadata, etc. We dispatch each method against
    // a happy-path fake and check the returned shape.
    const { client } = buildClient({
      filesUpload: () => sdkResponse({ id: 'id:1', rev: 'r1', size: 3, server_modified: '2026-04-23T00:00:00Z' }),
      filesDownload: (arg: unknown) => {
        const { path } = arg as { path: string };
        const body =
          path.endsWith('.json')
            ? new TextEncoder().encode('{"a":1}')
            : new Uint8Array([1, 2, 3]);
        return sdkResponse({ fileBinary: body });
      },
      filesListFolder: () => sdkResponse({ entries: [], cursor: 'c0', has_more: false }),
      filesDeleteV2: () => sdkResponse({ metadata: { '.tag': 'file' } }),
      filesUploadSessionStart: () => sdkResponse({ session_id: 'sess' }),
      filesUploadSessionAppendV2: () => sdkResponse(undefined),
      filesUploadSessionFinish: () => sdkResponse({ id: 'id:x', rev: 'rx', size: 0, server_modified: '2026-04-23T00:00:00Z' }),
    });

    // uploadBlob → void
    await expect(
      client.uploadBlob('/a.bin', new Uint8Array([1, 2, 3])),
    ).resolves.toBeUndefined();

    // uploadJson → void
    await expect(client.uploadJson('/a.json', { hello: 'world' })).resolves.toBeUndefined();

    // downloadBytes → Uint8Array
    const bytes = await client.downloadBytes('/a.bin');
    expect(bytes).toBeInstanceOf(Uint8Array);

    // downloadJson → plain object (Object.prototype, no SDK prototype chain)
    const obj = await client.downloadJson<{ a: number }>('/a.json');
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
    expect(obj.a).toBe(1);

    // listFolder → plain array of ListFolderEntry (plain-object shape)
    const entries = await client.listFolder('/');
    expect(Array.isArray(entries)).toBe(true);

    // deleteV2 → void
    await expect(client.deleteV2('/a.bin')).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Bonus guard — proactive refresh via TokenStore.isAccessTokenNearExpiry.
  // -------------------------------------------------------------------------

  it('proactive_refresh_when_token_near_expiry', async () => {
    const { client, sdk, tokenStore } = buildClient(
      {
        filesDeleteV2: () => sdkResponse({ metadata: {} }),
        getAccessToken: () => 'sl.u.NEW_PROACTIVE',
      },
      { nearExpiry: true },
    );

    await client.deleteV2('/foo.bin');

    // Refresh fired BEFORE the first op attempt.
    expect(sdk.auth.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(tokenStore._saved.length).toBeGreaterThanOrEqual(1);
    // And the op itself ran exactly once (no error needed to prompt refresh).
    expect(sdk.filesDeleteV2).toHaveBeenCalledTimes(1);
  });

  it('401_twice_surfaces_as_auth_error_not_retryable', async () => {
    // Second 401 after a refresh → TOKEN_REVOKED, not retryable.
    const { client } = buildClient({
      filesDeleteV2: () => {
        throw sdkError(401, { error: { '.tag': 'expired_access_token' } });
      },
    });

    await expect(client.deleteV2('/foo.bin')).rejects.toSatisfy(
      (err: unknown) => err instanceof AuthError && (err as AuthError).retryable === false,
    );
  });

  it('concurrent_401_coalesces_to_single_refresh_and_single_save', async () => {
    // Two operations both hit 401 in parallel. Without single-flight we would
    // fire `refreshAccessToken` twice and `tokenStore.save` twice — a race
    // that can clobber a good persisted token with a stale one. We use a
    // latch so both ops genuinely observe the 401 before either refresh can
    // run, then assert refresh + save fire exactly once.
    const deleteCalls: number[] = [];
    let deleteIx = 0;
    // Latches: the first and second operations both throw 401, but the
    // second op waits on `bothThrew` before running so the two 401s are
    // truly concurrent relative to the refresh path.
    let releaseBothThrew!: () => void;
    const bothThrew = new Promise<void>((resolve) => {
      releaseBothThrew = resolve;
    });
    let thrown = 0;

    const { client, sdk, tokenStore } = buildClient({
      filesDeleteV2: async () => {
        const ix = deleteIx++;
        deleteCalls.push(ix);
        // Attempts 0 and 1 are the initial concurrent ops — both return 401.
        if (ix < 2) {
          thrown++;
          if (thrown === 2) releaseBothThrew();
          // op #1 waits for op #0 to also throw before its 401 propagates
          if (ix === 1) await bothThrew;
          throw sdkError(401, { error: { '.tag': 'expired_access_token' } });
        }
        // Retries (ix 2, 3) succeed.
        return sdkResponse({ metadata: {} });
      },
      getAccessToken: () => 'sl.u.NEW_CONCURRENT',
      refreshAccessToken: async () => {
        // Synchronous refresh in tests — but await a microtask so concurrent
        // callers have a chance to attach to the in-flight promise.
        await Promise.resolve();
      },
    });

    const [a, b] = await Promise.all([
      client.deleteV2('/a.bin'),
      client.deleteV2('/b.bin'),
    ]);

    expect(a).toBeUndefined();
    expect(b).toBeUndefined();

    // Both ops succeeded → 2 initial 401s + 2 successful retries = 4 calls.
    expect(deleteCalls.length).toBe(4);
    // Single-flight invariant: the SDK saw exactly one refresh call, and the
    // token store saw exactly one save.
    expect(sdk.auth.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(tokenStore._saved.length).toBe(1);
    expect(tokenStore._saved[0]!.access_token).toBe('sl.u.NEW_CONCURRENT');
  });

  it('thrown_error_contract_no_sdk_field_leakage', async () => {
    // Raw SDK-shaped error with `headers` (with .get) and `error` object —
    // classifyError must wrap it in a NetworkError subclass of ArchivistError
    // without any SDK-shaped fields leaking onto the public error.
    const { client } = buildClient({
      filesDeleteV2: () => {
        const sdkShaped = {
          status: 500,
          headers: { get: (_k: string) => null },
          error: { foo: 'bar' },
        };
        throw sdkShaped;
      },
    });

    let caught: unknown = null;
    try {
      await client.deleteV2('/foo');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NetworkError);
    const errAny = caught as unknown as Record<string, unknown>;
    // SDK fields must NOT bleed through onto the ArchivistError. The original
    // SDK error object is preserved on `.cause` (for diagnostic logs), but
    // the error surface itself exposes only our own fields.
    expect(errAny.headers).toBeUndefined();
    expect(errAny.error).toBeUndefined();
    expect(typeof (caught as NetworkError).code).toBe('string');
    expect(typeof (caught as NetworkError).message).toBe('string');
  });
});
