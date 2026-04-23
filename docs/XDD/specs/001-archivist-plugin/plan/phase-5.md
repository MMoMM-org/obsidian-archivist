---
title: "Phase 5: Backup Pipeline & Device Coordination"
status: pending
version: "1.0"
phase: 5
---

# Phase 5: Backup Pipeline & Device Coordination

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Runtime View/Primary Flow: Incremental Backup Cycle]`
- `[ref: SDD/Runtime View/Complex Logic/Algorithm 2 — verifyNoConflict]`
- `[ref: SDD/Implementation Examples/Example: Commit Protocol]` + the crash-recovery matrix
- `[ref: SDD/Building Block View/Interface Specifications — HEAD.json, gc_lock]`
- `[ref: SDD/ADR-3, ADR-4, ADR-5, ADR-6, ADR-18]`
- `[ref: PRD/F1, F5, F6]`

**Key Decisions**:
- Commit protocol order is non-negotiable: blobs → manifest → HEAD → (local index + queue cursor).
- Rename events are recorded as first-class `renames[]` entries in every Inc manifest.
- `DeviceCoordinator` runs conflict check on EVERY backup start (not just startup).
- Uploads are idempotent (`mode: 'overwrite'` on content-hash paths); no pre-check round-trip needed before upload.

**Dependencies**: Phase 2 (models, hasher, utils), Phase 3 (DropboxClient), Phase 4 (ChangeDetector, PluginStore, VaultAdapter).

---

## Tasks

Produces the core value of the plugin: a crash-safe backup writer. Every other feature (retention, restore, scheduler) depends on this working.

- [ ] **T5.1 DeviceCoordinator (designated + conflict detection)** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/Runtime View/Complex Logic/Algorithm 2]`, `[ref: PRD/F5]`.
  2. Test:
     - First call to `getOrCreateDeviceId()` generates a UUIDv4, persists it to `data.json.device.device_id`; subsequent calls return the stable value.
     - `isActiveOwner()` reflects the `data.json.device.designated` toggle.
     - `verifyNoConflict()` reads `HEAD.json` from Dropbox; if `head === null` returns OK (fresh folder); if `head.device_id === this.device_id` returns OK; if `head.committed_at` is older than `recent_window_hours` (default 2h) returns OK; otherwise throws `IntegrityError('DEVICE_CONFLICT')` with a helpful message including the other device's ID and committed_at.
     - `takeOwnership()` is a pure settings mutation (no Dropbox calls); the next backup uses the new flag.
  3. Implement: Create `src/services/DeviceCoordinator.ts`. Depends on `PluginStore` + `DropboxClient`.
  4. Validate: Unit tests cover all four branches of `verifyNoConflict`; fresh-folder case; takeover sequence.
  5. Success: Multi-device race rules out `[ref: PRD/F5 AC-4, SDD/Acceptance Criteria — DEVICE_CONFLICT]`.

- [ ] **T5.2 Snapshot manifest builder** `[activity: domain-modeling]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Interface Specifications/Application Data Models — SnapshotManifest]`, `[ref: SDD/ADR-4]`.
  2. Test:
     - `buildFullManifest(vaultFiles, hashes, vaultName, prefix, deviceId)` produces a manifest with `type='full'`, `parent_id=null`, `files` covering every input, `deleted=[]`, `renames=[]`.
     - `buildIncManifest(parentId, prevIndex, changes, renames, deviceId)` produces `type='inc'`, populates only changed paths in `files`, lists deletions in `deleted`, and carries `renames` verbatim.
     - A change list that includes both a rename and a content modification to the same file produces one entry under the new path in `files` (not the old path) and the rename entry.
     - `id` is derived from `created_at` in ISO-8601 with filesystem-safe `-` separators (e.g., `2026-04-23T14-00-inc`).
     - `schema_version` is `"1.0"`.
  3. Implement: Create `src/services/ManifestBuilder.ts` exporting the two pure functions above.
  4. Validate: Unit tests with fixtures covering rename+edit, pure rename, pure delete, new-file, and a mix.
  5. Success: Rename-aware manifest shape is correct `[ref: SDD/ADR-4]`; schema stable `[ref: SDD/Data Storage Changes]`.

