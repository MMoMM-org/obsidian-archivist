// DropboxClient — the SOLE network boundary between Archivist and Dropbox.
//
// Design invariants (Phase 3 / T3.1):
//   - Every public method returns an Archivist-owned value or throws an
//     ArchivistError subclass. SDK types never leak out.
//   - Transient errors (429, 500, 503, network) are retried via retry().
//   - 401 expired_access_token triggers ONE token refresh + one retry before
//     surfacing as TOKEN_REVOKED. This lives OUTSIDE the generic retry wrapper
//     so retry.ts stays focused on transient/rate-limit handling.
//   - 507 short-circuits (QuotaExceededError, non-retryable).
//   - Malformed JSON on manifest endpoints is CorruptionError — on other
//     JSON endpoints it's NetworkError (treat as transient glitch).
//   - listFolder auto-paginates via list_folder/continue.
//   - uploadLarge picks single-shot vs upload_session based on singleShotMaxBytes.
//   - PROACTIVE rate limiting: a token bucket (default 8 req/s, 15 burst)
//     gates every SDK call. Smooths bursts so a 4-way parallel upload of a
//     5k-file vault never crosses Dropbox's per-app files/upload limit.
//   - REACTIVE shared back-off: a rate-limit resume-at timestamp pauses ALL
//     in-flight + new ops when any op observes 429 / too_many_write_operations.
//     Catches the case where the user's other apps push the same account over
//     the limit unexpectedly.
//
// References: SDD/Runtime View/Error Handling; ADR-14; plan phase-3.md T3.1.

import type { Dropbox } from 'dropbox';

import {
  ArchivistError,
  AuthError,
  CorruptionError,
  NetworkError,
  PathError,
  QuotaExceededError,
  RateLimitError,
} from '../model/Errors';
import { retry, type RetryOptions } from '../util/retry';
import type { Logger } from './Logger';
import type { TokenStore, Tokens } from './TokenStore';

// ---------------------------------------------------------------------------
// Structural SDK shape
// ---------------------------------------------------------------------------
// The real `Dropbox` class exposes `auth` at runtime but doesn't surface it on
// its TypeScript declaration, and the route methods accept tagged unions we
// don't want to pull into our callsites. We narrow the SDK to the slice we
// actually use so types flow cleanly and tests can inject a structurally-
// compatible fake.

interface DropboxAuthLike {
  refreshAccessToken: (scope?: Array<string>) => Promise<void> | void;
  getAccessToken: () => string;
  getAccessTokenExpiresAt: () => Date;
}

interface DropboxLike {
  auth: DropboxAuthLike;
  filesUpload: (arg: unknown) => Promise<SdkResponseLike<unknown>>;
  filesDownload: (arg: unknown) => Promise<SdkResponseLike<unknown>>;
  filesListFolder: (arg: unknown) => Promise<SdkResponseLike<ListFolderResultLike>>;
  filesListFolderContinue: (arg: unknown) => Promise<SdkResponseLike<ListFolderResultLike>>;
  filesDeleteV2: (arg: unknown) => Promise<SdkResponseLike<unknown>>;
  filesUploadSessionStart: (arg: unknown) => Promise<SdkResponseLike<{ session_id: string }>>;
  filesUploadSessionAppendV2: (arg: unknown) => Promise<SdkResponseLike<unknown>>;
  filesUploadSessionFinish: (arg: unknown) => Promise<SdkResponseLike<unknown>>;
}

