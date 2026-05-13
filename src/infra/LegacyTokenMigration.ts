// One-shot migration from ADR-7's on-disk `tokens.json` into ADR-21's
// `app.secretStorage`. Runs once on the first `onload` after upgrade from V1.0;
// idempotent on subsequent loads because the legacy file is gone and the
// secret is populated.
//
// Removed entirely at target V0.9.0 (≥ 2 patch releases after V1.1 ships) per
// ADR-21. Tracked in `docs/XDD/specs/001-archivist-plugin/plan/phase-13.md`.

import type { Plugin } from 'obsidian';
import type { Logger } from './Logger';
import { type Tokens, TokenStore } from './TokenStore';

/** Mirror of `TokenStore`'s constant — duplicated here so a future rename of
 *  the production constant doesn't silently break the legacy migration. The
 *  pair are jointly tested via the integration test in `tests/lifecycle/main.test.ts`. */
const SECRET_ID = 'archivist-dropbox-tokens';

/**
 * Probe the legacy `tokens.json` location and, if present, fold its contents
 * into SecretStorage and remove the file. Never throws — all failure modes
 * are recoverable by the user re-authenticating.
 *
 * Failure modes:
 * - Probe error (adapter.exists throws): logged and the migration is
 *   skipped; user's next OAuth flow recreates the secret cleanly.
 * - Legacy file present but secret already set (orphan): drops the stale
 *   file and keeps the secret as source of truth.
 * - Legacy file corrupt (malformed JSON or missing fields): logs
 *   `tokens_corrupt` with `source: 'legacy_tokens_json'` and removes the
 *   garbage so the next start is a clean fresh-install path.
 * - adapter.remove fails after a successful secret write: the migration
 *   is still considered complete; the orphan file is harmless because
 *   TokenStore no longer reads from disk.
 */
export async function migrateLegacyTokensIfPresent(
  plugin: Pick<Plugin, 'app' | 'manifest'>,
  tokenStore: TokenStore,
  logger: Logger,
): Promise<void> {
  const pluginDir =
    plugin.manifest.dir ??
    `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
  const legacyPath = `${pluginDir}/tokens.json`;
  const adapter = plugin.app.vault.adapter;

  let legacyExists: boolean;
  try {
    legacyExists = await adapter.exists(legacyPath);
  } catch (err) {
    logger.warn('tokens_migrate_legacy_probe_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!legacyExists) return;

  const secret = plugin.app.secretStorage.getSecret(SECRET_ID);
  const hasSecret = secret !== null && secret !== '';

  const tryRemove = async (reason: string): Promise<void> => {
    try {
      await adapter.remove(legacyPath);
    } catch (err) {
      logger.warn('tokens_migrate_legacy_cleanup_failed', {
        error: err instanceof Error ? err.message : String(err),
        reason,
      });
    }
  };

  if (hasSecret) {
    // Orphan: SecretStorage is already the source of truth.
    logger.info('tokens_legacy_orphan_removed');
    await tryRemove('orphan');
    return;
  }

  // Secret empty, legacy file present → migrate the contents.
  let raw: string;
  try {
    raw = await adapter.read(legacyPath);
  } catch (err) {
    logger.warn('tokens_migrate_legacy_read_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn('tokens_corrupt', {
      source: 'legacy_tokens_json',
      error: err instanceof Error ? err.message : String(err),
    });
    await tryRemove('corrupt');
    return;
  }

  if (!isValidLegacyTokenShape(parsed)) {
    logger.warn('tokens_corrupt', {
      reason: 'missing_required_fields',
      source: 'legacy_tokens_json',
    });
    await tryRemove('corrupt');
    return;
  }

  await tokenStore.save(parsed);
  logger.info('tokens_migrated');
  await tryRemove('migrated');
}

function isValidLegacyTokenShape(raw: unknown): raw is Tokens {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.access_token === 'string' &&
    typeof r.refresh_token === 'string' &&
    typeof r.access_token_expires_at === 'string' &&
    typeof r.dropbox_account_email === 'string'
  );
}
