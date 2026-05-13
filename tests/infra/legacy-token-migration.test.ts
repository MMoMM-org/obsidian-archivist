// T13.4 — One-shot migration from ADR-7's tokens.json into ADR-21's
// app.secretStorage. Idempotent across runs: on every onload after a
// successful first pass, the legacy file is gone and the secret is set.

import { describe, expect, it, vi } from 'vitest';

import { SecretStorage } from '../fixtures/obsidian-mock';
import type { Logger } from '../../src/infra/Logger';
import { TokenStore, type Tokens } from '../../src/infra/TokenStore';
import { migrateLegacyTokensIfPresent } from '../../src/infra/LegacyTokenMigration';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AdapterSpy = {
  exists: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

function makeAdapter(opts: {
  exists?: (path: string) => boolean | Promise<boolean>;
  read?: (path: string) => string | Promise<string>;
  remove?: (path: string) => void | Promise<void>;
}): AdapterSpy {
  return {
    exists: vi.fn(async (p: string) => (opts.exists ? opts.exists(p) : false)),
    read: vi.fn(async (p: string) => (opts.read ? opts.read(p) : '')),
    write: vi.fn(async () => {}),
    remove: vi.fn(async (p: string) => {
      if (opts.remove) await opts.remove(p);
    }),
  };
}

type WarnEntry = { message: string; payload?: Record<string, unknown> };
type TestLogger = Logger & {
  infos: WarnEntry[];
  warnings: WarnEntry[];
  errors: WarnEntry[];
};

function makeLogger(): TestLogger {
  const infos: WarnEntry[] = [];
  const warnings: WarnEntry[] = [];
  const errors: WarnEntry[] = [];
  return {
    info: (m: string, p?: Record<string, unknown>) => infos.push({ message: m, payload: p }),
    warn: (m: string, p?: Record<string, unknown>) => warnings.push({ message: m, payload: p }),
    error: (m: string, p?: Record<string, unknown>) => errors.push({ message: m, payload: p }),
    debug: () => {},
    infos,
    warnings,
    errors,
  };
}

type FakePlugin = {
  app: {
    secretStorage: SecretStorage;
    vault: { adapter: AdapterSpy; configDir: string };
  };
  manifest: { id: string; dir?: string };
};

function makePlugin(adapter: AdapterSpy): FakePlugin {
  // Mirrors the runtime Plugin shape needed by migrateLegacyTokensIfPresent
  // (the `Pick<Plugin, 'app' | 'manifest'>` constraint). `manifest.dir` is
  // intentionally omitted so we exercise the configDir fallback used by the
  // earlier ADR-7 code path; tests that need a fixed plugin-data dir set
  // `manifest.dir` directly.
  return {
    app: {
      secretStorage: new SecretStorage(),
      vault: { adapter, configDir: '.obsidian' },
    },
    manifest: { id: 'archivist' },
  };
}

const EXPECTED_LEGACY_PATH = '.obsidian/plugins/archivist/tokens.json';
const SECRET_ID = 'archivist-dropbox-tokens';

const VALID_LEGACY: Tokens = {
  access_token: 'sl.u.AAA',
  refresh_token: 'rt.BBB',
  access_token_expires_at: '2026-04-23T12:00:00.000Z',
  dropbox_account_email: 'user@example.com',
};

function makeRun(opts: {
  exists?: (path: string) => boolean | Promise<boolean>;
  read?: (path: string) => string | Promise<string>;
  remove?: (path: string) => void | Promise<void>;
  preSecret?: string;
}): {
  plugin: FakePlugin;
  tokenStore: TokenStore;
  logger: TestLogger;
  adapter: AdapterSpy;
} {
  const adapter = makeAdapter(opts);
  const plugin = makePlugin(adapter);
  if (opts.preSecret !== undefined) {
    plugin.app.secretStorage.setSecret(SECRET_ID, opts.preSecret);
  }
  const logger = makeLogger();
  const tokenStore = new TokenStore(plugin as never, logger);
  return { plugin, tokenStore, logger, adapter };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateLegacyTokensIfPresent (T13.4)', () => {
  describe('fresh install (neither legacy file nor secret)', () => {
    it('is a no-op — no read, no remove, no logs', async () => {
      const { plugin, tokenStore, logger, adapter } = makeRun({
        exists: () => false,
      });

      await migrateLegacyTokensIfPresent(plugin as never, tokenStore, logger);

      expect(adapter.exists).toHaveBeenCalledWith(EXPECTED_LEGACY_PATH);
      expect(adapter.read).not.toHaveBeenCalled();
      expect(adapter.remove).not.toHaveBeenCalled();
      expect(plugin.app.secretStorage.getSecret(SECRET_ID)).toBeNull();
      expect(logger.infos).toEqual([]);
      expect(logger.warnings).toEqual([]);
    });
  });

  describe('happy path (legacy present + secret empty)', () => {
    it('writes the token to SecretStorage, removes the legacy file, logs tokens_migrated', async () => {
      const { plugin, tokenStore, logger, adapter } = makeRun({
        exists: () => true,
        read: () => JSON.stringify(VALID_LEGACY),
      });

      await migrateLegacyTokensIfPresent(plugin as never, tokenStore, logger);

      // SecretStorage now holds the JSON-encoded blob via TokenStore.save.
      const stored = plugin.app.secretStorage.getSecret(SECRET_ID);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!)).toMatchObject({
        schema_version: '1.0',
        access_token: VALID_LEGACY.access_token,
        refresh_token: VALID_LEGACY.refresh_token,
        access_token_expires_at: VALID_LEGACY.access_token_expires_at,
        dropbox_account_email: VALID_LEGACY.dropbox_account_email,
      });
      expect(adapter.remove).toHaveBeenCalledWith(EXPECTED_LEGACY_PATH);
      expect(logger.infos.find((e) => e.message === 'tokens_migrated')).toBeDefined();
      expect(logger.warnings).toEqual([]);
    });

    it('subsequent TokenStore.load() returns the migrated Tokens', async () => {
      const { plugin, tokenStore, logger } = makeRun({
        exists: () => true,
        read: () => JSON.stringify(VALID_LEGACY),
      });

      await migrateLegacyTokensIfPresent(plugin as never, tokenStore, logger);

      expect(await tokenStore.load()).toEqual(VALID_LEGACY);
    });
  });

  describe('orphan (legacy file present + secret already set)', () => {
    it('keeps SecretStorage value, removes the stale file, logs tokens_legacy_orphan_removed', async () => {
      const preSecret = JSON.stringify({
        schema_version: '1.0',
        access_token: 'sl.u.NEW',
        refresh_token: 'rt.NEW',
        access_token_expires_at: '2026-05-01T12:00:00.000Z',
        dropbox_account_email: 'new@example.com',
      });
      const { plugin, tokenStore, logger, adapter } = makeRun({
        exists: () => true,
        // Legacy file contains a DIFFERENT, older token — we must NOT clobber
        // the secret with it.
        read: () => JSON.stringify(VALID_LEGACY),
        preSecret,
      });

      await migrateLegacyTokensIfPresent(plugin as never, tokenStore, logger);

      expect(plugin.app.secretStorage.getSecret(SECRET_ID)).toBe(preSecret);
      expect(adapter.remove).toHaveBeenCalledWith(EXPECTED_LEGACY_PATH);
      expect(logger.infos.find((e) => e.message === 'tokens_legacy_orphan_removed')).toBeDefined();
      expect(adapter.read).not.toHaveBeenCalled();
    });

    it('treats an empty-string secret as "no secret" (does NOT trigger orphan path)', async () => {
      // ADR-21 Q2 outcome: cleared secrets are stored as ''. The migration
      // must still happen — '' means "user disconnected" but legacy may
      // hold an older valid token from before the upgrade.
      const { plugin, tokenStore, logger, adapter } = makeRun({
        exists: () => true,
        read: () => JSON.stringify(VALID_LEGACY),
        preSecret: '',
      });

      await migrateLegacyTokensIfPresent(plugin as never, tokenStore, logger);

      expect(logger.infos.find((e) => e.message === 'tokens_migrated')).toBeDefined();
      expect(logger.infos.find((e) => e.message === 'tokens_legacy_orphan_removed')).toBeUndefined();
      // Migrated content overwrites the empty secret.
      const stored = plugin.app.secretStorage.getSecret(SECRET_ID);
      expect(stored).not.toBe('');
      expect(JSON.parse(stored!).access_token).toBe(VALID_LEGACY.access_token);
      expect(adapter.remove).toHaveBeenCalledWith(EXPECTED_LEGACY_PATH);
    });
  });

  describe('corrupt legacy (malformed JSON)', () => {
    it('removes the garbage file, logs tokens_corrupt with source, keeps SecretStorage empty', async () => {
      const { plugin, tokenStore, logger, adapter } = makeRun({
        exists: () => true,
        read: () => '{"access_token":',
      });

      await migrateLegacyTokensIfPresent(plugin as never, tokenStore, logger);

      expect(plugin.app.secretStorage.getSecret(SECRET_ID)).toBeNull();
      expect(adapter.remove).toHaveBeenCalledWith(EXPECTED_LEGACY_PATH);
      const warn = logger.warnings.find((e) => e.message === 'tokens_corrupt');
      expect(warn).toBeDefined();
      expect(warn!.payload).toMatchObject({ source: 'legacy_tokens_json' });
    });
  });

  describe('corrupt legacy (missing fields)', () => {
    it('removes the file, logs tokens_corrupt with reason+source, keeps SecretStorage empty', async () => {
      const { plugin, tokenStore, logger, adapter } = makeRun({
        exists: () => true,
        read: () => JSON.stringify({ access_token: 'partial' }),
      });

      await migrateLegacyTokensIfPresent(plugin as never, tokenStore, logger);

      expect(plugin.app.secretStorage.getSecret(SECRET_ID)).toBeNull();
      expect(adapter.remove).toHaveBeenCalledWith(EXPECTED_LEGACY_PATH);
      const warn = logger.warnings.find((e) => e.message === 'tokens_corrupt');
      expect(warn).toBeDefined();
      expect(warn!.payload).toMatchObject({
        reason: 'missing_required_fields',
        source: 'legacy_tokens_json',
      });
    });
  });

  describe('failure isolation', () => {
    it('adapter.remove failure after a successful secret write does NOT throw', async () => {
      const { plugin, tokenStore, logger, adapter } = makeRun({
        exists: () => true,
        read: () => JSON.stringify(VALID_LEGACY),
        remove: () => {
          throw new Error('EBUSY: locked by sync tool');
        },
      });

      await expect(
        migrateLegacyTokensIfPresent(plugin as never, tokenStore, logger),
      ).resolves.toBeUndefined();

      // Secret was written — migration is considered successful.
      const stored = plugin.app.secretStorage.getSecret(SECRET_ID);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).access_token).toBe(VALID_LEGACY.access_token);

      // Cleanup failure logged as warn, NOT error; reason recorded so ops
      // can distinguish from probe/read failures.
      const cleanupWarn = logger.warnings.find(
        (e) => e.message === 'tokens_migrate_legacy_cleanup_failed',
      );
      expect(cleanupWarn).toBeDefined();
      expect(cleanupWarn!.payload).toMatchObject({ reason: 'migrated' });
      // The migration success log is still emitted.
      expect(logger.infos.find((e) => e.message === 'tokens_migrated')).toBeDefined();
      // adapter.remove was attempted.
      expect(adapter.remove).toHaveBeenCalledWith(EXPECTED_LEGACY_PATH);
    });

    it('adapter.exists failure aborts cleanly without touching SecretStorage', async () => {
      const { plugin, tokenStore, logger, adapter } = makeRun({
        exists: () => {
          throw new Error('EIO: probe failed');
        },
      });

      await expect(
        migrateLegacyTokensIfPresent(plugin as never, tokenStore, logger),
      ).resolves.toBeUndefined();

      expect(plugin.app.secretStorage.getSecret(SECRET_ID)).toBeNull();
      expect(adapter.read).not.toHaveBeenCalled();
      expect(adapter.remove).not.toHaveBeenCalled();
      expect(
        logger.warnings.find((e) => e.message === 'tokens_migrate_legacy_probe_failed'),
      ).toBeDefined();
    });

    it('adapter.read failure (file present but unreadable) logs and skips migration', async () => {
      const { plugin, tokenStore, logger, adapter } = makeRun({
        exists: () => true,
        read: () => {
          throw new Error('EACCES: permission denied');
        },
      });

      await migrateLegacyTokensIfPresent(plugin as never, tokenStore, logger);

      expect(plugin.app.secretStorage.getSecret(SECRET_ID)).toBeNull();
      // We do NOT remove the file on read failure — the user might be able
      // to recover it (chmod, restore from backup) before the next start.
      expect(adapter.remove).not.toHaveBeenCalled();
      expect(
        logger.warnings.find((e) => e.message === 'tokens_migrate_legacy_read_failed'),
      ).toBeDefined();
    });
  });

  describe('path resolution', () => {
    it('uses manifest.dir when present (ignores configDir fallback)', async () => {
      const adapter = makeAdapter({ exists: () => false });
      const plugin = makePlugin(adapter);
      plugin.manifest.dir = '.obsidian/plugins/archivist-custom-dir';
      const tokenStore = new TokenStore(plugin as never, makeLogger());

      await migrateLegacyTokensIfPresent(plugin as never, tokenStore, makeLogger());

      expect(adapter.exists).toHaveBeenCalledWith(
        '.obsidian/plugins/archivist-custom-dir/tokens.json',
      );
    });

    it('falls back to configDir/plugins/id when manifest.dir is unset', async () => {
      const adapter = makeAdapter({ exists: () => false });
      const plugin = makePlugin(adapter);
      // Custom configDir (Obsidian allows users to relocate `.obsidian`)
      plugin.app.vault.configDir = '.my-obsidian';
      const tokenStore = new TokenStore(plugin as never, makeLogger());

      await migrateLegacyTokensIfPresent(plugin as never, tokenStore, makeLogger());

      expect(adapter.exists).toHaveBeenCalledWith(
        '.my-obsidian/plugins/archivist/tokens.json',
      );
    });
  });

  describe('idempotency', () => {
    it('running migration twice in a row produces the same end state', async () => {
      // First run: full migration. Second run: file is gone, secret is set,
      // so the function exits at the `legacyExists === false` branch.
      let removed = false;
      const { plugin, tokenStore, logger, adapter } = makeRun({
        exists: () => !removed,
        read: () => JSON.stringify(VALID_LEGACY),
        remove: () => {
          removed = true;
        },
      });

      await migrateLegacyTokensIfPresent(plugin as never, tokenStore, logger);
      const afterFirst = plugin.app.secretStorage.getSecret(SECRET_ID);

      await migrateLegacyTokensIfPresent(plugin as never, tokenStore, logger);
      const afterSecond = plugin.app.secretStorage.getSecret(SECRET_ID);

      expect(afterFirst).toEqual(afterSecond);
      // Migration log fires exactly once.
      const migratedLogs = logger.infos.filter((e) => e.message === 'tokens_migrated');
      expect(migratedLogs).toHaveLength(1);
      expect(adapter.remove).toHaveBeenCalledTimes(1);
    });
  });
});
