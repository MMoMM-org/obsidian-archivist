---
title: "Phase 4: Change Detection & Event Queue"
status: pending
version: "1.0"
phase: 4
---

# Phase 4: Change Detection & Event Queue

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Runtime View/Complex Logic/Algorithm 1 — reconcileScan]`
- `[ref: SDD/Building Block View/Data Storage Changes — index.json, pending_changes.json]`
- `[ref: SDD/Cross-Cutting/System-Wide Patterns/Security — MarkdownRenderer]` (for preview, not here)
- `[ref: SDD/Risks/Implementation Gotchas — layout-not-ready, folder-rename cascade]`
- `[ref: SDD/ADR-2, ADR-11]`

**Key Decisions**:
- `VaultAdapter` is the ONLY place `app.vault`/`app.vault.adapter` is touched; enables deterministic tests.
- `PluginStore` persists `data.json` (Obsidian-managed, Obsidian-Sync-eligible) and `index.json` + `pending_changes.json` (via `app.vault.adapter.write` directly — OUTSIDE Obsidian-Sync).
- `ChangeDetector` consumes Obsidian vault events only after `workspace.onLayoutReady` fires.
- Reconcile scan yields to the event loop every 500 files; SHA-256 is the authoritative change signal (mtime/size is a dirty-bit hint).
- Exclusion globs apply at queue-entry time; deleting a file already in history doesn't retroactively remove it from past manifests.

**Dependencies**: Phase 1 (build), Phase 2 (types, Hasher, glob, Logger).

---

## Tasks

Produces the eyes-and-ears of the plugin — everything that turns vault edits into a ready-to-snapshot set.

- [ ] **T4.1 VaultAdapter (Obsidian Vault API wrapper, typed-overload events)** `[activity: backend-api]`

  1. Prime: Read Obsidian Vault / TFile / TAbstractFile interfaces; `[ref: SDD/Risks/Implementation Gotchas]`.
  2. Test: `getFiles()` returns `TFile[]` mapped to a simple `{path, mtime, size}` shape; `readBytes(path)` returns `Uint8Array`; `writeAtomic(path, bytes)` writes to `<path>.archivist-tmp` then renames and leaves no temp file on success; `writeAtomic` crashes mid-write leaves the original file untouched (verified by aborting between write and rename); folder-rename event produces a single `rename(newFolderPath, oldFolderPath)` event and does NOT re-enqueue N descendants (dedup responsibility is here, not ChangeDetector).
     - **Typed event overloads (ROB-007):** expose `onVaultCreate(handler: (file: TAbstractFile) => void)`, `onVaultModify(handler: (file: TAbstractFile) => void)`, `onVaultDelete(handler: (file: TAbstractFile) => void)`, `onVaultRename(handler: (file: TAbstractFile, oldPath: string) => void)` — four separate methods, one per event, with TypeScript-strict signatures matching Obsidian's. Attempting to register a rename handler with the wrong arity fails at compile time. The fake adapter implements the same four overloads.
  3. Implement: Create `src/infra/VaultAdapter.ts` wrapping `this.app.vault` and `this.app.vault.adapter`. Expose the small surface above plus `stat(path)`, `exists(path)`, `mkdirParents(path)` (for restore-creates-directory). All event registrations go through `this.plugin.registerEvent` for auto-cleanup.
  4. Validate: Unit tests with an in-memory fake `Vault` adapter (no real Obsidian); file-operation contracts asserted; atomic-write aborts leave no residue; compile-time type tests assert the event signatures.
  5. Success: Every later test can swap `VaultAdapter` for a fake `[ref: SDD/Directory Map]`; atomic-write precondition for restore `[ref: SDD/Acceptance Criteria — restore integrity]`; event-arity safety `[ref: ROB-007]`.

- [ ] **T4.2 PluginStore (data.json + index.json + pending_changes.json persistence)** `[activity: data-architecture]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Building Block View/Data Storage Changes]` and `[ref: SDD/ADR-11]`.
  2. Test:
     - `loadSettings/saveSettings` uses plugin `loadData/saveData` (Obsidian-managed).
     - `loadIndex/saveIndex` writes to `<vault>/.obsidian/plugins/obsidian-archivist/index.json` directly via `app.vault.adapter.write` — NOT inside `data.json`.
     - `loadQueue/saveQueue` same treatment for `pending_changes.json`.
     - Corruption of `index.json` (invalid JSON) causes `loadIndex` to return `null` and logs a warning — the caller enters `INDEX_MISSING` recovery.
     - Schema-version mismatch on load (`data.json` written by a future plugin version) throws `ConfigError('SCHEMA_INCOMPATIBLE')`.
     - Default settings match the PRD 3-tier defaults: `{never_prune_window_days: 14, recent_hours: 24, daily_days: 30, monthly_years: 3, storage_hard_limit_gb: 200, storage_warn_at_percent: 80}` for retention; `{inc_interval_minutes: 15, full_cadence: 'weekly', full_day_of_week: 0, full_time_of_day: '03:00'}` for schedule. NO `hourly_days` or `weekly_months` fields — those tiers were removed in the 3-tier MVP scope cut.
  3. Implement: Create `src/infra/PluginStore.ts` exporting `PluginStore` class with typed accessors. Use type guards from Phase 2 for every load.
  4. Validate: Unit tests with a fake adapter cover each load/save round-trip and corruption path.
  5. Success: Settings defaults match PRD `[ref: PRD/F2 default retention]`; `index.json` not synced by Obsidian Sync `[ref: SDD/ADR-11]`; `INDEX_MISSING` recovery handoff preserved `[ref: SDD/Acceptance Criteria — edge case]`.

- [ ] **T4.3 EventQueue (append-only + committed_through cursor, promise-chained writes)** `[activity: backend-api]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Building Block View/Data Storage — pending_changes.json]`, `[ref: SDD/Runtime View — commit protocol step 6]`.
  2. Test: `enqueue(entry)` appends and persists; `peekSince(cursor)` returns entries whose `observed_at > cursor`; `advanceCursor(ts)` sets `committed_through = ts` and persists; queue survives a simulated crash between enqueue and advance (reloaded queue still has unprocessed entries).
     - **Promise-chain file-write serialization (ROB-003):** all `PluginStore.writeX` calls route through a single `writeQueue: Promise<void>` in `PluginStore` (`this.writeQueue = this.writeQueue.then(() => adapter.write(path, data))`). This guarantees file-level ordering across the async boundary; an in-memory mutex is insufficient because `adapter.write` yields between the logical lock and the physical flush. Test: concurrently invoke 10 `enqueue` + 10 `advanceCursor` via `Promise.all` on fake-timers; assert the final on-disk file is consistent and every enqueued entry appears exactly once.
     - Entries with the same `(path, type)` within a 1-second window are deduped (mitigates folder-rename cascade and rapid-save loops).
  3. Implement: Create `src/infra/EventQueue.ts`. Backed by `PluginStore` for persistence (which owns the write-queue serialization primitive). In-memory cache flushed on every mutation.
  4. Validate: Unit tests with fake timers verify dedup, persistence, cursor semantics, concurrent-write consistency; a crash-between-enqueue-and-commit test proves no lost entries.
  5. Success: Queue crash-safety contract holds `[ref: SDD/Runtime View/Commit protocol recovery matrix]`; cursor advances exactly once per committed snapshot; file-write ordering correct under concurrent callers `[ref: ROB-003]`.

- [ ] **T4.4 ChangeDetector (events + reconcile scan)** `[activity: backend-api]`

  1. Prime: Read `[ref: SDD/Runtime View/Complex Logic/Algorithm 1]`, `[ref: SDD/ADR-2]`, `[ref: PRD/F6 acceptance criteria]`.
  2. Test:
     - On vault `create`/`modify`/`delete`/`rename` events, entries are enqueued (after `onLayoutReady`).
     - Before `onLayoutReady`, events are ignored (initial indexing noise).
     - `reconcileScan()` on a fake vault with 10k files finds 0 changes when index matches (warm path); finds 1 change when one file's hash differs; yields to the event loop every 500 files (verified by counting `setTimeout(0)` calls).
     - A file modified by an external process with new mtime but unchanged content is NOT added (hash comparison overrides mtime hint).
     - A file listed in `exclusion_globs` is never enqueued.
     - Deleted files (in `index.files` but not in `getFiles()`) are recorded as `delete` entries.
     - **Intra-file yield (PERF-H2):** given a single 50 MB file in the vault and the reconcile loop reading + hashing it, the function yields to the event loop at least ⌈50 MB / 10 MB⌉ = 5 times during processing of that file (verified by counting `setTimeout(0)` invocations). This guards against a single large-file hash freezing the progress UI. The yield rule is "every 500 files OR every 10 MB processed, whichever comes first."
  3. Implement: Create `src/services/ChangeDetector.ts` wiring vault events into the queue via `VaultAdapter.on`. Expose `async reconcileScan(index: LocalIndex, exclusions: string[]): Promise<QueueEntry[]>`. Use `Hasher` to confirm suspected changes.
  4. Validate: Unit tests with a fake vault that simulates the sync-tool, external-edit, folder-rename, and exclusion scenarios.
  5. Success: External-sync robustness acceptance criterion `[ref: PRD/F6]`; hash-as-authority `[ref: SDD/Acceptance Criteria — Main Flow F6]`.

- [ ] **T4.5 Phase Validation** `[activity: validate]`

  - Run all Phase 4 tests. Verify `ChangeDetector` produces the same result set whether events flowed normally or the reconcile ran first. Verify `INDEX_MISSING` triggers on corrupted `index.json`. Lint and typecheck pass.
