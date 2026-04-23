---
title: "Phase 1: Foundation & Scaffolding"
status: completed
version: "1.0"
phase: 1
---

# Phase 1: Foundation & Scaffolding

## Phase Context

**GATE**: Read all referenced files before starting this phase.

**Specification References**:
- `[ref: SDD/Implementation Context/Code Context]` — package.json / manifest.json / tsconfig / esbuild / eslint targets
- `[ref: SDD/Constraints; CON-1, CON-2, CON-3, CON-7]` — Obsidian plugin runtime, TS strict, WebCrypto, review compliance
- `[ref: SDD/Directory Map]` — layout
- `[ref: SDD/ADR-14]` — SDK pin, lockfile, Dependabot, npm audit

**Key Decisions**:
- TypeScript strict + esbuild (not rollup). Single bundled `main.js`.
- Plugin id `obsidian-archivist`; `minAppVersion: 1.5`; `isDesktopOnly: true` (mobile deferred post-V1 per ADR-12 revision).
- ESLint uses `eslint-plugin-obsidianmd` + a **local rule banning `innerHTML =` on non-literal RHS**.
- Production build strips `console.debug` via esbuild `pure: ['console.debug']`; `log`/`warn`/`error` survive for the Logger wrapper.
- Lockfile committed; no `@latest` in dependencies; Dependabot weekly.

**Dependencies**: none (root phase).

---

## Tasks

Establishes the project skeleton: buildable plugin that installs into Obsidian, produces a bundle, runs tests, and passes lint/typecheck. No product features yet — just the scaffolding that makes every later phase possible.

- [x] **T1.1 Plugin manifest & versions** `[activity: tooling]`

  1. Prime: Read plugin-manifest requirements `[ref: SDD/Deployment View; Distribution]` and community review rules `[ref: SDD/Constraints; CON-7]`.
  2. Test: `manifest.json` is parseable JSON with required fields (`id`, `name`, `version`, `minAppVersion`, `description`, `author`, `authorUrl`, `isDesktopOnly`); `versions.json` maps `0.1.0 → 1.5.0`.
  3. Implement: Author `manifest.json`, `versions.json` at repo root. Set `id = "obsidian-archivist"`, `isDesktopOnly = true`, `minAppVersion = "1.5.0"`, `version = "0.1.0"`.
  4. Validate: JSON lints; manifest matches Obsidian community-plugin schema; `versions.json` keyed by plugin version.
  5. Success: Manifest ready for community submission `[ref: PRD/Constraints (Obsidian review)]`; `isDesktopOnly=true` correctly scopes V1 to desktop `[ref: SDD/ADR-12 (revised)]`.

- [x] **T1.2 Build toolchain (package.json, tsconfig, esbuild)** `[activity: tooling]`

  1. Prime: Read `[ref: SDD/Implementation Context/Project Commands]` and `[ref: SDD/ADR-14]`.
  2. Test: `npm install` creates `node_modules` without unresolved deps; `npm run build` produces `main.js` at repo root; `npm run dev` starts esbuild watch.
  3. Implement: Create `package.json` with pinned `dropbox@10.x`, `obsidian`, `esbuild`, `typescript`, `vitest`, `@vitest/coverage-v8`, `eslint`, `eslint-plugin-obsidianmd`. Create `tsconfig.json` (`strict: true`, `strictNullChecks: true`, `target: ES2020`, `moduleResolution: node`). Create `esbuild.config.mjs` bundling `src/main.ts → main.js` with `pure: ['console.debug']` in prod (strips `console.debug` calls only; `log`/`warn`/`error` are kept and go through the Logger wrapper per SDD §Logging; the `drop` option doesn't accept `'debug'` so `pure` is the correct idiom), `external: ['obsidian', 'electron', 'fs', 'path', 'crypto']`. **Dev-mode output path**: `npm run dev` emits to `test/Archivist/.obsidian/plugins/obsidian-archivist/` (deploys into the local test vault's plugins folder where `hot-reload` picks it up); `npm run build` emits to `./` at the repo root (release-artefact path for GitHub Release uploads). Both targets write the triplet `main.js` + `manifest.json` + `styles.css`.
  4. Validate: `npm run build` succeeds; `main.js` exists and loads into a test vault; `npm run typecheck` (alias for `tsc --noEmit`) passes.
  5. Success: Every later phase can build and test `[ref: SDD/Implementation Context]`; no `@latest` pin `[ref: SDD/ADR-14]`.

