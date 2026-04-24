---
title: "Phase 6: Retention & Garbage Collection"
status: in_progress
version: "1.0"
phase: 6
---

# Phase 6: Retention & Garbage Collection

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Implementation Examples/Example: Retention Pass with Transitive Chain-Integrity]`
- `[ref: SDD/Runtime View/Primary Flow step 12]`
- `[ref: SDD/ADR-5, ADR-16, ADR-17]`
- `[ref: PRD/F2]`

**Key Decisions**:
- Retention operates on `snapshot_index.json` (ADR-20) — **metadata-only**, no per-manifest download. Uses tier matching with the `first-tier-that-matches` rule; never-prune window overrides all tiers.
- Chain integrity is **transitive** (topological walk) — a Full stays alive if any descendant Inc is kept. Cycle-guard via visited-set is a formal post-condition of the evaluator.
- V1 MVP retention: **3 tiers** (never-prune + daily + monthly). Hourly/weekly dropped during scope review; may return post-V1.
- GC uses a Dropbox `gc_lock` JSON marker file containing `started_at` (client-clock) and `device_id`; staleness check compares `started_at` (not server mtime) against current wall-clock to avoid Dropbox server-clock skew (ROB-014).
- **GC ordering corrected (ROB-012):** list `snapshot_index.json` (or rebuild from manifests listing if index is stale) FIRST to build the referenced-hash set; THEN list `content/` to find candidates. Age-gate (skip blobs newer than GC-start-time) provides an additional safety margin against concurrent commits.
- Retention runs **asynchronously off the backup hot path** (ROB-002) via `MaintenanceScheduler`, throttled to once per 24h via `LocalIndex.last_retention_at`.

**Dependencies**: Phase 3 (DropboxClient), Phase 4 (PluginStore), Phase 5 (BackupService integration point).

---

## Tasks

Produces the guarantee that Dropbox does not fill up (PRD F2). Two pieces: deciding what to keep (retention), and reclaiming space from orphan blobs (GC).

- [x] **T6.1 Retention tier evaluator (pure logic)** `[activity: domain-modeling]`

  1. Prime: Read `[ref: SDD/Implementation Examples/Example: Retention Pass with Transitive Chain-Integrity]`, `[ref: PRD/F2 acceptance criteria]`.
  2. Test:
     - Never-prune window includes the snapshot → keep, overrides every other tier.
     - Recent-hours window (inside never-prune) match → keep.
     - Daily/monthly: newest-per-bucket is kept; older-within-same-bucket is pruned.
     - Buckets are anchored to wall-clock (local time); daylight-savings transitions do not create zero or 25-hour buckets (fall-back hour is handled by the newest-per-bucket rule).
     - A snapshot that matches no tier is pruned.
     - Config with all tiers disabled (0) except never-prune: only never-prune-window snapshots survive.
     - Table-driven test fixture with 50 synthetic snapshots + exact expected keep-set per retention profile (3-tier defaults).
     - Property tests (TEST/M-2 additions): (a) **monotonicity** — adding an older snapshot to the input set never removes a previously-kept snapshot from the output; (b) **idempotency** — running the evaluator twice with the same input produces identical output; (c) **orphan Full** — a Full with no kept Inc descendants and no tier match is pruned (not protected by the chain-integrity pass).
  3. Implement: Create `src/services/retention/evaluator.ts` exporting `evaluateTiers(snapshots, settings, now): Set<snapshot_id>` (pure, no I/O).
  4. Validate: Fixture-driven unit tests; property-based tests asserting "never-prune-window subset ⊆ kept set."
  5. Success: Default-retention fixture matches PRD's 35-day target math within ±1 `[ref: PRD/F2 AC-1]`; never-prune override honored `[ref: PRD/F2 AC-2]`.

- [x] **T6.2 Transitive chain-integrity pass** `[activity: domain-modeling]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Implementation Examples/Example: Retention Pass with Transitive Chain-Integrity]` (second algorithm), `[ref: SDD/ADR-16]`.
  2. Test:
     - Given tier-kept set `{Inc-B}` whose parent chain is `Inc-B → Inc-A → Full-F`, the augmented set is `{Full-F, Inc-A, Inc-B}`.
     - **Cycle guard is a formal post-condition (ROB-009).** Feed a three-snapshot cycle (A→B→C→A) into `augmentWithAncestors`; assert the function **terminates** (visited-set prevents infinite loop) and returns a conservative keep-set (the cycle-involved set is treated as chain-broken → kept to preserve data). Document the contract in the function's JSDoc: "must terminate for any input including cycles, self-references, and missing-parent edges."
     - A missing-parent manifest is a chain-break: the orphan referrer is marked `keep` (do not delete) AND a `ChainError('CHAIN_BROKEN')` warning is logged — behavior differs from hard failure (retention must degrade gracefully).
     - An orphan Full (no descendants, no direct tier match) is pruned.
  3. Implement: Create `src/services/retention/chainIntegrity.ts` exporting `augmentWithAncestors(tierKept, snapshots): Set<snapshot_id>`.
  4. Validate: Unit tests with fixture graphs (linear, forked, multi-hop, broken).
  5. Success: Transitive rule correctly protects ancestor Fulls `[ref: SDD/ADR-16]`; graceful degradation on broken chains `[ref: SDD/Acceptance Criteria — CHAIN_BROKEN]`.

- [x] **T6.3 RetentionService — metadata-only orchestrator** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/ADR-17]`, `[ref: SDD/ADR-20]`, `[ref: SDD/Runtime View step 13 — MaintenanceScheduler]`.
  2. Test:
     - `runIfDue(now)` runs only if `now - localIndex.last_retention_at >= 24h`; otherwise no-op.
     - Pass reads **only** `snapshot_index.json` (ADR-20), NOT individual manifest bodies — metadata-only. This is the PERF-C1 fix that makes the 2s SLO achievable.
     - If `snapshot_index.json` is absent or fails schema validation → fallback: list manifests via `DropboxClient.listFolder('snapshots/')`, download each, rebuild the index, persist. One-time cost. Triggers `CorruptionError('SNAPSHOT_INDEX_INVALID')` → logged, not thrown.
     - Computes: tier-keep via `evaluateTiers(index.snapshots, settings, now)`; augment with chain-integrity via `augmentWithAncestors(kept, index.snapshots)`; compute prune-set = `all_ids \ keep_set`; delete each pruned manifest via `DropboxClient.deleteV2('snapshots/<id>.json')`; remove the pruned entry from `snapshot_index.json`; persist `localIndex.last_retention_at`.
     - After pruning, triggers `GCService.sweep()` asynchronously via `MaintenanceScheduler` (ROB-002 — never blocks a backup cycle; failure logs + retries at the next due-time).
     - Failure to delete one pruned manifest mid-pass → continue with the rest; the failed id stays in the index (will be retried next pass).
  3. Implement: Create `src/services/RetentionService.ts`.
  4. Validate: Unit tests with a mocked DropboxClient containing a known `snapshots/` listing; assert the correct deletions.
  5. Success: Retention cadence + throttling `[ref: SDD/ADR-17]`; prune correctness `[ref: PRD/F2 AC-1]`.

