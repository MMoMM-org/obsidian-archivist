// T4.1 — Compile-time type tests for VaultAdapter event method signatures.
// These tests assert that passing a handler with the wrong arity is caught by
// TypeScript at compile time.  The @ts-expect-error directives prove that the
// wrong signatures are rejected.
//
// This file is included in the vitest run via `tests/**/*.test.ts` but the
// runtime body is empty — the value is purely in the tsc errors being detected
// during `npm run typecheck`.

import type { TAbstractFile } from '../fixtures/obsidian-mock';
import type { VaultAdapter } from '../../src/infra/VaultAdapter';

// We only need the type; never instantiate so no real imports required.
declare const va: VaultAdapter;

// ---------------------------------------------------------------------------
// Correct signatures — must NOT produce a TS error
// ---------------------------------------------------------------------------

va.onVaultCreate((_file: TAbstractFile) => {});
va.onVaultModify((_file: TAbstractFile) => {});
va.onVaultDelete((_file: TAbstractFile) => {});
va.onVaultRename((_file: TAbstractFile, _oldPath: string) => {});

// ---------------------------------------------------------------------------
// Wrong signatures — must produce a TS error
// ---------------------------------------------------------------------------

// onVaultRename with only one argument (missing oldPath)
// @ts-expect-error — rename handler must accept two parameters
va.onVaultRename((_file: TAbstractFile) => {});

// onVaultCreate with two arguments (too many)
// @ts-expect-error — create handler must accept exactly one parameter
va.onVaultCreate((_file: TAbstractFile, _extra: string) => {});

// onVaultModify with two arguments
// @ts-expect-error — modify handler must accept exactly one parameter
va.onVaultModify((_file: TAbstractFile, _extra: string) => {});

// onVaultDelete with two arguments
// @ts-expect-error — delete handler must accept exactly one parameter
va.onVaultDelete((_file: TAbstractFile, _extra: string) => {});

// Dummy export to satisfy isolatedModules / ensure file is treated as a module
export {};

// Vitest requires at least one test in included files; use a trivial pass.
import { it } from 'vitest';
it('type-level compile-time checks (see @ts-expect-error comments)', () => {
  // All assertions are at compile time; nothing to assert at runtime.
});