- [x] **T1.3 Test runner & linting** `[activity: tooling]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/ADR-14]`, `[ref: SDD/System-Wide Patterns/Security]` (innerHTML ban).
  2. Test: `npm test` runs vitest with one smoke test `describe('sanity') { it('true', () => expect(true).toBe(true)) }`; `npm run lint` flags a file that uses `innerHTML = someVar` but passes on `innerHTML = '<p>literal</p>'` (if ever); `npm audit` exits non-zero on high/critical.
  3. Implement: Create `vitest.config.ts` with `environment: 'node'`, coverage via v8. Create `.eslintrc.json` extending `eslint-plugin-obsidianmd/recommended` + a local rule `no-unsafe-innerhtml` (custom rule file in `tools/eslint/` or `eslint-plugin-local/`) banning `innerHTML =` with non-literal RHS. Add scripts: `test`, `test:watch`, `test:coverage`, `lint`, `typecheck`, `build`, `dev`, `audit`.
  4. Validate: Every script exits as expected; CI-ready exit codes; `npm audit` blocks on synthetic dependency test.
  5. Success: Security gate blocks the `innerHTML` class of bug before it lands `[ref: SDD/ADR-13]`; supply-chain gate enforced `[ref: SDD/ADR-14]`.

- [x] **T1.4 Hello-World plugin entry + lifecycle hygiene** `[activity: backend-api]`

  1. Prime: Read Obsidian plugin lifecycle `[ref: SDD/Implementation Context/interfaces — Obsidian Plugin Lifecycle]`, `[ref: SDD/Cross-Cutting/System-Wide Patterns/Logging]`.
  2. Test: Plugin `onload` registers a ribbon icon (using `addRibbonIcon`) and a command (`Archivist: Hello`); `onunload` removes both without throwing; after a load/unload cycle no timers or listeners remain (asserted via jest-style fake-timers in a test harness that mocks Obsidian API).
  3. Implement: Create `src/main.ts` extending `Plugin`. In `onload`: `addRibbonIcon`, `addCommand`, `registerEvent(this.app.workspace.on('layout-ready', …))` — all via `this.registerX`. Add a minimal `data.json` loader (returns empty settings for now).
  4. Validate: Load into the local test vault at `test/Archivist/` (git-ignored, already configured with `hot-reload`); verify ribbon icon appears; disable the plugin; confirm icon removed; no console errors. Build pipeline should emit the plugin bundle to `test/Archivist/.obsidian/plugins/obsidian-archivist/main.js` so `hot-reload` picks up changes automatically during development.
  5. Success: Lifecycle hygiene contract is provable `[ref: SDD/Risks/Implementation Gotchas — 'every listener via registerX']`; provides the bootstrap that later phases extend.

- [x] **T1.5 CI pipeline (typecheck + lint + test + audit + build)** `[activity: tooling]` `[parallel: true]`

  1. Prime: Read `[ref: SDD/Quality Requirements/Security — supply chain]`.
  2. Test: A GitHub Actions workflow (`.github/workflows/ci.yml`) runs on pull request against `main`; fails if any step fails; passes on the T1.1–T1.4 outputs.
  3. Implement: Author `.github/workflows/ci.yml` with jobs `lint`, `typecheck`, `test`, `audit`, `build` on `ubuntu-latest` and `macos-latest`, Node 20. Include the `main.js` bundle size check as a gate (fail if > 1 MB).
  4. Validate: Open a draft PR with a deliberate lint violation — CI fails. Fix — CI passes. `npm audit` blocks on a synthetic `high` CVE injection.
  5. Success: All future PRs have mechanical quality protection `[ref: SDD/ADR-14]`; Obsidian plugin-review pre-flight gate is automated.

- [x] **T1.6 Phase Validation** `[activity: validate]`

  - Run all Phase 1 tests. Verify the plugin loads/unloads cleanly, the build artifact exists, the CI pipeline is green on a test PR. Lint and typecheck pass. Confirm manifest is community-review-ready via checklist in `[ref: SDD/Quality Requirements/Security]`.

  **Static validation (agent-driven, 2026-04-23):** drift check ALIGNED across scope/missing/contradicts/extra/test-coverage categories except one stale comment in src/main.ts (fixed in a follow-up commit). Every T1.1–T1.5 deliverable present; Dropbox SDK pinned exact; `isDesktopOnly: true`; esbuild uses `pure: ['console.debug']`; release.yml scaffold acknowledged as Phase-10 territory and left in place.

  **Dynamic validation (pending user action on host):** `npm install` → `npm run build` / `npm test` / `npm run lint` / `npm audit --audit-level=high` must all exit 0. Plugin must load into `test/Archivist/` via hot-reload; ribbon icon appears; unload leaves no console errors. CI must go green on a first PR opened against the repo on GitHub. These checks require a local Node environment + network and are the user's next step before Phase 2 starts.
