import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// __dirname is not available in ESM; derive it from import.meta.url.
const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Map the 'obsidian' runtime import to our test mock so vitest can
      // resolve it (the real obsidian package has main: "" — types-only).
      obsidian: resolve(__dirname, 'tests/fixtures/obsidian-mock.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live/**', 'tests/fixtures/**', 'tests/soak/**', 'tests/cli/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      include: ['src/**/*.ts'],
      exclude: ['tests/**', 'dist/**'],
    },
  },
});
