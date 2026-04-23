---
title: "Phase 6: Retention & Garbage Collection"
status: pending
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
- Retention uses tier matching with the `first-tier-that-matches` rule; never-prune window overrides all tiers.
- Chain integrity is **transitive** (topological walk) — a Full stays alive if any descendant Inc is kept.
- GC uses a Dropbox `gc_lock` marker file; if the lock is already present when GC starts, the pass aborts safely.
- Retention runs after each successful backup, throttled to once per 24h by a `last_retention_at` stamp in `index.json`.

**Dependencies**: Phase 3 (DropboxClient), Phase 4 (PluginStore), Phase 5 (BackupService integration point).

---

## Tasks

Produces the guarantee that Dropbox does not fill up (PRD F2). Two pieces: deciding what to keep (retention), and reclaiming space from orphan blobs (GC).

- [ ] **T6.1 Retention tier evaluator (pure logic)** `[activity: domain-modeling]`

  1. Prime: Read `[ref: SDD/Implementation Examples/Example: Retention Pass with Transitive Chain-Integrity]`, `[ref: PRD/F2 acceptance criteria]`.
  2. Test:
     - Never-prune window includes the snapshot → keep, overrides every other tier.
     - Recent-hours match → keep.
     - Hourly/daily/weekly/monthly: newest-per-bucket is kept; older-within-same-bucket is pruned.
     - Buckets are anchored to wall-clock (local time); daylight-savings transitions do not create zero or 25-hour buckets (fall-back hour is handled by the newest-per-bucket rule).
     - A snapshot that matches no tier is pruned.
     - Config with all tiers disabled (0) except never-prune: only never-prune-window snapshots survive.
     - Table-driven test fixture with 50 synthetic snapshots + exact expected keep-set per retention profile.
  3. Implement: Create `src/services/retention/evaluator.ts` exporting `evaluateTiers(snapshots, settings, now): Set<snapshot_id>` (pure, no I/O).
  4. Validate: Fixture-driven unit tests; property-based tests asserting "never-prune-window subset ⊆ kept set."
  5. Success: Default-retention fixture matches PRD's 35-day target math within ±1 `[ref: PRD/F2 AC-1]`; never-prune override honored `[ref: PRD/F2 AC-2]`.

- [ ] **T6.2 Transitive chain-integrity pass** `[activity: domain-modeling]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Implementation Examples/Example: Retention Pass with Transitive Chain-Integrity]` (second algorithm), `[ref: SDD/ADR-16]`.
  2. Test:
     - Given tier-kept set `{Inc-B}` whose parent chain is `Inc-B → Inc-A → Full-F`, the augmented set is `{Full-F, Inc-A, Inc-B}`.
     - A cycle in parent pointers does not loop forever (visited-set guard).
     - A missing-parent manifest is a chain-break: the orphan referrer is marked `keep` (do not delete) AND an `IntegrityError('CHAIN_BROKEN')` warning is logged — behavior differs from hard failure (retention must degrade gracefully).
     - An orphan Full (no descendants, no direct tier match) is pruned.
  3. Implement: Create `src/services/retention/chainIntegrity.ts` exporting `augmentWithAncestors(tierKept, snapshots): Set<snapshot_id>`.
  4. Validate: Unit tests with fixture graphs (linear, forked, multi-hop, broken).
  5. Success: Transitive rule correctly protects ancestor Fulls `[ref: SDD/ADR-16]`; graceful degradation on broken chains `[ref: SDD/Acceptance Criteria — CHAIN_BROKEN]`.