- [ ] **T6.4 GCService — orphan blob sweep with lock** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/ADR-5]`, `[ref: SDD/ADR-20]`, `[ref: SDD/Risks/Implementation Gotchas — list_folder not snapshot-isolated]`.
  2. Test:
     - `sweep()` writes `gc_lock` (JSON body: `{schema_version, started_at: ISO-8601 client-clock, device_id}`), reads `snapshot_index.json` to build the referenced-hashes set (union of every entry's `blob_hashes[]`), then lists `content/` via `listFolder` (recursive, paginated), then deletes every hash NOT in the referenced set, then removes `gc_lock`.
     - If `gc_lock` exists AND parsed `started_at` is within the last 1h + `maxClockSkewMinutes` (ROB-014 clock-skew tolerance) → abort (another sweep is in progress).
     - If `gc_lock` exists AND `started_at` is older than that → treat as stale (previous sweep crashed); overwrite it and proceed.
     - If `gc_lock` exists BUT fails schema validation → treat as a corrupted stale lock; log `WARN: GC_LOCK_INVALID`; overwrite it and proceed.

        **Ordering rule (corrected per ROB-012):** read `snapshot_index.json` (or rebuild from manifests) FIRST to build the referenced-hash set; THEN list `content/` to find orphan candidates. This is the only safe order: if a concurrent commit uploads a new blob between our index read and our content listing, the new blob will be in the content listing but absent from our referenced set — caught by the age gate below. If we did it the other way (content first, index second), a concurrent commit uploading a new blob BEFORE the index update is complete would be an untracked orphan with a recent `server_modified` — still age-gated, so safe, but the ordering logic matches the commit protocol (index update comes BEFORE HEAD update, so reading the index first gives us "everything committed to HEAD").

        **Age gate:** a content blob whose Dropbox `server_modified` is within `started_at ± maxClockSkewMinutes` is skipped regardless of reference status — we leave it for the next pass to let the commit protocol finish.
     - A full sweep on a synthetic 5k-blob content tree where 4k are referenced deletes exactly 1k blobs (assuming no ongoing commit).
  3. Implement: Create `src/services/GCService.ts` implementing the lock + ordering + age-gate.
  4. Validate: Unit tests with a mocked DropboxClient; race-condition tests (new-blob-during-sweep must NOT be deleted).
  5. Success: GC concurrency safety `[ref: SDD/ADR-5]`; no false-orphan deletion `[ref: SDD/Risks/Implementation Gotchas]`.

- [x] **T6.5 Storage-usage probe (for hard-limit warning)** `[activity: backend-api]` `[parallel: true]`

  1. Prime: Read `[ref: PRD/F2 AC-5]`, `[ref: SDD/Acceptance Criteria — storage_warn]`.
  2. Test: `estimateArchivistUsageBytes()` walks the App Folder (via `listFolder` recursive) summing `entries[].size`; caches the result for 15 minutes; returns a number; estimation completes within 5s for the 4-week soak fixture.
  3. Implement: Add `estimateUsage()` to `RetentionService` (or a small `StorageProbe` module). Results are surfaced to `SettingsTab` (Phase 10) and `RibbonIcon` (Phase 7).
  4. Validate: Unit tests with mocked listings; 80% / 100% of configured limit trigger the expected banner state.
  5. Success: Hard-limit warning `[ref: PRD/F2 AC-5, SDD/Acceptance Criteria — storage_warn]`.

- [ ] **T6.6 Phase Validation** `[activity: validate]`

  - Run all Phase 6 tests. 35-day synthetic soak: generate 35 days of snapshots at realistic cadence, apply default retention, assert the kept count matches the PRD-derived expectation within ±1, assert no chain breaks, assert total referenced blobs ≤ vault_size × max_versions. Lint and typecheck pass.