// Every concrete `Dropbox` instance satisfies `DropboxLike` structurally, so
// the constructor still accepts the SDK's `Dropbox` type at the public API
// surface — we just operate on the narrowed view internally.
function asDropboxLike(sdk: Dropbox): DropboxLike {
  return sdk as unknown as DropboxLike;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

const DEFAULT_SINGLE_SHOT_MAX_BYTES = 150 * 1024 * 1024; // Dropbox hard cap
const DEFAULT_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const PROACTIVE_REFRESH_THRESHOLD_SECONDS = 60;
// Defaults are intentionally conservative: real-world FULL backups of large
// vaults (~6k files) consistently tripped 429s at the previous 8 req/s × burst
// 15 setting on Plus-tier accounts. Reducing to 5 req/s × burst 8 keeps
// per-app `files/upload` headroom for parallel uploaders + commit-time writes
// without saturating Dropbox's per-app budget. Power users can still raise via
// `rateLimit.requestsPerSecond` / `rateLimit.burst` constructor options.
//
// Floor we apply when Dropbox returns 429 with no Retry-After header. Keeps
// the gate from collapsing to zero and re-flooding the API on the next tick.
const RATE_LIMIT_MIN_PAUSE_MS = 1_000;
// Token-bucket defaults — sized below Dropbox's documented per-app per-second
// budget for files/upload so a 2-way parallel backup of a 6k-file vault stays
// inside Dropbox's per-app `files/upload` budget on Plus-tier accounts. Burst
// lets short flurries (manifest+HEAD+index writes at commit time) go through
// without artificial delay.
const DEFAULT_RATE_LIMIT_REQUESTS_PER_SECOND = 5;
const DEFAULT_RATE_LIMIT_BURST = 8;

export interface DropboxClientOptions {
  uploadChunkBytes?: number;
  singleShotMaxBytes?: number;
  retry?: RetryOptions;
  /**
   * Proactive token-bucket gate on every SDK call. Defaults to 8 req/s with a
   * 15-token burst — sized to keep parallel-uploader bursts under Dropbox's
   * per-app `files/upload` budget. Set `enabled: false` to disable entirely
   * (tests that need to fire many sequential calls without artificial delay).
   */
  rateLimit?: {
    enabled?: boolean;
    requestsPerSecond?: number;
    burst?: number;
  };
}

export interface ListFolderEntry {
  path: string;
  rev?: string;
  size?: number;
  server_modified?: string;
  content_hash?: string;
  tag: 'file' | 'folder' | 'deleted';
}

// ---------------------------------------------------------------------------
// Internal shape helpers — we deliberately treat the SDK structurally so the
// error-classification logic stays version-tolerant against dropbox-sdk.
// ---------------------------------------------------------------------------

interface SdkErrorLike {
  status: number;
  headers?: Record<string, string> | { get?: (k: string) => string | null };
  error?: unknown;
}

interface SdkResponseLike<T> {
  status: number;
  headers?: unknown;
  result: T;
}

interface FileDownloadResult {
  fileBinary?: ArrayBuffer | Uint8Array;
  fileBlob?: Blob;
  rev?: string;
  size?: number;
  content_hash?: string;
}

interface ListFolderResultLike {
  entries: ReadonlyArray<ListFolderEntryRaw>;
  cursor: string;
  has_more: boolean;
}

interface ListFolderEntryRaw {
  '.tag'?: string;
  path_lower?: string;
  path_display?: string;
  name?: string;
  rev?: string;
  size?: number;
  server_modified?: string;
  content_hash?: string;
}

function isSdkErrorLike(e: unknown): e is SdkErrorLike {
  return (
    !!e &&
    typeof e === 'object' &&
    'status' in (e as Record<string, unknown>) &&
    typeof (e as { status: unknown }).status === 'number'
  );
}

function readHeader(h: SdkErrorLike['headers'], key: string): string | undefined {
  if (!h) return undefined;
  const lc = key.toLowerCase();
  const maybeGet = (h as { get?: unknown }).get;
  if (typeof maybeGet === 'function') {
    const val = (maybeGet as (k: string) => string | null).call(h, key);
    return val ?? undefined;
  }
  const record = h as Record<string, string>;
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === lc) return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Error classification — the core of this module.
// ---------------------------------------------------------------------------

// Internal — consumed only by classifyError inside this module. Not exported
// to keep the public surface lean; promote to `export` if a future consumer
// needs it.
interface ClassifyContext {
  isManifestEndpoint?: boolean;
}

function pickErrorTag(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  // Dropbox nests tags under `error['.tag']` on some endpoints and on the
  // body root on others. Probe both.
  if (typeof e['.tag'] === 'string') return e['.tag'];
  const inner = e.error;
  if (inner && typeof inner === 'object') {
    const innerTag = (inner as Record<string, unknown>)['.tag'];
    if (typeof innerTag === 'string') return innerTag;
  }
  return undefined;
}

/**
 * Walks Dropbox's nested-tag structure to find a terminal `.tag` value.
 * For a 409 with body `{error: {'.tag': 'path_lookup', path_lookup: {'.tag': 'not_found'}}}`
 * returns `'not_found'`. Used to distinguish "path does not exist" (recoverable
 * by callers like DeviceCoordinator.verifyNoConflict for fresh folders) from
 * other path conflicts that MUST propagate.
 */
function is404PathNotFound(err: SdkErrorLike): boolean {
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 6 || !node || typeof node !== 'object') return false;
    const o = node as Record<string, unknown>;
    if (o['.tag'] === 'not_found') return true;
    for (const [k, v] of Object.entries(o)) {
      if (k === '.tag') continue;
      if (v && typeof v === 'object' && visit(v, depth + 1)) return true;
    }
    return false;
  };
  return visit(err.error, 0);
}

