# Toolchain on Obsidian 1.14.4

> Date: 2026-11-21
> Spec: 002-declarative-settings, task T1.1 (issue #54, SDD ADR-5)

## Version bumps

| Package | Before | After | Pin |
|---|---|---|---|
| `obsidian` | 1.12.3 | 1.14.4 | exact |
| `eslint-plugin-obsidianmd` | 0.4.2 declared, 0.3.0 installed | 0.6.0 | exact |

Why:
- The declarative settings API (`getSettingDefinitions()`, 1.13+) needs the 1.14 typings.
- The local lint must mirror the Obsidian plugin-review bot. 0.3.0 had no settings-tab rules at all.
  0.4.2 exact-peers `obsidian@1.8.7`, which conflicts with 1.14.4. 0.6.0 has no such peer.
- `eslint-plugin-obsidianmd@0.6.0` is MIT-licensed (Constitution Dependencies L1).

`minAppVersion` stays at 1.11.4 for now. It moves to 1.14.4 in T3.3, when `display()` is removed.
Browserslist stays at `chrome 139` permanently (ADR-6): app updates don't update Electron.

## Unsandboxed install

`npm install` ran with the Claude Code sandbox disabled. The npm cache (`~/.npm/_cacache`) is
outside the sandbox write set, and a sandboxed install half-breaks `node_modules`. Don't run
`npm ci` inside the sandbox.

## ESLint `files` scoping

From 0.5.0, the obsidianmd recommended config also lints `manifest.json` (JSON language) and
`LICENSE` (`obsidianmd/plain-text` language). A config block without `files` that enables core JS
or type-checked rules reaches those files and aborts the run. For example, `eslint manifest.json`
fails with `Error while loading rule 'no-irregular-whitespace': sourceCode.getAllComments is not a function`.

`eslint.config.mjs` now scopes `js.configs.recommended`, every `tseslint.configs.recommendedTypeChecked`
block, and the local-plugin block to `src/**/*.ts` (the `TS_SOURCES` constant).

`npm run lint` still runs `eslint src/`, so it doesn't visit `manifest.json` and `LICENSE`. To check
them by hand, run `npx eslint manifest.json LICENSE package.json`, which is clean.

## Lint findings after the bump

- `src/ui/SettingsTab.ts`: these three warnings stay until Phase 3.
  - `obsidianmd/settings-tab/prefer-setting-definitions` (line 46)
  - `@typescript-eslint/no-deprecated` on `setWarning` (line 258)
  - `@typescript-eslint/no-deprecated` on `setDynamicTooltip` (line 460)
  - `display()` itself is **not** flagged. `require-display` is satisfied at `minAppVersion` 1.11.4, and
    `no-deprecated-display` only applies once `minAppVersion` is 1.13 or later.
- `obsidianmd/prefer-instanceof` fires on the `activeElement instanceof HTMLElement` focus capture in
  five modals. Fixing it changes popout-window behaviour, so it isn't done in this task (tracked in #114).
- `validate-manifest` and `validate-license` aren't part of `npm run lint` (tracked in #115).

## Test fixtures (T1.2)

`vitest.config.ts` no longer excludes `tests/fixtures/**`, so the new mock self-test
(`tests/fixtures/obsidian-mock.test.ts`) is collected. The include pattern `tests/**/*.test.ts` already
keeps the helper files in that folder out of the run.
- `no-await-chainable`, `prefer-active-doc`, `validate-manifest` and `validate-license` report nothing.
- No `no-misused-promises` disable comments exist, so none needed renaming.
