// TokenStore — Dropbox OAuth token persistence at <plugin-data>/tokens.json.
//
// ADR-7 (revised): tokens live OUTSIDE `data.json` so they don't get spread
// across devices by Obsidian Sync. Reads/writes go through
// `app.vault.adapter.read/write/remove`. On desktop we additionally
// `fs.chmod(path, 0o600)` so other local users can't read the file.
//
// TokenStore intentionally does NOT perform the refresh HTTP call — that
// lives in DropboxClient (T3.1). This module only owns durable storage and
// exposes `isAccessTokenNearExpiry` as a pure predicate that DropboxClient
// can check before each API call for proactive refresh.

import { FileSystemAdapter, Platform, type Plugin } from 'obsidian';
import type { Logger } from './Logger';
import { fromIsoUtc } from '../util/time';

export interface Tokens {
  access_token: string;
  refresh_token: string;
  /** ISO-8601 UTC instant at which the access token expires. */
  access_token_expires_at: string;
  /** Display-only — the Dropbox account the tokens are bound to. */
  dropbox_account_email: string;
}

const TOKENS_FILENAME = 'tokens.json';
const DEFAULT_CHMOD = 0o600;
const SCHEMA_VERSION = '1.0';

export class TokenStore {
  constructor(
    private readonly plugin: Plugin,
    private readonly logger: Logger,
  ) {}

  /**
   * Resolve the vault-relative path to tokens.json.
   *
   * `manifest.dir` is the canonical plugin-data directory
   * (e.g. `.obsidian/plugins/archivist/`). It's always populated at runtime
   * but typed as optional on the Obsidian surface, so fall back to the
   * conventional path if absent.
   */
  private get tokensPath(): string {
    const dir =
      this.plugin.manifest.dir ??
      `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
    return `${dir}/${TOKENS_FILENAME}`;
  }

  async load(): Promise<Tokens | null> {
    const path = this.tokensPath;
    const adapter = this.plugin.app.vault.adapter;
    try {
      const exists = await adapter.exists(path);
      if (!exists) return null;
      const raw = await adapter.read(path);
      const parsed: unknown = JSON.parse(raw);
      const tokens = toTokens(parsed);
      if (tokens === null) {
        // Valid JSON but missing fields — same recovery path as corrupt JSON
        // (user must re-auth). Share the `tokens_corrupt` key so ops only
        // need one alert rule.
        this.logger.warn('tokens_corrupt', { reason: 'missing_required_fields' });
      }
      return tokens;
    } catch (err) {
      // Corrupt JSON on disk gets its own key so ops can distinguish a
      // malformed file (re-auth needed) from a transient I/O error.
      if (err instanceof SyntaxError) {
        this.logger.warn('tokens_corrupt', { error: err });
        return null;
      }
      // Missing-file is not an error. Surface anything else as a warning and
      // return null so the UI can drive the user to re-auth cleanly.
      this.logger.warn('tokens_load_failed', { error: err });
      return null;
    }
  }

  async save(tokens: Tokens): Promise<void> {
    const path = this.tokensPath;
    const payload = {
      // schema_version is written for future migration gating; load() currently
      // ignores unknown/incompatible schemas.
      schema_version: SCHEMA_VERSION,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      access_token_expires_at: tokens.access_token_expires_at,
      dropbox_account_email: tokens.dropbox_account_email,
    };
    // adapter.write replaces in-place; crash mid-write is recoverable via
    // re-auth (load() returns null on malformed JSON).
    await this.plugin.app.vault.adapter.write(path, JSON.stringify(payload, null, 2));
    await this.chmodIfDesktop(path);
  }

  async clear(): Promise<void> {
    const path = this.tokensPath;
    const adapter = this.plugin.app.vault.adapter;
    try {
      await adapter.remove(path);
    } catch (err) {
      // Tolerate missing-file here too — clearing a non-existent token file
      // is idempotent.
      this.logger.warn('tokens_clear_failed', { error: err });
    }
  }

  /**
   * Pure predicate: true when `access_token_expires_at` is within
   * `thresholdSeconds` of `now`. Intended as the proactive-refresh hook for
   * DropboxClient. `now` is injectable for testability — same style as
   * `src/util/time.ts`.
   */
  isAccessTokenNearExpiry(
    tokens: Tokens,
    thresholdSeconds: number,
    now: () => Date = () => new Date(),
  ): boolean {
    const expiresAt = fromIsoUtc(tokens.access_token_expires_at);
    const cutoff = now().getTime() + thresholdSeconds * 1000;
    return expiresAt.getTime() <= cutoff;
  }

  // ---- chmod guard --------------------------------------------------------

  private async chmodIfDesktop(relativePath: string): Promise<void> {
    if (!Platform.isDesktopApp) return;
    const adapter = this.plugin.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;

    const abs = adapter.getFullPath(relativePath);
    try {
      // Dynamic import so mobile bundles never statically pull `fs`. Vitest's
      // `vi.mock('fs', …)` intercepts this at test time. The `fs` module
      // type isn't in our `lib` (DOM + ES2020 only) — describe just the
      // surface we touch inline to avoid pulling `@types/node` into `src/`.
      interface FsLike {
        promises: { chmod: (p: string, mode: number) => Promise<void> };
      }
      // Hide the specifier from TS's static module resolution; at runtime
      // this is a regular dynamic import that esbuild/vitest both handle.
      // The value is a hard-coded literal — the no-unsanitized rule is
      // meant to catch user-controlled strings, which this isn't.
      const specifier = 'fs';
      // eslint-disable-next-line no-unsanitized/method
      const fs = (await import(specifier)) as unknown as FsLike;
      await fs.promises.chmod(abs, DEFAULT_CHMOD);
    } catch (err) {
      // chmod failure must NOT block token save — log and move on.
      // 'path' is redacted by Logger unless diagnostic_logging is enabled —
      // see Logger.PATH_KEYS.
      this.logger.warn('tokens_chmod_failed', { error: err, path: abs });
    }
  }
}

function toTokens(raw: unknown): Tokens | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.access_token !== 'string' ||
    typeof r.refresh_token !== 'string' ||
    typeof r.access_token_expires_at !== 'string' ||
    typeof r.dropbox_account_email !== 'string'
  ) {
    return null;
  }
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    access_token_expires_at: r.access_token_expires_at,
    dropbox_account_email: r.dropbox_account_email,
  };
}
