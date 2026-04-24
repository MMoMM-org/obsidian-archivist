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

// Wrong signatures — each must produce a TS error.
//
// NOTE on "too-few-params" cases: TypeScript's callback-parameter rule treats a
// handler with FEWER params as assignable to a function type that expects MORE
// (the caller simply ignores the missing param). That means a spec claim of
// "rename handler with only one param fails at compile time" is not something
// TS can enforce in isolation — tsc will happily accept `(_file) => {}` as a
// `(file, oldPath) => void`. Runtime tests cover the real contract (oldPath is
// actually passed). What we CAN enforce here is the symmetric case — passing
// MORE params than the handler type declares — plus a structural equality
// check on the declared parameter types.
function _wrongSignatures(va: VaultAdapter): void {
  // onVaultCreate with two arguments (too many)
  // @ts-expect-error — create handler must accept exactly one parameter
  va.onVaultCreate((_file: TAbstractFile, _extra: string) => {});

  // onVaultModify with two arguments
  // @ts-expect-error — modify handler must accept exactly one parameter
  va.onVaultModify((_file: TAbstractFile, _extra: string) => {});

  // onVaultDelete with two arguments
  // @ts-expect-error — delete handler must accept exactly one parameter
  va.onVaultDelete((_file: TAbstractFile, _extra: string) => {});

  // onVaultRename with three arguments (too many)
  // @ts-expect-error — rename handler accepts exactly two parameters
  va.onVaultRename((_file: TAbstractFile, _oldPath: string, _extra: number) => {});
}

// Positive structural check: the declared handler type must accept the
// expected parameters. If the signature narrows (e.g. `file` no longer
// `TAbstractFile`) these assignments will stop compiling.
type _RenameHandlerType = Parameters<VaultAdapter['onVaultRename']>[0];
type _CreateHandlerType = Parameters<VaultAdapter['onVaultCreate']>[0];

const _renameShapeOk: _RenameHandlerType = (_file: TAbstractFile, _oldPath: string) => {};
const _createShapeOk: _CreateHandlerType = (_file: TAbstractFile) => {};
void _renameShapeOk;
void _createShapeOk;

// Silence "unused" warnings — values are never used at runtime
void _correctSignatures;
void _wrongSignatures;

// ---------------------------------------------------------------------------
// Runtime test — trivial; all real checks are at compile time
// ---------------------------------------------------------------------------

it('type-level compile-time checks pass (see @ts-expect-error comments)', () => {
  // Nothing to assert at runtime — tsc is the validator.
});
