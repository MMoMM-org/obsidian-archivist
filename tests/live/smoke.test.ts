// smoke.test.ts — T10.3c: live Dropbox API smoke test.
//
// This file is EXCLUDED from the regular vitest suite (see vitest.config.ts).
// Run manually or via .github/workflows/live-dropbox.yml:
//   DROPBOX_TEST_CLIENT_ID=... DROPBOX_TEST_REFRESH_TOKEN=... npx vitest run tests/live/
//
// Required environment variables:
//   DROPBOX_TEST_CLIENT_ID      — Dropbox app key for the test app
//   DROPBOX_TEST_REFRESH_TOKEN  — OAuth2 refresh token for the test account
//
// All tests are skipped automatically when either variable is absent.

import { describe, it, expect, beforeAll } from 'vitest';
import { Dropbox, DropboxAuth } from 'dropbox';
import { DropboxClient } from '../../src/infra/DropboxClient';
import { createLogger } from '../../src/infra/Logger';

// ---------------------------------------------------------------------------
// Environment guard
// ---------------------------------------------------------------------------

const CLIENT_ID = process.env.DROPBOX_TEST_CLIENT_ID ?? '';
const REFRESH_TOKEN = process.env.DROPBOX_TEST_REFRESH_TOKEN ?? '';
const SKIP = !CLIENT_ID || !REFRESH_TOKEN;

// ---------------------------------------------------------------------------
// Minimal TokenStore for live test (refresh token is static)
// ---------------------------------------------------------------------------

const liveTokenStore = {
  load: async () => ({
    access_token: '',
    access_token_expires_at: new Date(0).toISOString(),
    refresh_token: REFRESH_TOKEN,
    account_id: 'test',
    email: 'test@example.com',
  }),
  save: async () => {},
  isAccessTokenNearExpiry: () => true, // force proactive refresh so we always have a valid token
};

// ---------------------------------------------------------------------------
// Test app folder prefix — unique per run to avoid collisions
// ---------------------------------------------------------------------------

const RUN_ID = Date.now().toString(36);
const TEST_FOLDER = `/Apps/Archivist-Test/smoke-${RUN_ID}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildClient(): DropboxClient {
  const auth = new DropboxAuth({ clientId: CLIENT_ID });
  auth.setRefreshToken(REFRESH_TOKEN);
  const sdk = new Dropbox({ auth });
  const logger = createLogger(() => false);
  return new DropboxClient(sdk, liveTokenStore as never, logger);
}

// ---------------------------------------------------------------------------
// Live smoke test
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('Live Dropbox smoke test', () => {
  let client: DropboxClient;

  beforeAll(() => {
    client = buildClient();
  });

  it('uploads 10 blobs, downloads them, verifies hashes, then cleans up', async () => {
    const blobs: Array<{ path: string; content: Uint8Array }> = [];

    // Upload 10 small blobs
    for (let i = 1; i <= 10; i++) {
      const content = new TextEncoder().encode(`hello-${i}`);
      const path = `${TEST_FOLDER}/hello-${i}.txt`;
      await client.uploadBlob(path, content);
      blobs.push({ path, content });
    }

    // Download and verify hash-match (byte-for-byte equality)
    for (const { path, content } of blobs) {
      const downloaded = await client.downloadBytes(path);
      expect(downloaded.length).toBe(content.length);
      // Compare bytes
      for (let j = 0; j < content.length; j++) {
        expect(downloaded[j]).toBe(content[j]);
      }
    }

    // Delete all blobs
    for (const { path } of blobs) {
      await client.deleteV2(path);
    }

    // Verify folder is empty (list returns no file entries)
    const entries = await client.listFolder(TEST_FOLDER);
    const fileEntries = entries.filter((e) => e.tag === 'file');
    expect(fileEntries).toHaveLength(0);
  }, 60_000); // 60s timeout for live API calls
});