function pickRetryAfter(err: SdkErrorLike): number {
  // Prefer the HTTP header; fall back to body.retry_after. Unparseable →
  // 0 (retry.ts falls back to its own backoff).
  const hdr = readHeader(err.headers, 'retry-after');
  const parsedHdr = hdr !== undefined ? Number.parseFloat(hdr) : NaN;
  if (Number.isFinite(parsedHdr)) return parsedHdr;
  const body = err.error as { retry_after?: unknown } | undefined;
  if (body && typeof body.retry_after === 'number') return body.retry_after;
  return 0;
}

export function classifyError(err: unknown, context: ClassifyContext = {}): ArchivistError {
  // Already classified — pass through unchanged so nested wrappers don't
  // double-wrap.
  if (err instanceof ArchivistError) return err;

  // JSON parse errors get split by endpoint type: manifests must surface as
  // CorruptionError so StartupAudit / SnapshotRunner can skip them safely;
  // everything else is treated as a transient network glitch.
  if (err instanceof SyntaxError) {
    if (context.isManifestEndpoint) {
      return new CorruptionError('MANIFEST_CORRUPT', `Malformed manifest JSON: ${err.message}`, false, err);
    }
    return new NetworkError('JSON_PARSE', `Malformed JSON response: ${err.message}`, true, err);
  }

  if (isSdkErrorLike(err)) {
    const status = err.status;
    const tag = pickErrorTag(err.error);

    // 401 — expired token triggers the withAuthRefresh wrapper to retry
    // once; any other 401 is unrecoverable without re-auth.
    if (status === 401) {
      if (tag === 'expired_access_token') {
        return new AuthError('TOKEN_EXPIRED', 'Access token expired', true, err);
      }
      return new AuthError('TOKEN_REVOKED', 'Access token rejected', false, err);
    }

    // 429 — honor Retry-After. retry.ts watches RateLimitError.retryAfterSeconds.
    if (status === 429) {
      return new RateLimitError('RATE_LIMITED', 'Dropbox rate-limited', pickRetryAfter(err), err);
    }

    // 409 splits three ways: too_many_write_operations is Dropbox's 4xx rate
    // limit for mutations; path-related tags are PathError; anything else is
    // surfaced as PathError as a conservative default.
    if (status === 409) {
      if (tag === 'too_many_write_operations') {
        return new RateLimitError('RATE_LIMITED', 'Dropbox too_many_write_operations', pickRetryAfter(err), err);
      }
      if (is404PathNotFound(err)) {
        return new PathError('PATH_NOT_FOUND', `Path not found${tag ? `: ${tag}` : ''}`, false, err);
      }
      return new PathError('PATH_CONFLICT', `Path conflict${tag ? `: ${tag}` : ''}`, false, err);
    }

    if (status === 400) {
      return new PathError('BAD_REQUEST', 'Malformed request rejected by Dropbox', false, err);
    }

    if (status === 500 || status === 503) {
      return new NetworkError('SERVER_ERROR', `Dropbox ${status}`, true, err);
    }

    if (status === 507) {
      return new QuotaExceededError('QUOTA_EXCEEDED', 'Dropbox reports insufficient space', false, err);
    }

    // Fallback for unexpected status codes — be conservative, allow retry.
    return new NetworkError('NETWORK_ERROR', `Unexpected status ${status}`, true, err);
  }

  // No status → fetch aborted / DNS / TCP reset / TypeError. retry.ts gets
  // its chance; after maxAttempts the last one surfaces.
  const msg = err instanceof Error ? err.message : String(err);
  return new NetworkError('NETWORK_ERROR', `Network error: ${msg}`, true, err);
}

// ---------------------------------------------------------------------------
// DropboxClient
// ---------------------------------------------------------------------------

