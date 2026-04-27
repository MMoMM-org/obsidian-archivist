// Minimal fake Dropbox SDK surface.
//
// DropboxClient consumes a tiny slice of the real SDK: the `auth` facade (for
// token refresh + access-token getters) plus a handful of `files*` methods.
// This helper returns a structurally-compatible fake built from per-method
// handlers so tests can script the exact sequence of successes / failures
// the error matrix requires — without pulling fetch or the real SDK in.
//
// The DropboxClient treats the SDK as an opaque collaborator, so this mock
// does NOT need to satisfy the full `Dropbox` class type; the production
// code should accept a structural type it owns.

import { vi, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// SDK error shape (mirrors node_modules/dropbox types/index.d.ts)
// ---------------------------------------------------------------------------

export interface FakeDropboxResponseError<T = unknown> {
  // Brand so classifyError's `err instanceof DropboxResponseError` check — or
  // duck-type equivalent — can pick it out. DropboxClient uses duck-typing
  // (status + error + headers) to stay SDK-version-tolerant.
  name: 'DropboxResponseError';
  status: number;
  headers: Record<string, string>;
  error: T;
}

export function sdkError<T>(status: number, error: T, headers: Record<string, string> = {}): FakeDropboxResponseError<T> {
  return { name: 'DropboxResponseError', status, headers, error };
}

export interface FakeDropboxResponse<T> {
  status: number;
  headers: Record<string, string>;
  result: T;
}

export function sdkResponse<T>(result: T, status = 200, headers: Record<string, string> = {}): FakeDropboxResponse<T> {
  return { status, headers, result };
}

// ---------------------------------------------------------------------------
// FakeDropbox wiring
// ---------------------------------------------------------------------------

export interface FakeAuth {
  refreshAccessToken: Mock;
  getAccessToken: Mock;
  getAccessTokenExpiresAt: Mock;
  getRefreshToken: Mock;
}

export interface FakeDropbox {
  auth: FakeAuth;
  filesUpload: Mock;
  filesDownload: Mock;
  filesListFolder: Mock;
  filesListFolderContinue: Mock;
  filesDeleteV2: Mock;
  filesUploadSessionStart: Mock;
  filesUploadSessionAppendV2: Mock;
  filesUploadSessionFinish: Mock;
}

export interface FakeSdkConfig {
  // Auth overrides
  refreshAccessToken?: () => Promise<void> | void;
  getAccessToken?: () => string;
  getAccessTokenExpiresAt?: () => Date;
  getRefreshToken?: () => string;

  // Files overrides — each receives the arg the SDK would receive and returns
  // the SDK response shape or throws a FakeDropboxResponseError.
  filesUpload?: (arg: unknown) => Promise<FakeDropboxResponse<unknown>> | FakeDropboxResponse<unknown>;
  filesDownload?: (arg: unknown) => Promise<FakeDropboxResponse<unknown>> | FakeDropboxResponse<unknown>;
  filesListFolder?: (arg: unknown) => Promise<FakeDropboxResponse<unknown>> | FakeDropboxResponse<unknown>;
  filesListFolderContinue?: (arg: unknown) => Promise<FakeDropboxResponse<unknown>> | FakeDropboxResponse<unknown>;
  filesDeleteV2?: (arg: unknown) => Promise<FakeDropboxResponse<unknown>> | FakeDropboxResponse<unknown>;
  filesUploadSessionStart?: (arg: unknown) => Promise<FakeDropboxResponse<unknown>> | FakeDropboxResponse<unknown>;
  filesUploadSessionAppendV2?: (arg: unknown) => Promise<FakeDropboxResponse<unknown>> | FakeDropboxResponse<unknown>;
  filesUploadSessionFinish?: (arg: unknown) => Promise<FakeDropboxResponse<unknown>> | FakeDropboxResponse<unknown>;
}

export function makeFakeSdk(cfg: FakeSdkConfig = {}): FakeDropbox {
  const wrap = (fn?: (arg: unknown) => unknown): Mock => {
    return vi.fn(async (arg: unknown) => {
      if (!fn) {
        throw new Error('FakeDropbox: unconfigured method called');
      }
      return await fn(arg);
    });
  };

  return {
    auth: {
      refreshAccessToken: vi.fn(async () => {
        if (cfg.refreshAccessToken) await cfg.refreshAccessToken();
      }),
      getAccessToken: vi.fn(() => (cfg.getAccessToken ? cfg.getAccessToken() : 'new_access_token')),
      getAccessTokenExpiresAt: vi.fn(() =>
        cfg.getAccessTokenExpiresAt
          ? cfg.getAccessTokenExpiresAt()
          : new Date(Date.now() + 4 * 60 * 60 * 1000),
      ),
      getRefreshToken: vi.fn(() => (cfg.getRefreshToken ? cfg.getRefreshToken() : 'unchanged_refresh')),
    },
    filesUpload: wrap(cfg.filesUpload),
    filesDownload: wrap(cfg.filesDownload),
    filesListFolder: wrap(cfg.filesListFolder),
    filesListFolderContinue: wrap(cfg.filesListFolderContinue),
    filesDeleteV2: wrap(cfg.filesDeleteV2),
    filesUploadSessionStart: wrap(cfg.filesUploadSessionStart),
    filesUploadSessionAppendV2: wrap(cfg.filesUploadSessionAppendV2),
    filesUploadSessionFinish: wrap(cfg.filesUploadSessionFinish),
  };
}
