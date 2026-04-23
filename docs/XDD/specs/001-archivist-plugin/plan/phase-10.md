---
title: "Phase 10: Integration, Soak Tests & Release Readiness"
status: pending
version: "1.0"
phase: 10
---

# Phase 10: Integration, Soak Tests & Release Readiness

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Acceptance Criteria]` — every EARS criterion gets at least one test.
- `[ref: SDD/Quality Requirements]` — SLOs + security + reliability targets.
- `[ref: SDD/Deployment View]`
- `[ref: PRD/Success Metrics]`
- `[ref: SDD/ADR-14 — supply chain]`

**Key Decisions**:
- End-to-end scenarios run against a **mocked Dropbox** AND a **live Dropbox test account** (gated behind a CI secret that only runs on `main` merges with a label).
- Soak test runs 4 simulated weeks of activity at fast-forward speed; asserts storage ceiling and retention match.
- README is authored with the exact scopes/hosts disclosure required by the Obsidian community-plugin review.
- `Archivist` is submitted to the Obsidian Community Plugin directory AFTER all Phase-10 checks pass.

**Dependencies**: Phases 1–9.

---

## Tasks

Produces the evidence that the plugin is ready for public release: integration test coverage, soak-test validation, documentation, and a clean community-submission checklist.

- [ ] **T10.1 End-to-end integration scenarios (mocked Dropbox)** `[activity: integration]`

  1. Prime: Read `[ref: SDD/Acceptance Criteria]` and `[ref: PRD/Feature Requirements]` in full.
  2. Test — one integration test file per scenario under `tests/integration/`:
     - `first-run.test.ts`: install → OAuth → first full completes → manifests + HEAD + index all consistent.
     - `incremental-cycle.test.ts`: edit 5 files → wait inc interval → 1 inc committed with exactly 5 paths.
     - `rename-history.test.ts`: edit + rename + edit → File-History shows 3 versions across 2 paths with markers.
     - `restore-in-place.test.ts`: pick an old version → restore → file content matches expected hash.
     - `restore-deleted-dir.test.ts`: restore to a deleted directory → dirs recreated → confirm copy shown.
     - `retention-35d.test.ts`: simulate 35 days → kept count within ±1 of expected → never-prune-window intact.
     - `gc-orphans.test.ts`: create orphan blob → GC sweep → blob deleted → referenced blobs untouched.
     - `device-conflict.test.ts`: two devices both designated → second device attempts backup → aborts with DEVICE_CONFLICT → clear user-visible error.
     - `external-sync.test.ts`: simulate mtime-only change from external sync → reconcile skips re-upload (hash unchanged).
     - `auth-revoked.test.ts`: access revoked → next cycle surfaces AuthLost banner → user reconnects → recovery works.
     - `catch-up-full.test.ts`: simulate plugin offline during scheduled full → startup → catch-up full runs after quiet period.
     - `quota-full.test.ts`: Dropbox returns 507 → backup pauses → persistent banner appears → no infinite retry.
     - `cli-parity.test.ts`: generate a synthetic 4-week history via the plugin's backup pipeline; run the standalone CLI (`scripts/restore.mjs`) on the same local fixture folder; assert byte-for-byte parity between plugin-restored output and CLI-restored output.
        - **Expanded coverage (ROB-011 + TEST-M3):** the fixture GUARANTEES at least one snapshot containing each of: a pure rename, a delete, a rename-then-content-edit, and a rename-to-collision (idempotent path). Parity is asserted for a snapshot of each kind — not just 5 random samples. Shared fixture lives at `tests/fixtures/merge-spec.json` and is consumed by BOTH the plugin's `materializeVaultStateAt` unit tests AND the CLI subprocess tests; any divergence between implementations fails both suites.
        - Assert `--verify-only` exits 0 on a clean fixture and non-zero on a fixture with a deliberately-corrupted blob.
  3. Implement: Create `tests/integration/*.test.ts` using a shared harness: in-memory `VaultAdapter`, mocked `DropboxClient` with deterministic clock. One new helper `createArchivistFixture()` boots a headless plugin with a given scenario config.
  4. Validate: All scenarios pass in < 60 s total.
  5. Success: Every PRD acceptance criterion covered by at least one scenario `[ref: PRD/Feature Requirements]`.

- [ ] **T10.2 4-week soak test (simulated time, extended assertions)** `[activity: testing]`

  1. Prime: Read `[ref: PRD/F2 AC-1]`, `[ref: SDD/Quality Requirements/Reliability]`.
  2. Test:
     - `tests/soak/four-weeks.test.ts` simulates 28 days at fast-forward speed:
       - Vault: 10k files, ~2 GB.
       - Edit pattern: 5 random files modified per day; 1 file renamed per week.
       - Default retention settings (3 tiers).
     - Asserts (TEST-H1 expanded set):
       - final storage usage < 100 GB;
       - retained snapshot count matches expected formula within ±1;
       - GC completed at least 3 passes;
       - **zero `CorruptionError` / `ChainError` / `ConflictError` thrown across the whole run** (every snapshot restorable end-to-end);
       - **chain-integrity invariant: every retained Inc has a reachable Full ancestor in `snapshot_index.json`** (exhaustive check after each retention pass);
       - **GC false-positive count = 0**: every blob deleted by GC had zero references in the final snapshot_index; no referenced blob was ever deleted;
       - **queue cursor monotonicity**: `committed_through` only advances forward — never regresses;
       - `snapshot_index.json` internally consistent (no duplicate ids; `parent_id` references resolve or are null).
     - Runs in CI nightly (separate job from default PR check).
  3. Implement: Create the soak-test file + supporting generator. Configure a nightly GitHub Action.
  4. Validate: Test runs clean in < 5 minutes (fast-forward time multiplier).
  5. Success: Storage ceiling + chain-integrity demonstrated `[ref: PRD/F2 AC-1, Success Metrics]`.

- [ ] **T10.3 Live-Dropbox smoke test (gated CI job)** `[activity: integration]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Deployment View]`.
  2. Test:
     - `tests/live/smoke.test.ts` — requires secrets `DROPBOX_TEST_CLIENT_ID`, `DROPBOX_TEST_REFRESH_TOKEN`; uses a dedicated test Dropbox account.
     - Scenarios: fresh App Folder → upload 10 blobs → download 10 blobs → hash-match → delete → confirm empty.
     - Tests invariant properties: Retry-After honored (with a dedicated mocked-clock test in `tests/integration/` asserting at-least-N-seconds waited, TEST-H3 makes this reproducible); pagination works; 401 triggers refresh.
     - **Pagination boundary (TEST-H3):** in `tests/integration/dropbox-client.pagination.test.ts` (mocked SDK), return `has_more: true` with a continuation cursor on the first page even for 10 blobs; assert `list_folder/continue` is invoked exactly once with the correct cursor; assert the final union is the merge of both pages. This pins the behavior without needing a 2000-entry real fixture.
     - **SDK contract test (TEST-M1):** construct raw SDK error objects with exact shapes (`{ status: 401, error: { '.tag': 'expired_access_token' } }`, `{ status: 429, headers: {'retry-after': '3'} }`, etc.) and assert `classifyError` maps each to the expected `ArchivistError` subclass. Runs in every PR CI (not just live-test).
     - CI job runs only on `main` merges AND on PRs with the `live-test` label.
  3. Implement: Add the test file + GHA workflow `.github/workflows/live-dropbox.yml`; add the pagination + contract tests to the always-on CI suite.
  4. Validate: A single successful run against the test account; pagination + contract tests pass on PR CI.
  5. Success: SDK contract holds against real Dropbox `[ref: SDD/Risks — Dropbox API changes]`; pagination bug cannot escape PR CI `[ref: TEST-H3]`; SDK-shape drift caught by contract test `[ref: TEST-M1]`.

- [ ] **T10.4 README + documentation** `[activity: documentation]`

  1. Prime: Read `[ref: SDD/System-Wide Patterns/Security]`, `[ref: SDD/ADR-7, ADR-9, ADR-14]`, `[ref: research Security — README copy]`.
  2. Test: README covers every section in the community-plugin submission checklist:
     - What the plugin does, who it's for.
     - Screenshots (Backup Browser, File-History modal, Settings).
     - Setup (install → connect Dropbox → designated-device toggle).
     - Dropbox scopes explanation (the exact wording from the Security research brief).
     - Network hosts declared (`api.dropboxapi.com`, `content.dropboxapi.com`, `www.dropbox.com`).
     - Token plaintext disclosure + best practices (don't share `data.json`; consider Dropbox desktop selective-sync exclusion for `Apps/Archivist/`).
     - Predecessor plugin migration notes.
     - Troubleshooting (auth lost, quota exceeded, device conflict).
     - Release notes linking to each version's changelog.
     - License (MIT recommended).
     - Contact / issue tracker link.
     - **Standalone Restore CLI section**: explains `scripts/restore.mjs`, its zero-dep property, and the recovery-without-plugin use case. Includes invocation examples and a worked example (`node scripts/restore.mjs --dropbox-path ~/Dropbox/Apps/Archivist/my-vault --output ./restored --at latest`).
  3. Implement: Author `README.md` at repo root. Add per-version `CHANGELOG.md`. Add `LICENSE`.
  4. Validate: Manual review against the community-plugin checklist; link-check script (if any docs).
  5. Success: Submission-ready documentation `[ref: SDD/Deployment View/Distribution]`.

- [ ] **T10.5 Supply-chain & release gates** `[activity: tooling]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/ADR-14]`.
  2. Test:
     - `package-lock.json` committed; CI fails if lockfile drifts.
     - Dependabot config at `.github/dependabot.yml` — weekly, npm ecosystem, auto-merge patch-only after CI green.
     - `npm audit` required step in PR CI; fails on high/critical; documented override protocol in README for when a CVE has no upgrade path.
     - Pre-release script: `scripts/release.sh` runs `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm audit`, `npm run build`, outputs `dist/` with `main.js`, `manifest.json`, `styles.css`, and a copy of `scripts/restore.mjs` (so the CLI ships on every GitHub Release asset list).
     - Built `main.js` is ≤ 1 MB; `styles.css` uses only CSS vars (CI grep check).
     - GPG-signed git tags for each release.
  3. Implement: Commit lockfile; create Dependabot config; author `scripts/release.sh`; add CI checks + final build size gate.
  4. Validate: Dry-run release produces artifacts; CI gates trigger on deliberate violations.
  5. Success: Supply-chain posture `[ref: SDD/ADR-14]`.

- [ ] **T10.6a Brand assets — icons + logos** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read PRD V1 Prerequisites (app registration confirmed values) and Obsidian community-plugin branding guidance.
  2. Test:
     - `assets/icons/dropbox-app-512.png` exists at 512×512 px, PNG with alpha, ≤ 50 KB; uploaded to the Dropbox developer app page.
     - `src/ui/icons/ribbon.svg` exists as a 20×20 viewBox SVG using `currentColor` only (no hard-coded colors) — verified by grep + manual theme-switch check in a test vault (light mode + dark mode + one popular community theme).
     - (Optional) `assets/icons/plugin-logo-256.png` at 256×256 for the community-plugin listing card.
     - Icons documented in README with attribution if anything derived is used; otherwise "original work, MIT" noted in `assets/README.md`.
  3. Implement: Commission or author the icons. The design direction: simple, monochrome-friendly (theme-respecting for the ribbon SVG), readable at 16×16 (smallest effective display size for ribbon icons). Candidate motif: a scroll/archive/file-with-clock or a folder with a backward-arrow — whatever communicates "version history of a vault." Iterate with sketches before committing final PNG.
  4. Validate: Upload to the Dropbox app page and confirm it displays correctly on the OAuth consent screen (real test, not just local).
  5. Success: Branding ready for community submission `[ref: PRD/V1 Prerequisites]`.

- [ ] **T10.6 Obsidian Community Plugin submission** `[activity: tooling]`

  1. Prime: Read the Obsidian plugin submission guidelines linked in the SDD.
  2. Test (manual checklist):
     - `manifest.json` has all required fields + accurate `minAppVersion`.
     - `versions.json` matches version-to-minAppVersion map.
     - Repository tagged with the current version; a GitHub Release exists with `main.js`, `manifest.json`, `styles.css` as assets.
     - PR opened against `obsidianmd/obsidian-releases` adding Archivist to `community-plugins.json`.
     - Pre-submission audit: no `eval`, no `innerHTML` on user content (grep built `main.js`), no undeclared network hosts, `isDesktopOnly: true` matches manifest.
  3. Implement: Prepare the submission PR. Wait for review feedback. Address review comments.
  4. Validate: Submission PR accepted.
  5. Success: Plugin listed in Community Plugins `[ref: PRD/Success Metrics — adoption]`.

- [ ] **T10.7 Performance SLO CI gates** `[activity: testing]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Quality Requirements/Performance]`, `[ref: TEST-M4]`.
  2. Test (promote 3 SLOs from aspirational to CI-gated regression tests):
     - **Warm reconcile SLO:** `tests/perf/reconcile-warm.test.ts` runs reconcileScan on a fake vault with 10k files (index pre-populated, zero actual changes); assert completion in < 1.5 s (median of 10 runs). Fail the build if exceeded.
     - **Idle tick SLO:** `tests/perf/idle-tick.test.ts` runs `SchedulerFSM.tick()` with an empty queue 1000 times; assert p99 < 5 ms. Fail the build if exceeded.
     - **Restore end-to-end SLO (mocked Dropbox 100 ms RTT):** `tests/perf/restore-e2e.test.ts` restores a 5-day-old file through `RestoreService.restoreInPlace` with manifest cache warm; assert total time < 30 s. Fail the build if exceeded.
  3. Implement: Use a tight, deterministic synthetic vault + mocked clock/network. Keep runtime budget per test < 10 s so the SLO suite runs on every PR.
  4. Validate: Intentional regression (add a 500 ms sleep in reconcile) triggers build failure.
  5. Success: Three load-bearing SLOs now block regressions `[ref: TEST-M4, SDD/Quality Requirements]`.

- [ ] **T10.8 Phase Validation & Release** `[activity: validate]`

  - Run every integration test + the 4-week soak + the live smoke + the SLO CI gates. Verify every PRD acceptance criterion has a corresponding passing test. Verify README + submission-checklist. Cut `v0.1.0` tag. Publish GitHub Release. Open Community Plugin submission PR.