export class DropboxClient {
  private readonly sdk: DropboxLike;
  private readonly tokenStore: TokenStore;
  private readonly logger: Logger;
  private readonly singleShotMaxBytes: number;
  private readonly uploadChunkBytes: number;
  private readonly retryOptions: RetryOptions;

  // Single-flight guard: if two operations both hit 401 in parallel (or a
  // proactive refresh races a reactive one), we coalesce onto one in-flight
  // refresh promise so the SDK sees exactly one `refreshAccessToken` call and
  // TokenStore sees at most one `save`.
  private refreshInFlight: Promise<void> | null = null;

  // Shared rate-limit gate: epoch-ms timestamp before which all ops on this
  // client must wait. Bumped on every 429 / too_many_write_operations using
  // the server's Retry-After. Lets parallel uploaders share one back-off
  // instead of each one independently chewing through retry attempts and
  // re-flooding Dropbox.
  private rateLimitResumeAt = 0;

  // Proactive token bucket. Sized so a 2-way parallel upload of a 6k-file
  // vault stays under Dropbox's per-app `files/upload` budget by smoothing
  // the burst from ~40 req/s (2 ops × ~20/s each) to a steady ~5 req/s. Null
  // when explicitly disabled via options.rateLimit.enabled = false.
  private readonly bucket: TokenBucket | null;

  constructor(sdk: Dropbox, tokenStore: TokenStore, logger: Logger, options: DropboxClientOptions = {}) {
    this.sdk = asDropboxLike(sdk);
    this.tokenStore = tokenStore;
    this.logger = logger;
    this.singleShotMaxBytes = options.singleShotMaxBytes ?? DEFAULT_SINGLE_SHOT_MAX_BYTES;
    this.uploadChunkBytes = options.uploadChunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES;
    this.retryOptions = {
      isRetryable: (e) => e instanceof ArchivistError && e.retryable,
      ...options.retry,
    };
    const rl = options.rateLimit ?? {};
    if (rl.enabled === false) {
      this.bucket = null;
    } else {
      this.bucket = new TokenBucket(
        rl.requestsPerSecond ?? DEFAULT_RATE_LIMIT_REQUESTS_PER_SECOND,
        rl.burst ?? DEFAULT_RATE_LIMIT_BURST,
        this.retryOptions.sleep ?? defaultGateSleep,
      );
    }
  }

  // ---- Public API --------------------------------------------------------

  async uploadBlob(path: string, bytes: Uint8Array, opts?: { mode?: 'overwrite' | 'add' }): Promise<void> {
    const mode = opts?.mode ?? 'overwrite';
    await this.runOp(
      () =>
        this.sdk.filesUpload({
          path: normalizeApiPath(path),
          contents: bytes,
          mode: { '.tag': mode },
        }),
      { endpoint: 'files_upload' },
    );
  }

  async uploadJson(path: string, value: unknown): Promise<void> {
    const body = new TextEncoder().encode(JSON.stringify(value));
    await this.uploadBlob(path, body);
  }

  async downloadBytes(path: string): Promise<Uint8Array> {
    return await this.runOp(
      async () => {
        const resp = await this.sdk.filesDownload({ path: normalizeApiPath(path) });
        return await extractBytes(resp.result as FileDownloadResult);
      },
      { endpoint: 'files_download' },
    );
  }

  async downloadJson<T>(path: string, opts?: { isManifestEndpoint?: boolean }): Promise<T> {
    const isManifestEndpoint = opts?.isManifestEndpoint ?? false;
    return await this.runOp(
      async () => {
        const resp = await this.sdk.filesDownload({ path: normalizeApiPath(path) });
        const bytes = await extractBytes(resp.result as FileDownloadResult);
        // Guarded JSON.parse — the wrapper throws SyntaxError which the outer
        // classifyError converts to CorruptionError | NetworkError based on
        // isManifestEndpoint.
        const text = new TextDecoder('utf-8').decode(bytes);
        const parsed = JSON.parse(text) as T;
        return parsed;
      },
      { endpoint: 'files_download_json', isManifestEndpoint },
    );
  }

  async listFolder(path: string, opts?: { recursive?: boolean }): Promise<ListFolderEntry[]> {
    return await this.runOp(
      async () => {
        const first = await this.sdk.filesListFolder({ path: normalizeApiPath(path), recursive: opts?.recursive ?? false });

        const out: ListFolderEntry[] = first.result.entries.map(normalizeEntry);
        let cursor = first.result.cursor;
        let hasMore = first.result.has_more;

        while (hasMore) {
          const next = await this.sdk.filesListFolderContinue({ cursor });
          for (const entry of next.result.entries) out.push(normalizeEntry(entry));
          cursor = next.result.cursor;
          hasMore = next.result.has_more;
        }

        return out;
      },
      { endpoint: 'files_list_folder' },
    );
  }

