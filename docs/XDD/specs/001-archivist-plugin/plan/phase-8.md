---
title: "Phase 8: Restore Engine & Rename-Aware History"
status: complete
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
- Restore writes atomically (`writeAtomic`) after a pre-write hash compare (SEC-M6); mismatch throws `CorruptionError('RESTORE_HASH_MISMATCH')` and does NOT auto-revert.
- `MarkdownRenderer.render()` is the ONLY preview path (rules out XSS).

**Dependencies**: Phase 2 (Hasher), Phase 3 (DropboxClient), Phase 4 (VaultAdapter), Phase 5 (ManifestBuilder for manifest type).

---

## Tasks

Produces the feature users actually care about — getting an earlier version of a file back.

- [x] **T8.1 materializeVaultStateAt (manifest chain merge)** `[activity: domain-modeling]`

  1. Prime: Read `[ref: SDD/Implementation Examples/Example: Manifest Merge for Restore-at-Time-T]`.
  2. Test:
     - The 4-snapshot walkthrough in the SDD reproduces exactly: `{ A.md=h4, C-renamed.md=h6, D.md=h5 }`.
     - A chain that terminates in an Inc (no reachable Full) throws `ChainError('CHAIN_BROKEN')`.
     - Rename applied to a path not in state is silently skipped (idempotent).
     - Rename whose target already exists in state is skipped with a warning (resilience).
     - Explicit deletes tombstone correctly; the parent's entry for that path is gone from the merged state.
  3. Implement: Create `src/services/RestoreService.ts` with `materializeVaultStateAt(snapshotId): Promise<Record<path, FileEntry>>`. Pure logic over `SnapshotManifest` objects; fetches manifests via `DropboxClient.downloadJson`.
  4. Validate: Unit tests with fixture chains (the SDD walkthrough + 5 edge-case chains).
  5. Success: Restore correctness against SDD example `[ref: SDD/Implementation Examples]`; chain-break surfaced cleanly `[ref: SDD/Error Handling]`.

- [x] **T8.2 listVersionsForPath (rename-aware history, path-reuse safe)** `[activity: domain-modeling]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Runtime View/Complex Logic/Algorithm 3]` (revised for ROB-004).
  2. Test:
     - Given a path that existed under two prior names, the returned versions include entries under all three names with `priorPath` and `renamedAt` markers populated correctly.
     - A file with only a single version (never changed) returns one entry.
     - **Path-reuse test (ROB-004 regression):** S1 has `A.md:h1`; S2 renames `A.md→B.md`; S3 creates a NEW `A.md:h3`. `listVersionsForPath("B.md")` returns ONLY `{A.md@S1:h1, B.md@S2:h2}` — S3's new `A.md` is NOT included because its lifetime starts AFTER the rename-out boundary.
     - Pagination: `limit` parameter returns only the newest N; a `cursor` parameter resumes from the oldest-returned id.
     - Performance: for a history of 1000 manifests × 10k files, listing versions for a single path completes in < 500 ms on a dev laptop once manifests are cached (PERF-C3); first-session cold fetch is covered by the manifest-cache SLO, not this function.
     - **Property-based tests (TEST-H5 mutation-killers):**
       - **alias-completeness:** for any rename chain of length N, the count of versions returned equals the count of distinct content entries across all aliases.
       - **priorPath-renamedAt consistency:** every version where `priorPath !== currentPath` has a non-null `renamedAt`.
       - **idempotency:** running `listVersionsForPath` twice on the same manifests returns equal results.
       - **ordering:** returned versions are strictly newest-first by `created_at`.
  3. Implement: Add `listVersionsForPath(currentPath: string, manifests: SnapshotManifest[]): VersionEntry[]` to `RestoreService`. Use the algorithm from the SDD.
  4. Validate: Unit tests with fixture manifests containing renames + edits; a perf smoke test for the 1000-manifest case.
  5. Success: Rename tracking `[ref: PRD/F3 AC-5]`.

