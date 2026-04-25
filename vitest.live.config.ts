// vitest.live.config.ts — config for the live Dropbox API integration tests.
// Run with: npx vitest run --config vitest.live.config.ts
// Requires: DROPBOX_TEST_CLIENT_ID + DROPBOX_TEST_REFRESH_TOKEN env vars.

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      obsidian: resolve(__dirname, 'tests/fixtures/obsidian-mock.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
