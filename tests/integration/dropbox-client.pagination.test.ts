// dropbox-client.pagination.test.ts — T10.3a: contract pin for list_folder pagination.
//
// Purpose: verify that DropboxClient.listFolder correctly exhausts multiple pages.
// A fake SDK is injected so this test is deterministic and has zero network I/O.
//
// Setup:
//   - First call to filesListFolder returns 10 entries with has_more=true, cursor='cursor-1'.
//   - Second call (filesListFolderContinue with cursor='cursor-1') returns 10 entries,
//     has_more=false.
//
// Assert:
//   - filesListFolderContinue invoked exactly once with cursor='cursor-1'.
//   - Final result is the merged 20-item list.

import { describe, expect, it, vi } from 'vitest';
import { DropboxClient } from '../../src/infra/DropboxClient';
import type { Dropbox } from 'dropbox';

// ---------------------------------------------------------------------------
// Fake SDK builder
// ---------------------------------------------------------------------------

function makeFakeEntry(index: number) {
  return {
    '.tag': 'file',
    path_lower: `/vault/file-${index}.md`,
    path_display: `/vault/file-${index}.md`,
    name: `file-${index}.md`,
    size: 100,
    server_modified: '2026-01-01T00:00:00Z',
  };
}

function makeFakeSdk(opts: {
  listFolderResult: { entries: unknown[]; cursor: string; has_more: boolean };
  listFolderContinueResult: { entries: unknown[]; cursor: string; has_more: boolean };
}) {
  const filesListFolderContinue = vi.fn().mockResolvedValue({
    status: 200,
    result: opts.listFolderContinueResult,
  });

  const sdk = {
    auth: {
      refreshAccessToken: vi.fn().mockResolvedValue(undefined),
      getAccessToken: vi.fn().mockReturnValue('tok'),
      getAccessTokenExpiresAt: vi.fn().mockReturnValue(new Date(Date.now() + 4 * 3600 * 1000)),
    },
    filesUpload: vi.fn(),
    filesDownload: vi.fn(),
    filesListFolder: vi.fn().mockResolvedValue({
      status: 200,
      result: opts.listFolderResult,
    }),
    filesListFolderContinue,
    filesDeleteV2: vi.fn(),
    filesUploadSessionStart: vi.fn(),
    filesUploadSessionAppendV2: vi.fn(),
    filesUploadSessionFinish: vi.fn(),
  };

  return { sdk: sdk as unknown as Dropbox, filesListFolderContinue };
}

// ---------------------------------------------------------------------------
// Minimal TokenStore stub (proactive refresh skipped when no stored token)
// ---------------------------------------------------------------------------

const noopTokenStore = {
  load: async () => null as null,
  save: async () => {},
  isAccessTokenNearExpiry: () => false,
};

// ---------------------------------------------------------------------------
// Minimal Logger stub
// ---------------------------------------------------------------------------

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DropboxClient.listFolder — pagination contract', () => {
  it('auto-paginates two pages and merges results into 20 items', async () => {
    const page1Entries = Array.from({ length: 10 }, (_, i) => makeFakeEntry(i));
    const page2Entries = Array.from({ length: 10 }, (_, i) => makeFakeEntry(i + 10));

    const { sdk, filesListFolderContinue } = makeFakeSdk({
      listFolderResult: {
        entries: page1Entries,
        cursor: 'cursor-1',
        has_more: true,
      },
      listFolderContinueResult: {
        entries: page2Entries,
        cursor: 'cursor-2',
        has_more: false,
      },
    });

    const client = new DropboxClient(sdk, noopTokenStore as never, silentLogger as never, {
      retry: { maxAttempts: 1 },
    });

    const result = await client.listFolder('/vault');

    // filesListFolderContinue must be called exactly once
    expect(filesListFolderContinue).toHaveBeenCalledTimes(1);

    // It must be called with the cursor from page 1
    expect(filesListFolderContinue).toHaveBeenCalledWith({ cursor: 'cursor-1' });

    // Final result is the merged 20-item list
    expect(result).toHaveLength(20);

    // All 20 paths present in order (page1 then page2)
    const paths = result.map((e) => e.path);
    for (let i = 0; i < 10; i++) {
      expect(paths).toContain(`/vault/file-${i}.md`);
    }
    for (let i = 10; i < 20; i++) {
      expect(paths).toContain(`/vault/file-${i}.md`);
    }
  });

  it('returns single-page result without calling listFolderContinue', async () => {
    const { sdk, filesListFolderContinue } = makeFakeSdk({
      listFolderResult: {
        entries: Array.from({ length: 5 }, (_, i) => makeFakeEntry(i)),
        cursor: 'cursor-only',
        has_more: false,
      },
      listFolderContinueResult: {
        entries: [],
        cursor: 'cursor-only',
        has_more: false,
      },
    });

    const client = new DropboxClient(sdk, noopTokenStore as never, silentLogger as never, {
      retry: { maxAttempts: 1 },
    });

    const result = await client.listFolder('/vault');

    expect(filesListFolderContinue).not.toHaveBeenCalled();
    expect(result).toHaveLength(5);
  });
});