- [x] **T8.3 Restore in place + Restore as copy (pre-write hash + per-path mutex)** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/Runtime View/Primary Flow: File-Level Restore]`, `[ref: PRD/F3 AC-3, AC-4]`, `[ref: SDD/ADR-7 ADR-20]`.
  2. Test:
     - `restoreInPlace(path, snapshotId)` fetches content via `RestoreService.fetchContent` (bytes hash-verified at download time against the manifest hash — `CorruptionError('CONTENT_HASH_MISMATCH')` on mismatch, ZERO disk side-effects); **then pre-hashes the in-memory buffer** (SEC-M6) and compares to `manifest.files[path].hash` — mismatch here throws `CorruptionError('RESTORE_HASH_MISMATCH')` BEFORE any write; then writes atomically; returns `{ok: true}`.
     - Critical: when `RESTORE_HASH_MISMATCH` fires, the following side-effects MUST NOT occur (TEST-C1 assertion battery):
       - `NoticeCenter.showSuccess` is NOT called;
       - `PluginStore` index is NOT updated;
       - No `.archivist-tmp` file remains on disk after the throw (cleaned up in `finally`);
       - `VaultAdapter.writeAtomic` was NEVER called.
     - **Per-path mutex (ROB-010):** concurrent `restoreInPlace` calls for the same `path` — second call throws `PathError('RESTORE_IN_PROGRESS')` and does not touch disk. Verified by scheduling two restores on the same path via `Promise.all`; one succeeds, the other throws; mutex released in `finally` (success or error path).
     - `restoreAsCopy(path, snapshotId)` writes `<path>.restored-<ts>.<ext>` next to original. Same pre-write hash + mutex discipline, keyed on the original path.
     - If the original's directory no longer exists, `restoreInPlace` (with user confirmation already obtained upstream) recreates missing directories via `VaultAdapter.mkdirParents` before the atomic write.
     - `copyToClipboard(path, snapshotId)` fetches content (hash-verified) and copies it (for text files); for binary files, throws `PathError('BINARY_NOT_TEXT')` with a helpful code.
  3. Implement: Add the three methods to `RestoreService`. Hash verification uses `Hasher.sha256hex` after the write.
  4. Validate: Unit + integration tests; inject write-fail mid-atomic to assert cleanup.
  5. Success: Restore fidelity `[ref: PRD/F3 AC-3]`; restore-to-recreated-dir `[ref: PRD/F4 AC-4]`; hash mismatch surfaces cleanly `[ref: SDD/Acceptance Criteria — RESTORE_HASH_MISMATCH]`.

- [x] **T8.4 Fetch-content-for-snapshot-path + manifest cache** `[activity: backend-api]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Interface Specifications/Data Storage — content/<hh>/<hash>]`, `[ref: SDD/ADR-20]`, `[ref: SDD/Runtime View/Primary Flow: File-Level Restore — step 3]`.
  2. Test:
     - `fetchContent(snapshotId, path)` materializes state (via `materializeVaultStateAt`), looks up the hash, downloads via `DropboxClient.downloadBytes`, returns `Uint8Array`; throws `PathError('PATH_NOT_IN_SNAPSHOT')` if the path isn't in state; throws `CorruptionError('CONTENT_HASH_MISMATCH')` if bytes don't hash back.
     - **Manifest cache (PERF-C3):** `RestoreService.ensureManifestCacheLoaded()` called on first use per session downloads `snapshot_index.json` (1 request) and lazy-loads full `snapshots/<id>.json` only when needed for path resolution. Cache is invalidated (and reloaded lazily) when a new `commitSnapshot()` completes locally. Verified by: first `listVersions` call downloads index + needed manifests; second `listVersions` for a different file in the same session makes 0 additional Dropbox calls (fully cached).
     - Cache expiry: a new backup commit triggers `cache.invalidate()`. Verified by: call `listVersions`; commit a new snapshot locally; call `listVersions` again — fresh `snapshot_index.json` download confirmed.
  3. Implement: Add `fetchContent` + `ensureManifestCacheLoaded` + `invalidateCache` to `RestoreService`. Cache is in-memory only (Map-backed), not persisted.
  4. Validate: Unit tests cover the three paths (happy, missing, mismatch) + cache hit/miss.
  5. Success: Integrity check on every download `[ref: SDD/Cross-Cutting/Pattern: CAS]`; Restore SLO achievable via cache `[ref: SDD/ADR-20]`.

- [x] **T8.5 Standalone Restore CLI (`scripts/restore.mjs`)** `[activity: tooling]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/ADR-19]`, `[ref: SDD/Acceptance Criteria — Standalone Restore CLI]`, `[ref: PRD/S6]`, and the manifest-merge walkthrough `[ref: SDD/Implementation Examples/Example: Manifest Merge for Restore-at-Time-T]`.
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
  5. Success: Zero-dep contract holds `[ref: SDD/ADR-19]`; byte-identical to in-plugin restore (verified by Phase 10 T10.1 `cli-parity.test.ts`) `[ref: SDD/Acceptance Criteria — byte-identical]`; all PRD S6 invariants.

- [x] **T8.6 Phase Validation** `[activity: validate]`

  - Run all Phase 8 tests (in-plugin + CLI). Integration: generate a synthetic 4-week history (with renames + deletes), pick 5 paths, verify `listVersionsForPath` + `fetchContent` + `restoreInPlace` round-trip fidelity. Run the CLI on the same history and compare output to the plugin-produced state. Lint and typecheck pass.
