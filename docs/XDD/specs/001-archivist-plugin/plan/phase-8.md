---
title: "Phase 8: Restore Engine & Rename-Aware History"
status: pending
version: "1.0"
phase: 8
---

# Phase 8: Restore Engine & Rename-Aware History

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Implementation Examples/Example: Manifest Merge for Restore-at-Time-T]` + the traced walkthrough
- `[ref: SDD/Runtime View/Complex Logic/Algorithm 3 — listVersionsForPath]`
- `[ref: SDD/Runtime View/Primary Flow: File-Level Restore]`
- `[ref: SDD/ADR-4, ADR-13]`
- `[ref: PRD/F3, F4]`

**Key Decisions**:
- `materializeVaultStateAt(snapshotId)` is the core reconstruction primitive; used by both the Backup Browser (show files at a snapshot) and Restore (fetch content for a path).
- Rename-aware history expands aliases backward — walking from newest to oldest manifests.
- Restore writes atomically (`writeAtomic`) and post-verifies the SHA-256; mismatch throws `IntegrityError('RESTORE_HASH_MISMATCH')` and does NOT auto-revert.
- `MarkdownRenderer.render()` is the ONLY preview path (rules out XSS).

**Dependencies**: Phase 2 (Hasher), Phase 3 (DropboxClient), Phase 4 (VaultAdapter), Phase 5 (ManifestBuilder for manifest type).

---

## Tasks

Produces the feature users actually care about — getting an earlier version of a file back.

- [ ] **T8.1 materializeVaultStateAt (manifest chain merge)** `[activity: domain-modeling]`

  1. Prime: Read `[ref: SDD/Implementation Examples/Restore Merge Walkthrough]`.
  2. Test:
     - The 4-snapshot walkthrough in the SDD reproduces exactly: `{ A.md=h4, C-renamed.md=h6, D.md=h5 }`.
     - A chain that terminates in an Inc (no reachable Full) throws `IntegrityError('CHAIN_BROKEN')`.
     - Rename applied to a path not in state is silently skipped (idempotent).
     - Rename whose target already exists in state is skipped with a warning (resilience).
     - Explicit deletes tombstone correctly; the parent's entry for that path is gone from the merged state.
  3. Implement: Create `src/services/RestoreService.ts` with `materializeVaultStateAt(snapshotId): Promise<Record<path, FileEntry>>`. Pure logic over `SnapshotManifest` objects; fetches manifests via `DropboxClient.downloadJson`.
  4. Validate: Unit tests with fixture chains (the SDD walkthrough + 5 edge-case chains).
  5. Success: Restore correctness against SDD example `[ref: SDD/Implementation Examples]`; chain-break surfaced cleanly `[ref: SDD/Error Handling]`.

- [ ] **T8.2 listVersionsForPath (rename-aware history)** `[activity: domain-modeling]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Runtime View/Complex Logic/Algorithm 3]`.
  2. Test:
     - Given a path that existed under two prior names, the returned versions include entries under all three names with `priorPath` and `renamedAt` markers populated correctly.
     - A file with only a single version (never changed) returns one entry.
     - A pagination hint in the return shape (or a simple limit parameter) lets the UI load first 50, then more — verify returning only the newest N works.
     - Performance: for a history of 1000 manifests × 10k files, listing versions for a single path completes in < 500 ms on a dev laptop (informational bench).
  3. Implement: Add `listVersionsForPath(currentPath: string, manifests: SnapshotManifest[]): VersionEntry[]` to `RestoreService`. Use the algorithm from the SDD.
  4. Validate: Unit tests with fixture manifests containing renames + edits; a perf smoke test for the 1000-manifest case.
  5. Success: Rename tracking `[ref: PRD/F3 AC-5]`.

- [ ] **T8.3 Restore in place + Restore as copy** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/Runtime View/Primary Flow: File-Level Restore]`, `[ref: PRD/F3 AC-3, AC-4]`.
  2. Test:
     - `restoreInPlace(path, snapshotId)` fetches content; writes atomically; post-hashes; confirms match; returns `{ok: true}`.
     - Post-hash mismatch throws `IntegrityError('RESTORE_HASH_MISMATCH')` and leaves the tmp file cleaned up (no leftover `.archivist-tmp`).
     - `restoreAsCopy(path, snapshotId)` writes `<path>.restored-<ts>.<ext>` next to original.
     - If the original's directory no longer exists, `restoreInPlace` (with user confirmation already obtained upstream) recreates missing directories via `VaultAdapter.mkdirParents` before the atomic write.
     - `copyToClipboard(path, snapshotId)` fetches content and copies it (for text files); for binary files, throws `PathError('BINARY_NOT_TEXT')` with a helpful code.
  3. Implement: Add the three methods to `RestoreService`. Hash verification uses `Hasher.sha256hex` after the write.
  4. Validate: Unit + integration tests; inject write-fail mid-atomic to assert cleanup.
  5. Success: Restore fidelity `[ref: PRD/F3 AC-3]`; restore-to-recreated-dir `[ref: PRD/F4 AC-4]`; hash mismatch surfaces cleanly `[ref: SDD/Acceptance Criteria — RESTORE_HASH_MISMATCH]`.

