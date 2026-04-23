---
title: "Phase 12: Integration, Soak Tests & Release Readiness"
status: pending
version: "1.0"
phase: 12
---

# Phase 12: Integration, Soak Tests & Release Readiness

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
- `Archivist` is submitted to the Obsidian Community Plugin directory AFTER all Phase-12 checks pass.

**Dependencies**: Phases 1–11.

---

## Tasks

Produces the evidence that the plugin is ready for public release: integration test coverage, soak-test validation, documentation, and a clean community-submission checklist.

- [ ] **T12.1 End-to-end integration scenarios (mocked Dropbox)** `[activity: integration]`

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
  3. Implement: Create `tests/integration/*.test.ts` using a shared harness: in-memory `VaultAdapter`, mocked `DropboxClient` with deterministic clock. One new helper `createArchivistFixture()` boots a headless plugin with a given scenario config.
  4. Validate: All scenarios pass in < 60 s total.
  5. Success: Every PRD acceptance criterion covered by at least one scenario `[ref: PRD/Feature Requirements]`.

- [ ] **T12.2 4-week soak test (simulated time)** `[activity: testing]`

  1. Prime: Read `[ref: PRD/F2 AC-1]`, `[ref: SDD/Quality Requirements/Reliability]`.
  2. Test:
     - `tests/soak/four-weeks.test.ts` simulates 28 days at fast-forward speed:
       - Vault: 10k files, ~2 GB.
       - Edit pattern: 5 random files modified per day; 1 file renamed per week.
       - Default retention settings.
     - Asserts: final storage usage < 100 GB; retained snapshot count matches expected formula within ±1; GC completed at least 3 passes; no integrity errors thrown.
     - Runs in CI nightly (separate job from default PR check).
  3. Implement: Create the soak-test file + supporting generator. Configure a nightly GitHub Action.
  4. Validate: Test runs clean in < 5 minutes (fast-forward time multiplier).
  5. Success: Storage ceiling demonstrated `[ref: PRD/F2 AC-1, Success Metrics]`.

- [ ] **T12.3 Live-Dropbox smoke test (gated CI job)** `[activity: integration]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Deployment View]`.
  2. Test:
     - `tests/live/smoke.test.ts` — requires secrets `DROPBOX_TEST_CLIENT_ID`, `DROPBOX_TEST_REFRESH_TOKEN`; uses a dedicated test Dropbox account.
     - Scenarios: fresh App Folder → upload 10 blobs → download 10 blobs → hash-match → delete → confirm empty.
     - Tests invariant properties: Retry-After honored; pagination works; 401 triggers refresh.
     - CI job runs only on `main` merges AND on PRs with the `live-test` label.
  3. Implement: Add the test file + GHA workflow `.github/workflows/live-dropbox.yml`.
  4. Validate: A single successful run against the test account.
  5. Success: SDK contract holds against real Dropbox `[ref: SDD/Risks — Dropbox API changes]`.

- [ ] **T12.4 README + documentation** `[activity: documentation]`

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
  3. Implement: Author `README.md` at repo root. Add per-version `CHANGELOG.md`. Add `LICENSE`.
  4. Validate: Manual review against the community-plugin checklist; link-check script (if any docs).
  5. Success: Submission-ready documentation `[ref: SDD/Deployment View/Distribution]`.

- [ ] **T12.5 Supply-chain & release gates** `[activity: tooling]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/ADR-14]`.
  2. Test:
     - `package-lock.json` committed; CI fails if lockfile drifts.
     - Dependabot config at `.github/dependabot.yml` — weekly, npm ecosystem, auto-merge patch-only after CI green.
     - `npm audit` required step in PR CI; fails on high/critical; documented override protocol in README for when a CVE has no upgrade path.
     - Pre-release script: `scripts/release.sh` runs `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm audit`, `npm run build`, outputs `dist/` with `main.js`, `manifest.json`, `styles.css`.
     - Built `main.js` is ≤ 1 MB; `styles.css` uses only CSS vars (CI grep check).
     - GPG-signed git tags for each release.
  3. Implement: Commit lockfile; create Dependabot config; author `scripts/release.sh`; add CI checks + final build size gate.
  4. Validate: Dry-run release produces artifacts; CI gates trigger on deliberate violations.
  5. Success: Supply-chain posture `[ref: SDD/ADR-14]`.

- [ ] **T12.6 Obsidian Community Plugin submission** `[activity: tooling]`

  1. Prime: Read the Obsidian plugin submission guidelines linked in the SDD.
  2. Test (manual checklist):
     - `manifest.json` has all required fields + accurate `minAppVersion`.
     - `versions.json` matches version-to-minAppVersion map.
     - Repository tagged with the current version; a GitHub Release exists with `main.js`, `manifest.json`, `styles.css` as assets.
     - PR opened against `obsidianmd/obsidian-releases` adding Archivist to `community-plugins.json`.
     - Pre-submission audit: no `eval`, no `innerHTML` on user content (grep built `main.js`), no undeclared network hosts, `isDesktopOnly: false` honored.
  3. Implement: Prepare the submission PR. Wait for review feedback. Address review comments.
  4. Validate: Submission PR accepted.
  5. Success: Plugin listed in Community Plugins `[ref: PRD/Success Metrics — adoption]`.

- [ ] **T12.7 Phase Validation & Release** `[activity: validate]`

  - Run every integration test + the 4-week soak + the live smoke. Verify every PRD acceptance criterion has a corresponding passing test. Verify README + submission-checklist. Cut `v0.1.0` tag. Publish GitHub Release. Open Community Plugin submission PR.
