---
title: "Phase 2: Domain Models & Infrastructure Primitives"
status: pending
version: "1.0"
phase: 2
---

# Phase 2: Domain Models & Infrastructure Primitives

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Building Block View/Interface Specifications/Application Data Models]` — all type shapes.
- `[ref: SDD/Building Block View/Data Storage Changes]` — on-disk layouts.
- `[ref: SDD/Runtime View/Complex Logic/Algorithm 1 — reconcileScan]` — hasher usage.
- `[ref: SDD/Cross-Cutting/System-Wide Patterns/Logging]` — path-redaction policy.
- `[ref: SDD/ADR-10]` — WebCrypto SHA-256.
- `[ref: SDD/ADR-18]` — vault prefix slug.

**Key Decisions**:
- All user-visible strings live in `src/ui/strings.ts` — i18n-ready (V1 English only).
- `Hasher` uses `crypto.subtle.digest('SHA-256', ...)`; no Node crypto.
- `Logger` is an object with `log/warn/error` that redacts paths unless `advanced.diagnostic_logging === true`.
- Errors extend `ArchivistError` with a stable machine-readable `code`; UI maps code → string.

**Dependencies**: Phase 1 (build toolchain, tsconfig).

---

## Tasks

Establishes the type foundation and low-level primitives used by every service. Pure TypeScript with zero Obsidian-API coupling — these modules run in a plain Node test harness.

- [ ] **T2.1 Type models & runtime guards** `[activity: domain-modeling]`

  1. Prime: Read `[ref: SDD/Interface Specifications/Application Data Models]` (all TypeScript interfaces).
  2. Test: Valid manifest/index/queue/settings fixtures round-trip through `JSON.parse(JSON.stringify(x))` and pass guards; invalid fixtures (missing fields, wrong types, bad `schema_version`) are rejected with a useful error including the invalid field path.
  3. Implement: Create `src/model/Manifest.ts`, `src/model/Index.ts`, `src/model/QueueEntry.ts`, `src/model/Settings.ts`, `src/model/Errors.ts`. Each exports the interface(s) and a `isX(value: unknown): value is X` guard plus a `parseX(raw: unknown): X` that throws `ConfigError('SCHEMA_INVALID', ...)` with path detail.
  4. Validate: Unit tests for guards cover the happy path + 5 malformed-input cases per type.
  5. Success: Every subsequent phase has typed contracts `[ref: SDD/Interface Specifications]`; parse errors are actionable `[ref: SDD/Error Handling]`.

- [ ] **T2.2 Hasher (WebCrypto SHA-256)** `[activity: backend-api]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/ADR-10]` and `[ref: SDD/Runtime View/Complex Logic/Algorithm 1]`.
  2. Test: Known test vectors (empty string → `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; `"abc"` → `ba7816bf...`); hashing 2 MB produces the same hash as `shasum -a 256` on the same bytes; rejects non-`Uint8Array`/`ArrayBuffer` inputs with `TypeError`.
  3. Implement: Create `src/infra/Hasher.ts` exporting `sha256hex(bytes: ArrayBuffer | Uint8Array): Promise<string>`. Use `crypto.subtle.digest('SHA-256', buf)` then hex-encode. No fallbacks.
  4. Validate: Unit tests pass on Node test env (Node ≥ 18 has WebCrypto globally); benchmark prints throughput > 200 MB/s on a dev laptop (informational only).
  5. Success: Cross-platform hashing primitive `[ref: SDD/ADR-10]`; throughput within SLO budget `[ref: SDD/Quality Requirements/Performance — reconcile first-run < 30 s]`.

