// TokenStore — Dropbox OAuth token persistence via Obsidian SecretStorage.
//
// ADR-21 (2026-05-13, supersedes ADR-7): tokens live in `app.secretStorage`
// under id `archivist-dropbox-tokens` as a single JSON-encoded blob. Obsidian's
// SecretStorage is Electron-`safeStorage`–backed — encrypted blob in the
// app-support dir + master key in the OS credential store (macOS login
// Keychain / Windows DPAPI / Linux libsecret if available). Off the
// Obsidian-Sync path by construction.
//
// `clear()` overwrites the secret with `''` because the SecretStorage API
// has no `removeSecret` as of Obsidian 1.11.4 (Q2 of the phase-13 probe);
// `load()` treats both `null` and `''` as "no token".
//
// TokenStore intentionally does NOT perform the refresh HTTP call — that
// lives in DropboxClient (T3.1). This module only owns durable storage and
// exposes `isAccessTokenNearExpiry` as a pure predicate that DropboxClient
// checks before each API call for proactive refresh.

import type { Plugin } from 'obsidian';
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

/** Stable secret id under which the JSON-encoded `Tokens` blob is stored. */
const SECRET_ID = 'archivist-dropbox-tokens';
const SCHEMA_VERSION = '1.0';

export class TokenStore {
  constructor(
    private readonly plugin: Plugin,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<Tokens | null> {
    const raw = this.plugin.app.secretStorage.getSecret(SECRET_ID);
    // ADR-21 Q2: SecretStorage retains the id after a clear with the literal
    // empty string. Treat null and '' identically as "no token on file".
    if (raw === null || raw === '') return null;
    try {
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
      // Corrupt JSON in the secret store gets its own key so ops can
      // distinguish a malformed blob (re-auth needed) from a transient
      // SecretStorage error.
      if (err instanceof SyntaxError) {
        this.logger.warn('tokens_corrupt', { error: err });
        return null;
      }
      this.logger.warn('tokens_load_failed', { error: err });
      return null;
    }
  }

  async save(tokens: Tokens): Promise<void> {
    const payload = JSON.stringify({
      // schema_version is written for future migration gating; load() currently
      // ignores unknown/incompatible schemas.
      schema_version: SCHEMA_VERSION,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      access_token_expires_at: tokens.access_token_expires_at,
      dropbox_account_email: tokens.dropbox_account_email,
    });
    this.plugin.app.secretStorage.setSecret(SECRET_ID, payload);
  }

  async clear(): Promise<void> {
    // SecretStorage has no removeSecret as of Obsidian 1.11.4; overwrite with
    // '' and load() returns null. The id stays in listSecrets() — full removal
    // requires the user to use Obsidian's Settings UI.
    this.plugin.app.secretStorage.setSecret(SECRET_ID, '');
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