  async deleteV2(path: string): Promise<void> {
    await this.runOp(
      () => this.sdk.filesDeleteV2({ path: normalizeApiPath(path) }),
      { endpoint: 'files_delete_v2' },
    );
  }

  /**
   * Upload a byte payload of arbitrary size. Single-shot when
   * `bytes.length <= singleShotMaxBytes`; otherwise chunk via upload_session
   * using `uploadChunkBytes` per request.
   *
   * The upload_session dance (start → append* → finish) lives behind a single
   * method by design: callers don't want to manage cursors and offsets.
   *
   * `opts.chunkBytes` overrides the instance-level `uploadChunkBytes` for this
   * call only (PERF-M2 adaptive chunk size: 8 MB for files < 50 MB, 150 MB for
   * files >= 50 MB). The instance default is used when not provided.
   */
  async uploadLarge(path: string, bytes: Uint8Array, opts?: { mode?: 'overwrite' | 'add'; chunkBytes?: number }): Promise<void> {
    if (bytes.length <= this.singleShotMaxBytes) {
      await this.uploadBlob(path, bytes, opts);
      return;
    }

    const mode = opts?.mode ?? 'overwrite';
    await this.runOp(
      async () => {
        const chunk = opts?.chunkBytes ?? this.uploadChunkBytes;
        const firstChunk = bytes.subarray(0, Math.min(chunk, bytes.length));

        const startResp = await this.sdk.filesUploadSessionStart({
          contents: firstChunk,
          close: bytes.length <= chunk,
        });
        const sessionId = startResp.result.session_id;

        let offset = firstChunk.byteLength;
        // Append every full mid-chunk, leaving the tail for finish() so we
        // commit atomically.
        while (offset + chunk < bytes.length) {
          const slice = bytes.subarray(offset, offset + chunk);
          await this.sdk.filesUploadSessionAppendV2({
            cursor: { session_id: sessionId, offset },
            contents: slice,
            close: false,
          });
          offset += slice.byteLength;
        }

        const tail = bytes.subarray(offset);
        await this.sdk.filesUploadSessionFinish({
          cursor: { session_id: sessionId, offset },
          commit: { path: normalizeApiPath(path), mode: { '.tag': mode } },
          contents: tail,
        });
      },
      { endpoint: 'files_upload_session' },
    );
  }

  // ---- Internals ---------------------------------------------------------

  /**
   * Wraps `op` with (1) proactive token-refresh when the stored access token
   * is near expiry, (2) one-shot reactive refresh on 401 expired_access_token,
   * and (3) generic retry/backoff for transient errors.
   */
  private async runOp<T>(op: () => Promise<T>, context: { endpoint: string; isManifestEndpoint?: boolean }): Promise<T> {
    await this.maybeProactiveRefresh();
    return await retry(() => this.withAuthRefresh(op, context), this.retryOptions);
  }

  private async withAuthRefresh<T>(
    op: () => Promise<T>,
    context: { endpoint: string; isManifestEndpoint?: boolean },
  ): Promise<T> {
    try {
      return await this.attempt(op, context);
    } catch (err) {
      if (err instanceof AuthError && err.code === 'TOKEN_EXPIRED') {
        await this.refreshAndPersistTokens();
        try {
          return await this.attempt(op, context);
        } catch (retryErr) {
          if (retryErr instanceof AuthError && retryErr.code === 'TOKEN_EXPIRED') {
            // Refresh didn't help — treat as revoked so the retry wrapper
            // gives up immediately (non-retryable).
            throw new AuthError('TOKEN_REVOKED', 'Access token still rejected after refresh', false, retryErr.cause);
          }
          throw retryErr;
        }
      }
      throw err;
    }
  }