- [ ] **T2.3 Utilities — paths, time, glob, retry** `[activity: backend-api]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/ADR-18 — vault prefix]`, `[ref: SDD/Risks/Implementation Gotchas — case sensitivity]`, `[ref: SDD/Interface Specifications/Data Storage Changes — Dropbox paths]`.
  2. Test:
     - `util/paths.ts`: `contentPath(prefix, hash)` enforces lowercase prefix; `snapshotPath(manifest)` uses ISO with `-` separators; `assertInAppFolder(path)` throws on any path outside `Apps/Archivist/`; `slugifyVaultName('My Vault')` returns `my-vault`.
     - `util/time.ts`: `isoUtc(date)` round-trips; `nextWeeklyFullAt(now, dayOfWeek, hhmm)` returns correct future Date; DST boundary cases (2 AM → 3 AM spring forward) do not double-fire.
     - `util/glob.ts`: `matchAny(['.trash/**', '_templates/**'], path)` returns true/false correctly; `**`, `*`, `?`, `[abc]` character classes supported (minimal implementation — use a tiny library or handwritten).
     - `util/retry.ts`: exponential backoff `1s → 2s → 4s → 8s`, cap `60s`, max 5 tries; honors a user-supplied `retryAfterSeconds` override (429 path); abort signal cancels retries.
  3. Implement: Author the four util modules under `src/util/`.
  4. Validate: Unit tests with fake timers for `time.ts` and `retry.ts`; table-driven tests for `paths.ts` and `glob.ts` (≥ 10 cases each).
  5. Success: Path-prefix guards prevent misconfigured calls from escaping App Folder `[ref: SDD/Implementation Boundaries — Must Not Touch]`; retry wrapper is the single place that implements ADR error policy `[ref: SDD/Error Handling]`.

- [ ] **T2.4 Logger with path-redaction gate** `[activity: backend-api]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/System-Wide Patterns/Logging]` and `[ref: SDD/Risks/Implementation Gotchas]`.
  2. Test: `logger.info('op completed')` emits; `logger.info('read path', { path: 'Secret/Note.md' })` redacts path to `Secret/<redacted>` when diagnostic_logging=false; emits path verbatim when diagnostic_logging=true; errors always include `code`; production build (with `drop: ['console']`) does not output anything (verified via built-bundle smoke test).
  3. Implement: Create `src/infra/Logger.ts` exporting a factory `createLogger(getDiagnosticFlag: () => boolean)`. The logger wraps `console.*` with structured payloads; redacts path-like strings unless diagnostic flag is true; accepts an optional `ArchivistError`-aware shape.
  4. Validate: Unit tests cover redaction on/off; no-op in prod bundle (checked by greping built output for `console.log`).
  5. Success: Privacy gate on logs `[ref: SDD/ADR-7 disclosure]`; no path leakage in support bundles by default `[ref: PRD/Risks — token plaintext]`.

- [ ] **T2.5 User-visible strings module** `[activity: frontend-ui]` `[parallel: true]`

  1. Prime: Read PRD `[ref: PRD/Won't Have W9 — i18n]` and SDD `[ref: SDD/Cross-Cutting/System-Wide Patterns/i18n]`.
  2. Test: `S.RESTORE_CONFIRM_TITLE` etc. are all string literals; no other module uses hard-coded English user-visible text (enforced later by an ESLint rule or a simple grep in CI as a MEDIUM-severity warning).
  3. Implement: Create `src/ui/strings.ts` exporting `S` — a flat object keyed by constant names (UPPER_SNAKE) containing every user-visible English string listed in PRD + SDD. Include the suggested copy from the research brief (confirmation dialogs, empty states, error notices, ribbon labels, OAuth prompts, pre-flight notice, device-takeover copy).
  4. Validate: Unit test checks no string is empty; no duplicate keys; manual review of string list against PRD Feature copy.
  5. Success: V2 localization becomes a string-substitution exercise, not a refactor `[ref: PRD/W9]`.

- [ ] **T2.6 Phase Validation** `[activity: validate]`

  - Run all Phase 2 tests; verify type guards reject every shape we plan to reject; verify Hasher matches `shasum -a 256`; verify `assertInAppFolder` blocks a path outside the App Folder. Lint and typecheck pass.
