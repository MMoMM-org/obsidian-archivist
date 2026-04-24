---
title: "Phase 5: Backup Pipeline & Device Coordination"
status: in_progress
version: "1.0"
phase: 5
---

# Phase 5: Backup Pipeline & Device Coordination

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Runtime View/Primary Flow: Incremental Backup Cycle]`
- `[ref: SDD/Runtime View/Complex Logic/Algorithm 2 — verifyNoConflict]`
- `[ref: SDD/Implementation Examples/Example: Commit Protocol for a New Snapshot]` + the crash-recovery matrix
- `[ref: SDD/Building Block View/Data Storage Changes]` (HEAD.json + gc_lock blocks)
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

- [x] **T5.1 DeviceCoordinator (designated + conflict detection + HEAD validation)** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/Runtime View/Complex Logic/Algorithm 2]` (revised), `[ref: PRD/F5]`, `[ref: SDD/Error Handling — HEAD_INVALID]`.
  2. Test:
     - First call to `getOrCreateDeviceId()` generates a UUIDv4, persists it to `data.json.device.device_id`; subsequent calls return the stable value.
     - `isActiveOwner()` reflects the `data.json.device.designated` toggle.
     - `verifyNoConflict()` reads `HEAD.json` from Dropbox; returns OK if: `head === null` (fresh folder) OR `head.device_id === this.device_id` OR `head.committed_at` older than `recent_window_hours` (default 2h).
     - **HEAD schema validation (SEC-M4):** if HEAD downloads but fails schema validation (unknown `schema_version`, malformed `snapshot_id`/`device_id`, future-dated `committed_at` beyond clock-skew tolerance, unexpected fields) → log `WARN: HEAD_INVALID`, treat as absent, return OK. This prevents a poisoned HEAD (hostile actor with Dropbox-account access, or data corruption) from permanently blocking backups. Explicitly covered: bad JSON, missing fields, future `committed_at`, malformed UUID.
     - Only a valid HEAD where device differs AND is within the recency window throws `ConflictError('DEVICE_CONFLICT')` with the other device's ID + committed_at + clear next-steps.
     - `takeOwnership()` is a pure settings mutation (no Dropbox calls); the next backup uses the new flag.
  3. Implement: Create `src/services/DeviceCoordinator.ts`. Depends on `PluginStore` + `DropboxClient`.
  4. Validate: Unit tests cover all four branches of `verifyNoConflict`; fresh-folder case; takeover sequence.
  5. Success: Multi-device race rules out `[ref: PRD/F5 AC-4, SDD/Acceptance Criteria — DEVICE_CONFLICT]`.

- [x] **T5.2 Snapshot manifest builder** `[activity: domain-modeling]` `[parallel: true]`

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

- [ ] **T5.2a SnapshotIndexStore + MaintenanceScheduler (ADR-20 infrastructure)** `[activity: backend-api]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/ADR-20]`, `[ref: SDD/Building Block View/Data Storage Changes — snapshot_index.json]`, `[ref: SDD/ADR-17 + ROB-002]`.
  2. Test:
     - **SnapshotIndexStore:**
       - `append(entry)` writes the new entry to `snapshot_index.json` via promise-chained `adapter.write` (ordering consistent with EventQueue); updates `last_updated_at`; persists.
       - `read()` returns the current index; returns `null` if the file is missing, throws `CorruptionError('SNAPSHOT_INDEX_INVALID')` on parse failure.
       - `remove(id)` removes the matching entry and persists; no-op if id not present.
       - `rebuild(manifestList)` iterates manifests, reads each to extract metadata, writes a fresh `snapshot_index.json` — used by startup recovery when the index is absent/invalid.
       - Concurrent `append` calls serialize correctly (promise-chain pattern per ROB-003).
     - **MaintenanceScheduler:**
       - `scheduleRetentionIfDue()` posts a retention job that runs asynchronously — NEVER blocks the caller's return to `READY` (ROB-002).
       - Runs retention if `localIndex.last_retention_at > 24h ago`; otherwise no-op.
       - Catches all errors from the retention pass, logs, and does NOT propagate — a failed pass retries at the next due time.
       - Exposes a `MAINTENANCE` state event that `RibbonIcon` and `SchedulerFSM` can observe to distinguish "backup running" from "maintenance running" in the ribbon tooltip.
       - `onunload` cancels any in-flight maintenance job via `AbortController`.
  3. Implement: Create `src/services/SnapshotIndexStore.ts` and `src/services/MaintenanceScheduler.ts`. Both are referenced by `BackupService.commitSnapshot()` (step 4 + step 7) and consumed by `RetentionService` + `GCService` — closes the Directory Map gap flagged by ROB-015.
  4. Validate: Unit tests for each module; a concurrency test for SnapshotIndexStore write ordering; a scheduler test asserting the backup-caller returns before the retention job completes.
  5. Success: ADR-20 infrastructure exists as a concrete module, not a narrative reference `[ref: SDD/Directory Map]`; retention off the hot path `[ref: ROB-002]`.