  /**
   * Run `op` once and convert any thrown value through `classifyError`.
   * Kept separate from withAuthRefresh so the auth-refresh handler can decide
   * whether to retry based on the already-classified error.
   *
   * Awaits the shared rate-limit gate before issuing the SDK call so a 429 on
   * any sibling op throttles this one too. On a fresh RateLimitError, bumps
   * the gate so the sibling ops that are about to retry observe the same
   * back-off window instead of each one re-tripping the limit.
   */
  private async attempt<T>(
    op: () => Promise<T>,
    context: { endpoint: string; isManifestEndpoint?: boolean },
  ): Promise<T> {
    // Order matters: bucket FIRST (smooths burst rate), gate SECOND (extends
    // back-off after an observed 429 beyond what the bucket alone would do).
    if (this.bucket) await this.bucket.acquire();
    await this.awaitRateLimit();
    try {
      return await op();
    } catch (err) {
      const classified = classifyError(err, { isManifestEndpoint: context.isManifestEndpoint });
      if (classified instanceof RateLimitError) {
        this.bumpRateLimitGate(classified.retryAfterSeconds);
      }
      throw classified;
    }
  }

  private async awaitRateLimit(): Promise<void> {
    const waitMs = this.rateLimitResumeAt - Date.now();
    if (waitMs <= 0) return;
    const sleep = this.retryOptions.sleep ?? defaultGateSleep;
    await sleep(waitMs);
  }

  private bumpRateLimitGate(retryAfterSeconds: number): void {
    const finite = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 0;
    const pauseMs = Math.max(finite * 1_000, RATE_LIMIT_MIN_PAUSE_MS);
    const resumeAt = Date.now() + pauseMs;
    if (resumeAt > this.rateLimitResumeAt) this.rateLimitResumeAt = resumeAt;
  }

