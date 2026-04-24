// T4.1 — Compile-time type tests for VaultAdapter event method signatures.
//
// The @ts-expect-error comments prove that wrong arities are rejected by tsc
// during `npm run typecheck`. At runtime the test body is a trivial no-op.
//
// Technique: the "wrong" calls are in a helper that is never invoked at runtime
// but must type-check (or fail type-check) when tsc processes this file.

import { it } from 'vitest';
import type { TAbstractFile } from '../fixtures/obsidian-mock';
import type { VaultAdapter } from '../../src/infra/VaultAdapter';

// ---------------------------------------------------------------------------
// Type-level helpers — never called at runtime
// ---------------------------------------------------------------------------

// Correct signatures — must compile without error
function _correctSignatures(va: VaultAdapter): void {
  va.onVaultCreate((_file: TAbstractFile) => {});
  va.onVaultModify((_file: TAbstractFile) => {});
  va.onVaultDelete((_file: TAbstractFile) => {});
  va.onVaultRename((_file: TAbstractFile, _oldPath: string) => {});
}

// Wrong signatures — must each produce a TS error
function _wrongSignatures(va: VaultAdapter): void {
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
}

// Silence "unused" warnings — values are never used at runtime
void _correctSignatures;
void _wrongSignatures;

// ---------------------------------------------------------------------------
// Runtime test — trivial; all real checks are at compile time
// ---------------------------------------------------------------------------

it('type-level compile-time checks pass (see @ts-expect-error comments)', () => {
  // Nothing to assert at runtime — tsc is the validator.
});
