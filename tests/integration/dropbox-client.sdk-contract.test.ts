// dropbox-client.sdk-contract.test.ts — T10.3b: classifyError contract pin.
//
// Tests pin the current behavior of classifyError against raw Dropbox SDK error
// shapes. If classifyError is intentionally changed, update these tests to match
// the new contract. Do NOT change classifyError to make tests pass unless there
// is a clear bug.

import { describe, expect, it } from 'vitest';
import { classifyError } from '../../src/infra/DropboxClient';
import {
  AuthError,
  NetworkError,
  PathError,
  QuotaExceededError,
  RateLimitError,
} from '../../src/model/Errors';

// ---------------------------------------------------------------------------
// Helper to construct Dropbox SDK error shapes
// ---------------------------------------------------------------------------

function sdkError(
  status: number,
  opts: {
    error?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  return { status, error: opts.error, headers: opts.headers };
}

// ---------------------------------------------------------------------------
// 401 — expired_access_token → AuthError TOKEN_EXPIRED (retryable)
// ---------------------------------------------------------------------------

describe('classifyError — 401 expired_access_token', () => {
  it('maps to AuthError with code TOKEN_EXPIRED', () => {
    const err = sdkError(401, {
      error: { '.tag': 'expired_access_token' },
    });
    const result = classifyError(err);
    expect(result).toBeInstanceOf(AuthError);
    expect((result as AuthError).code).toBe('TOKEN_EXPIRED');
    expect(result.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 401 — invalid_access_token → AuthError TOKEN_REVOKED (non-retryable)
// ---------------------------------------------------------------------------

describe('classifyError — 401 invalid_access_token', () => {
  it('maps to AuthError with code TOKEN_REVOKED', () => {
    const err = sdkError(401, {
      error: { '.tag': 'invalid_access_token' },
    });
    const result = classifyError(err);
    expect(result).toBeInstanceOf(AuthError);
    // Current behavior: anything other than expired_access_token → TOKEN_REVOKED
    expect((result as AuthError).code).toBe('TOKEN_REVOKED');
    expect(result.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 429 — rate limited with Retry-After header
// ---------------------------------------------------------------------------

describe('classifyError — 429 with Retry-After header', () => {
  it('maps to RateLimitError with retryAfterSeconds from header', () => {
    const err = sdkError(429, {
      headers: { 'retry-after': '3' },
    });
    const result = classifyError(err);
    expect(result).toBeInstanceOf(RateLimitError);
    expect((result as RateLimitError).retryAfterSeconds).toBe(3);
  });

  it('maps to RateLimitError with retryAfterSeconds 0 when header absent', () => {
    const err = sdkError(429, {});
    const result = classifyError(err);
    expect(result).toBeInstanceOf(RateLimitError);
    expect((result as RateLimitError).retryAfterSeconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 507 — quota exceeded
// ---------------------------------------------------------------------------

describe('classifyError — 507 quota exceeded', () => {
  it('maps to QuotaExceededError (non-retryable)', () => {
    const err = sdkError(507);
    const result = classifyError(err);
    expect(result).toBeInstanceOf(QuotaExceededError);
    expect(result.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 409 path/not_found → PathError PATH_NOT_FOUND
// ---------------------------------------------------------------------------

describe('classifyError — 409 path not_found', () => {
  it('maps nested path/not_found tag to PathError PATH_NOT_FOUND', () => {
    const err = sdkError(409, {
      error: { '.tag': 'path', path: { '.tag': 'not_found' } },
    });
    const result = classifyError(err);
    expect(result).toBeInstanceOf(PathError);
    expect((result as PathError).code).toBe('PATH_NOT_FOUND');
    expect(result.retryable).toBe(false);
  });

  it('maps path_lookup/not_found nested structure to PathError PATH_NOT_FOUND', () => {
    const err = sdkError(409, {
      error: { '.tag': 'path_lookup', path_lookup: { '.tag': 'not_found' } },
    });
    const result = classifyError(err);
    expect(result).toBeInstanceOf(PathError);
    expect((result as PathError).code).toBe('PATH_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// 500 — server error → NetworkError (retryable)
// ---------------------------------------------------------------------------

describe('classifyError — 500 server error', () => {
  it('maps to NetworkError with retryable=true', () => {
    const err = sdkError(500);
    const result = classifyError(err);
    expect(result).toBeInstanceOf(NetworkError);
    expect(result.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generic 4xx (e.g., 403) → NetworkError (retryable, conservative fallback)
// ---------------------------------------------------------------------------

describe('classifyError — unexpected 4xx', () => {
  it('maps unrecognized 4xx to NetworkError retryable (conservative fallback)', () => {
    const err = sdkError(403);
    const result = classifyError(err);
    // classifyError falls through to the final NetworkError fallback for 403
    expect(result).toBeInstanceOf(NetworkError);
    expect(result.retryable).toBe(true);
  });

  it('maps 400 to PathError BAD_REQUEST (non-retryable)', () => {
    const err = sdkError(400);
    const result = classifyError(err);
    expect(result).toBeInstanceOf(PathError);
    expect((result as PathError).code).toBe('BAD_REQUEST');
    expect(result.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Already-classified error — pass-through (no double-wrap)
// ---------------------------------------------------------------------------

describe('classifyError — pass-through for ArchivistError', () => {
  it('returns the same instance without wrapping', () => {
    const original = new AuthError('TOKEN_EXPIRED', 'already classified', true);
    const result = classifyError(original);
    expect(result).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// SyntaxError — JSON parse failure
// ---------------------------------------------------------------------------

describe('classifyError — SyntaxError', () => {
  it('maps JSON parse error on manifest endpoint to CorruptionError', async () => {
    const err = new SyntaxError('Unexpected token');
    const result = classifyError(err, { isManifestEndpoint: true });
    const { CorruptionError } = await import('../../src/model/Errors');
    expect(result).toBeInstanceOf(CorruptionError);
    expect(result.retryable).toBe(false);
  });

  it('maps JSON parse error on non-manifest endpoint to NetworkError (retryable)', () => {
    const err = new SyntaxError('Unexpected token');
    const result = classifyError(err, { isManifestEndpoint: false });
    expect(result).toBeInstanceOf(NetworkError);
    expect(result.retryable).toBe(true);
  });
});