  private async maybeProactiveRefresh(): Promise<void> {
    try {
      const tokens = await this.tokenStore.load();
      if (!tokens) return;
      if (this.tokenStore.isAccessTokenNearExpiry(tokens, PROACTIVE_REFRESH_THRESHOLD_SECONDS)) {
        await this.refreshAndPersistTokens(tokens);
      }
    } catch (err) {
      // Proactive refresh is best-effort. Log and let the reactive 401 path
      // handle it if the token really is expired. Use a safe error shape so
      // we never embed raw request bodies from the SDK in the log. Demoted
      // to debug because the reactive path will surface a real error if the
      // token truly is unrecoverable — surfacing this proactive miss as a
      // warn scares users for an event the system handles automatically.
      this.logger.debug('proactive_refresh_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Run the SDK's built-in refresh flow, then persist whatever the SDK now
   * thinks the access token is so the store survives plugin restart.
   *
   * Single-flight: concurrent callers await the same in-flight promise so we
   * never fire two `refreshAccessToken` calls (and never double-`save`).
   */
  private async refreshAndPersistTokens(prev?: Tokens | null): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefreshAndPersist(prev).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefreshAndPersist(prev?: Tokens | null): Promise<void> {
    await this.sdk.auth.refreshAccessToken();
    const newAccessToken = this.sdk.auth.getAccessToken();
    const expiresAt = safeExpiresAt(this.sdk.auth.getAccessTokenExpiresAt());
    const base = prev ?? (await this.tokenStore.load());
    if (!base) {
      // No stored tokens means we can't reconstruct the full record (we'd
      // lose refresh_token / email). Skip the save; the SDK has already
      // updated its in-memory token, so the retry can still succeed.
      return;
    }
    const updated: Tokens = {
      ...base,
      access_token: newAccessToken,
      access_token_expires_at: expiresAt,
    };
    try {
      await this.tokenStore.save(updated);
    } catch (err) {
      // Divergence window: SDK memory now holds the NEW token; disk still
      // holds the OLD one. We log-and-swallow (rather than re-throw) because:
      //   (a) the current session keeps working via SDK in-memory token, so
      //       the in-flight op can still succeed on retry;
      //   (b) re-throwing would leak a disk-layer failure into retry.ts,
      //       which would misclassify it as a Dropbox error;
      //   (c) on next restart the stored (old) token is already expired, so
      //       the normal re-auth path kicks in — which is the correct outcome.
      // Log with a stable key and a safe message so request bodies embedded in
      // `err` never land in the log.
      this.logger.warn('tokens_save_after_refresh_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Prepend a leading slash to a Dropbox `files/*` path argument when missing.
 *
 * Dropbox API rejects paths that don't match
 *   `(/...)|(id:...)|(rev:[0-9a-f]{9,})|(ns:[0-9]+/...)`
 * with `HTTP 400 "Malformed request"`. All path-builders in
 * `src/util/paths.ts` produce `Apps/Archivist/<prefix>/...` (NO leading
 * slash) because that's the natural form for log lines and assertions.
 * The SDK forwards whatever it gets, so the normalisation has to live at
 * the SDK boundary — here. id:/rev:/ns: forms are passed through unchanged
 * for callers that pre-resolve a Dropbox file reference.
 *
 * Empty string is preserved as-is. Some Dropbox endpoints accept it for
 * "root of the app folder"; we don't currently rely on that, but the
 * normaliser shouldn't change semantics for callers who do.
 */
function normalizeApiPath(path: string): string {
  if (
    path === '' ||
    path.startsWith('/') ||
    path.startsWith('id:') ||
    path.startsWith('rev:') ||
    path.startsWith('ns:')
  ) {
    return path;
  }
  return `/${path}`;
}

function normalizeEntry(raw: ListFolderEntryRaw): ListFolderEntry {
  const tag = raw['.tag'];
  const normalizedTag: ListFolderEntry['tag'] =
    tag === 'file' || tag === 'folder' || tag === 'deleted' ? tag : 'file';
  const path = raw.path_display ?? raw.path_lower ?? raw.name ?? '';
  const out: ListFolderEntry = { tag: normalizedTag, path };
  if (raw.rev !== undefined) out.rev = raw.rev;
  if (raw.size !== undefined) out.size = raw.size;
  if (raw.server_modified !== undefined) out.server_modified = raw.server_modified;
  if (raw.content_hash !== undefined) out.content_hash = raw.content_hash;
  return out;
}

async function extractBytes(result: FileDownloadResult): Promise<Uint8Array> {
  if (result.fileBinary instanceof Uint8Array) return result.fileBinary;
  if (result.fileBinary && result.fileBinary instanceof ArrayBuffer) {
    return new Uint8Array(result.fileBinary);
  }
  if (result.fileBlob) {
    const buf = await result.fileBlob.arrayBuffer();
    return new Uint8Array(buf);
  }
  throw new NetworkError('NETWORK_ERROR', 'Download response carried no file body', true);
}

// Production sleep for the rate-limit gate. Lives here (not in retry.ts) so
// tests can substitute it via `RetryOptions.sleep`. We intentionally don't
// thread an AbortSignal — the gate is best-effort throttling, not cancellable
// work; if a caller aborts, the next attempt will short-circuit on the
// AbortSignal already wired through retry().
//
// Aliased through `setT` to mirror retry.ts: the obsidianmd lint rule
// (`prefer-window-timers`) wants `window.setTimeout`, but the gate runs in
// both the Obsidian renderer and Node test env. Caller-supplied `sleep` is
// the supported escape hatch for callers that need popout-aware timers.
const setT: typeof setTimeout = setTimeout;
function defaultGateSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setT(resolve, ms));
}

// Token bucket used by DropboxClient as a proactive rate limiter.
//
// Decoupled from the reactive gate so callers don't have to wait for a 429
// to discover a budget exists. Uses Date.now() directly for refill timing so
// it responds correctly even when the test sleep is a no-op (refill window
// never opens, bucket reports empty, acquire() loops via injected sleep —
// which IS observable in tests).
//
// Not exported: the bucket is an implementation detail of DropboxClient. If a
// future caller needs its own bucket, promote at that point — over-exposing
// it now would invite ad-hoc rate-limiter clones across the codebase.
class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly refillPerSecond: number,
    private readonly capacity: number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {
    // Start full so the first burst (commit-time HEAD/manifest/index writes)
    // doesn't pay a startup tax.
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  async acquire(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // Wait just long enough for one token to refill, then re-check. Looping
      // on re-check (instead of computing exact wait once) keeps the bucket
      // honest under concurrent acquirers — each gets a fresh refill view
      // after waking and only takes a token if one is genuinely available.
      const waitMs = Math.max(1, Math.ceil(1000 / this.refillPerSecond));
      await this.sleep(waitMs);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond);
    this.lastRefillMs = now;
  }
}

function safeExpiresAt(d: Date | undefined | null): string {
  if (d && !Number.isNaN(d.getTime())) return d.toISOString();
  // Dropbox access tokens last ~4 hours. If the SDK didn't report an expiry,
  // fall back to +4h from now so the proactive-refresh predicate still works.
  return new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
}
