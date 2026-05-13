import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import localPlugin from './tools/eslint/index.mjs';

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

  // Base JS recommended
  js.configs.recommended,

  // TypeScript recommended (unified typescript-eslint package)
  ...tseslint.configs.recommended,

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
    plugins: { local: localPlugin },
    rules: {
      'local/no-unsafe-innerhtml': 'error',
    },
  },

  // Project-specific overrides: TypeScript files in src/
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.json',
      },
    },
  },
];