- [ ] **T6.3 RetentionService — orchestrator** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/ADR-17]`, `[ref: SDD/Runtime View step 12]`.
  2. Test:
     - `maybeRunPass(now)` runs only if `now - last_retention_at >= 24h`; otherwise no-op.
     - Runs: list manifests via `DropboxClient.listFolder('snapshots/')`; parse each; compute tier-keep; augment with chain-integrity; compute prune-set = all_ids \ keep_set; delete each pruned manifest via `DropboxClient.deleteV2`; persist `last_retention_at`.
     - After pruning, triggers `GCService.sweep()` asynchronously (fire-and-forget, logged on failure).
     - Failure to parse one manifest in the middle of the pass does NOT abort — the bad manifest is skipped (logged) and pruning continues over the rest.
  3. Implement: Create `src/services/RetentionService.ts`.
  4. Validate: Unit tests with a mocked DropboxClient containing a known `snapshots/` listing; assert the correct deletions.
  5. Success: Retention cadence + throttling `[ref: SDD/ADR-17]`; prune correctness `[ref: PRD/F2 AC-1]`.

- [ ] **T6.4 GCService — orphan blob sweep with lock** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/ADR-5]`, `[ref: SDD/Risks/Implementation Gotchas — list_folder not snapshot-isolated]`.
  2. Test:
     - `sweep()` writes `gc_lock`, lists all manifests to build the referenced-hashes set, then lists `content/` via `listFolder` (recursive, paginated), then deletes every hash NOT in the referenced set, then removes `gc_lock`.
     - If `gc_lock` already exists AND its mtime is < 1h old → abort (another sweep is in progress or recently crashed).
     - If `gc_lock` exists AND its mtime is ≥ 1h old → treat as stale (previous sweep crashed); remove it and proceed.
     - Ordering: manifests are listed AFTER `content/` listing — a blob uploaded after `content/` listing but before its manifest is written will NOT be in our referenced-set but WILL be in our content-list, BUT the order reversal above means we list content FIRST, then manifests SECOND — so a newly-added blob is in our referenced set even if it wasn't in the content listing (safer direction).

        **Ordering rule (critical):** list `content/` FIRST, then manifests SECOND. If a blob is in content-list but not in manifests → candidate for deletion; but if that blob just got uploaded, it will still be added to a manifest shortly — so we apply an **age gate**: a content blob whose Dropbox `server_modified` is newer than the start of the current sweep is skipped (we leave it for next pass).
     - A full sweep on a synthetic 5k-blob content tree where 4k are referenced deletes exactly 1k blobs.
  3. Implement: Create `src/services/GCService.ts` implementing the lock + ordering + age-gate.
  4. Validate: Unit tests with a mocked DropboxClient; race-condition tests (new-blob-during-sweep must NOT be deleted).
  5. Success: GC concurrency safety `[ref: SDD/ADR-5]`; no false-orphan deletion `[ref: SDD/Risks/Implementation Gotchas]`.

- [ ] **T6.5 Storage-usage probe (for hard-limit warning)** `[activity: backend-api]` `[parallel: true]`

  1. Prime: Read `[ref: PRD/F2 AC-5]`, `[ref: SDD/Acceptance Criteria — storage_warn]`.
  2. Test: `estimateArchivistUsageBytes()` walks the App Folder (via `listFolder` recursive) summing `entries[].size`; caches the result for 15 minutes; returns a number; estimation completes within 5s for the 4-week soak fixture.
  3. Implement: Add `estimateUsage()` to `RetentionService` (or a small `StorageProbe` module). Results are surfaced to `SettingsTab` (Phase 10) and `RibbonIcon` (Phase 7).
  4. Validate: Unit tests with mocked listings; 80% / 100% of configured limit trigger the expected banner state.
  5. Success: Hard-limit warning `[ref: PRD/F2 AC-5, SDD/Acceptance Criteria — storage_warn]`.

- [ ] **T6.6 Phase Validation** `[activity: validate]`

  - Run all Phase 6 tests. 35-day synthetic soak: generate 35 days of snapshots at realistic cadence, apply default retention, assert the kept count matches the PRD-derived expectation within ±1, assert no chain breaks, assert total referenced blobs ≤ vault_size × max_versions. Lint and typecheck pass.
