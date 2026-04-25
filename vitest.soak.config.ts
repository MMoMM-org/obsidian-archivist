// vitest.soak.config.ts — config for the nightly soak test suite.
// Run with: npx vitest run --config vitest.soak.config.ts

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
    include: ['tests/soak/**/*.test.ts'],
    testTimeout: 300_000, // 5 minutes per test
  },
});