- [ ] **T8.4 Fetch-content-for-snapshot-path** `[activity: backend-api]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Interface Specifications/Data Storage — content/<hh>/<hash>]`.
  2. Test: `fetchContent(snapshotId, path)` materializes state, looks up the hash for the path (if present), downloads the content blob via `DropboxClient.downloadBytes`, returns `Uint8Array`; throws `PathError('PATH_NOT_IN_SNAPSHOT')` if the path isn't in the materialized state; throws `IntegrityError('CONTENT_HASH_MISMATCH')` if the downloaded bytes don't hash back to the expected hash.
  3. Implement: Add `fetchContent` to `RestoreService`.
  4. Validate: Unit tests cover the three paths (happy, missing, mismatch).
  5. Success: Integrity check on every download `[ref: SDD/Cross-Cutting/Pattern: CAS]`.

- [ ] **T8.5 Standalone Restore CLI (`scripts/restore.mjs`)** `[activity: tooling]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/ADR-19]`, `[ref: SDD/Acceptance Criteria — Standalone Restore CLI]`, `[ref: PRD/S6]`, and the manifest-merge walkthrough `[ref: SDD/Implementation Examples/Restore Merge Walkthrough]`.
  2. Test:
     - Zero-dependency invariant: `scripts/restore.mjs` has no `import` from any npm package; only `node:fs/promises`, `node:path`, `node:crypto`, `node:process`, `node:url`. Verified by a grep-based CI check.
     - `--list-snapshots` on a fixture folder (5 snapshots) prints all 5 with id, type, parent_id, created_at, newest-first.
     - `--at latest --output OUT` reconstructs the vault state at HEAD; every written file's SHA-256 matches the manifest.
     - `--at 2026-04-20T03-00-full` resolves a partial id to the full snapshot id; unknown/ambiguous ids exit non-zero with a clear message.
     - `--at 2026-04-20` resolves to the latest snapshot whose `created_at` is on that date.
     - `--dry-run` prints the would-write list with sizes and hashes; writes nothing; exit 0.
     - `--verify-only` walks the chain, opens every content blob, hashes it; exits 0 if all match, non-zero with a list if any mismatch; writes nothing.
     - Hash mismatch during a real restore: the CLI exits non-zero BEFORE writing the bad file, and all previously-written files in this run are cleaned up (the CLI does atomic-dir: writes to `<output>.tmp` then renames to `<output>` on success, deletes the tmp on failure).
     - A missing HEAD.json with snapshots present: the CLI falls back to the newest-by-created_at snapshot and warns "HEAD missing, using <id>."
     - A broken parent chain: exits non-zero with `CHAIN_BROKEN: cannot reach Full ancestor from <id>`.
     - Cross-platform: the test runs on Ubuntu + macOS in CI (Node 18, 20) and produces identical output.
  3. Implement: Create `scripts/restore.mjs`. Single file, ESM. Module structure inside the file (plain functions): `parseArgs`, `listSnapshots`, `loadManifest`, `resolveSnapshotId`, `materializeState`, `reconstruct`, `verifyBlob`, `main`. Use `crypto.createHash('sha256')` (Node stdlib — not WebCrypto; this is a standalone Node tool where Node-crypto is the idiomatic choice). Write files via `fs.writeFile` with `mkdir -p` for parent directories. Atomic-dir pattern: write to `<output>.tmp` then rename.
  4. Validate: Run the new tests under `tests/cli/` — they spawn `node scripts/restore.mjs` as a subprocess against a fixture folder and assert on stdout + filesystem output. Keep the script under 500 lines.
  5. Success: Zero-dep contract holds `[ref: SDD/ADR-19]`; byte-identical to in-plugin restore (deferred to T12.x integration parity test) `[ref: SDD/Acceptance Criteria — byte-identical]`; all PRD S6 invariants.

- [ ] **T8.6 Phase Validation** `[activity: validate]`

  - Run all Phase 8 tests (in-plugin + CLI). Integration: generate a synthetic 4-week history (with renames + deletes), pick 5 paths, verify `listVersionsForPath` + `fetchContent` + `restoreInPlace` round-trip fidelity. Run the CLI on the same history and compare output to the plugin-produced state. Lint and typecheck pass.