- [ ] **T5.3 BackupService — Full pipeline (with double-check + snapshot_index)** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/Runtime View/Primary Flow]`, `[ref: SDD/Implementation Examples/Example: Commit Protocol for a New Snapshot]` (7-step revised), `[ref: SDD/Implementation Examples/Example: Commit Protocol for a New Snapshot § Crash-recovery matrix]`, `[ref: SDD/ADR-20]`.
  2. Test (end-to-end with mocked DropboxClient + fake Vault):
     - A full backup of a 100-file vault uploads exactly 100 distinct blobs (1 per unique hash; dedup when duplicates exist), writes 1 manifest (`type='full'`), appends one entry to `snapshot_index.json`, writes HEAD.json, and advances `LocalIndex` + queue cursor.
     - Calling full twice in a row on an unchanged vault still produces 2 distinct snapshots (timestamps differ) but uploads 0 new blobs the second time (CAS dedup).
     - **Double-check (ROB-001):** `verifyNoConflict()` is called TWICE — once before blob upload AND once between blob upload and manifest write. If a different device's HEAD appears during blob upload → commit aborts BEFORE manifest is written (orphan blobs remain, cleaned by GC).
     - **Adaptive chunk size (PERF-M2):** upload of a 100 MB file uses 8 MB chunks (default); upload of a 200 MB file uses 150 MB chunks. Verified by counting mocked upload-session API calls.
     - A crash simulated between upload-blobs and write-manifest leaves orphan blobs; next successful backup commits; GC (Phase 6) cleans orphans.
     - A crash between write-manifest and snapshot_index.json update: startup recovery detects inconsistency, rebuilds missing index entries by reading the missing manifests.
     - A crash between snapshot_index.json update and HEAD write: startup recovery sees index has a newer entry than HEAD points at; rewrites HEAD.
  3. Implement: Create `src/services/BackupService.ts` with `runFull()`. Uses `ManifestBuilder`, `SnapshotIndexStore`, `DropboxClient`, `Hasher`, `VaultAdapter`, `DeviceCoordinator`. Parallelism capped by `settings.advanced.upload_parallelism` (default 4); chunk size adaptive: 8 MB if file < 50 MB, 150 MB if ≥ 50 MB.
  4. Validate: End-to-end test with the mocked client exercises the crash points.
  5. Success: Commit protocol crash-safety `[ref: SDD/Acceptance Criteria — crash-recovery]`; dedup working `[ref: PRD/F2 AC-3]`; double-check race fix `[ref: SDD/ADR-20 + ROB-001]`.

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

- [ ] **T5.5 Startup recovery (unified StartupState)** `[activity: backend-api]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Implementation Examples/Example: Commit Protocol for a New Snapshot § Crash-recovery matrix]`, `[ref: SDD/Acceptance Criteria — INDEX_MISSING]`, `[ref: SDD/ADR-20]`.
  2. Test (every row of the crash-recovery matrix gets an explicit test case — TEST-H2):
     - `ArchivistPlugin.startup()` runs in one ordered sequence: load tokens → load settings → load index → load queue → verify HEAD vs. snapshot_index → emit a single `StartupState` enum consumed by the scheduler (ROB-008 unified health-check).
     - If `index.json` is missing or unparseable → `StartupState.INDEX_MISSING`; `localIndex.index_missing_recovery_required = true`; next `run` calls `runFull`.
     - If HEAD.json points at a snapshot_id that is older than the newest manifest in `snapshots/` (crash-recovery row: manifest committed, HEAD stale) → recovery rewrites HEAD to the newest manifest by `created_at`.
     - **Row 7 (manifest committed remotely, local index stale):** startup reconciles local index against the newest manifest referenced by `snapshot_index.json`; re-hashes vault files not already present in `index.files`; ensures the next incremental uploads ONLY the files whose hash has actually changed since the last committed snapshot, NOT every file since last full. Assertion: synthetic fixture — commit a full with file hashes {h1,h2,h3}, simulate local index reset, trigger recovery, run one inc with vault unchanged → zero new blob uploads.
     - If HEAD.json references a snapshot_id that does NOT exist in `snapshots/` (never-committed crash) → rewrites HEAD to the newest existing manifest by `created_at`; logs inconsistency.
     - If `snapshot_index.json` is stale vs. `snapshots/` listing (manifests uploaded but not indexed) → rebuild missing entries by reading the corresponding manifests; persist updated index.
     - If `gc_lock` is present AND its `started_at` is older than `1h + maxClockSkewMinutes` (defined in phase-6 T6.4 / ROB-014) → `StartupState` records a `stale_gc_lock` flag; `MaintenanceScheduler` clears the lock and schedules a new GC pass.
     - If `snapshots/` is empty → HEAD is deleted; state is `StartupState.FRESH_FOLDER`.
  3. Implement: Add `recoverOnStartup()` coordinated via `ArchivistPlugin.startup()`; introduce `model/StartupState.ts` enum.
  4. Validate: Unit tests — one per matrix row + one per StartupState variant.
  5. Success: Crash-recovery matrix fully implemented + testable `[ref: SDD/Implementation Examples/Crash-recovery matrix]`; unified startup state `[ref: ROB-008]`.

- [ ] **T5.6 Phase Validation** `[activity: validate]`

  - Run all Phase 5 tests. Run a simulated multi-cycle flow: fresh Dropbox → full → 5 incs over simulated time → verify final state matches ground truth via `materializeVaultStateAt(HEAD)`. Confirm no SDK types leak. Lint and typecheck pass.