- [ ] **T5.3 BackupService — Full pipeline** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/Runtime View/Primary Flow]`, `[ref: SDD/Implementation Examples/Example: Commit Protocol]`, `[ref: SDD/Implementation Examples/Crash-Recovery Matrix]`.
  2. Test (end-to-end with mocked DropboxClient + fake Vault):
     - A full backup of a 100-file vault uploads exactly 100 distinct blobs (1 per unique hash; dedup when duplicates exist), writes 1 manifest (`type='full'`), writes HEAD.json, and advances `LocalIndex` + queue cursor.
     - Calling full twice in a row on an unchanged vault still produces 2 distinct snapshots (timestamps differ) but uploads 0 new blobs the second time (CAS dedup).
     - A crash simulated between upload-blobs and write-manifest leaves orphan blobs; next successful backup commits; GC (Phase 6) cleans orphans.
     - A crash between write-manifest and write-HEAD leaves HEAD pointing at the previous snapshot; startup recovery (see T5.5) re-writes HEAD.
  3. Implement: Create `src/services/BackupService.ts` with `runFull()`. Uses `ManifestBuilder`, `DropboxClient`, `Hasher`, `VaultAdapter`, `DeviceCoordinator`. Parallelism capped by `settings.advanced.upload_parallelism` (default 4).
  4. Validate: End-to-end test with the mocked client exercises the crash points.
  5. Success: Commit protocol crash-safety `[ref: SDD/Acceptance Criteria — crash-recovery]`; dedup working `[ref: PRD/F2 AC-3]`.

- [ ] **T5.4 BackupService — Incremental pipeline** `[activity: backend-api]`

  1. Prime: Same as T5.3 plus `[ref: SDD/Runtime View/Primary Flow steps 7-11]`.
  2. Test (end-to-end):
     - Given a committed Full + one file modified + one file renamed, `runIncremental()` produces an Inc manifest with 1 path in `files` (the modified path) + 1 entry in `renames` + `parent_id` pointing to the Full.
     - A rename followed by a content edit produces both a `rename` entry AND an entry in `files` under the new path.
     - Explicit file deletions produce entries in `deleted`.
     - The queue cursor advances to the latest-observed `observed_at` among committed entries; entries observed after the cursor stay in the queue.
     - An empty queue short-circuits before calling Dropbox (0 API calls).
     - `verifyNoConflict()` is called before any upload; failure aborts the run cleanly (queue intact).
  3. Implement: Add `runIncremental()` to `BackupService`.
  4. Validate: End-to-end tests with scenarios listed above.
  5. Success: Incremental cadence correctness `[ref: PRD/F1]`; rename history preserved `[ref: PRD/F3, SDD/ADR-4]`.

- [ ] **T5.5 Startup recovery (HEAD + INDEX_MISSING)** `[activity: backend-api]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Implementation Examples/Crash-Recovery Matrix]`, `[ref: SDD/Acceptance Criteria — INDEX_MISSING]`.
  2. Test:
     - If `index.json` is missing or unparseable → force-Full-on-next-backup flag set in `LocalIndex`; next `run` calls `runFull`.
     - If HEAD.json points at a snapshot_id that is older than the newest manifest in `snapshots/` (crash between manifest and HEAD) → recovery rewrites HEAD to the newest manifest by `created_at`.
     - If HEAD.json references a snapshot_id that does NOT exist in `snapshots/` (never-committed) → rewrites HEAD to the newest existing manifest; logs the inconsistency.
     - If `snapshots/` is empty → HEAD is deleted; state is "fresh folder."
  3. Implement: Add `recoverOnStartup()` to `BackupService` (or a small `RecoveryService`).
  4. Validate: Unit tests with mocked Dropbox listings covering each recovery branch.
  5. Success: Crash-recovery matrix fully implemented `[ref: SDD/Implementation Examples/Crash-Recovery Matrix]`.

- [ ] **T5.6 Phase Validation** `[activity: validate]`

  - Run all Phase 5 tests. Run a simulated multi-cycle flow: fresh Dropbox → full → 5 incs over simulated time → verify final state matches ground truth via `materializeVaultStateAt(HEAD)`. Confirm no SDK types leak. Lint and typecheck pass.
