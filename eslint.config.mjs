import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import localPlugin from './tools/eslint/index.mjs';

const TS_SOURCES = ['src/**/*.ts'];

export default [
  // Ignore patterns (replaces .eslintrc ignorePatterns)
  {
    ignores: [
      'node_modules/',
      'dist/',
      'main.js',
      'test/Archivist/',
      'tests/fixtures/',
      '.github/',
      'tools/eslint/',
      '*.config.mjs',
      '*.config.ts',
    ],
  },

  // Base JS recommended. Every block below that enables JS/TS rules is
  // scoped to TS_SOURCES: obsidianmd >= 0.5 also lints manifest.json and
  // LICENSE (JSON / plain-text languages), and an unscoped block that runs
  // core or type-checked rules on them aborts the whole run.
  { ...js.configs.recommended, files: TS_SOURCES },

  // TypeScript recommended (unified typescript-eslint package).
  // Type-checked variant adds rules like no-unsafe-assignment that the
  // Obsidian plugin-review bot enforces — catching these locally before
  // they show up in review.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: TS_SOURCES,
  })),

  // Obsidian-specific rules (flat-config shape — array of config objects)
  ...(Array.isArray(obsidianmd.configs?.recommended)
    ? obsidianmd.configs.recommended
    : obsidianmd.default?.configs?.recommended
      ? Array.isArray(obsidianmd.default.configs.recommended)
        ? obsidianmd.default.configs.recommended
        : [obsidianmd.default.configs.recommended]
      : []),

  // Local plugin: our custom no-unsafe-innerhtml rule
  {
    files: TS_SOURCES,
    plugins: { local: localPlugin },
    rules: {
      'local/no-unsafe-innerhtml': 'error',
    },
  },

  // Project-specific overrides: TypeScript files in src/
  {
    files: TS_SOURCES,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.json',
      },
    },
  },
];
