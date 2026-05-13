// T13.3 — TokenStore over Obsidian SecretStorage (ADR-21).
//
// Replaces the T3.2 disk-based `tokens.json` implementation. Tokens now live
// in `app.secretStorage` under id `archivist-dropbox-tokens` as a single
// JSON-encoded blob. `clear()` overwrites with `''` because the SecretStorage
// API has no `removeSecret` as of Obsidian 1.11.4 (Q2 of the phase-13 probe).
// The chmod / FileSystemAdapter / mobile-vs-desktop branches and the
// `tokens_chmod_failed` / `tokens_clear_failed` warn keys retire alongside ADR-7.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SecretStorage } from '../fixtures/obsidian-mock';
import type { Logger } from '../../src/infra/Logger';
import { TokenStore, type Tokens } from '../../src/infra/TokenStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AdapterSpy = {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

function makeAdapterSpy(): AdapterSpy {
  // Every adapter method is a spy so the negative-regression guards can
  // catch a future change that accidentally reintroduces a disk fallback.
  return {
    read: vi.fn(async () => ''),
    write: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
  };
}

type FakePlugin = {
  app: {
    secretStorage: SecretStorage;
    vault: { adapter: AdapterSpy };
  };
};

function makePlugin(): FakePlugin {
  return {
    app: {
      secretStorage: new SecretStorage(),
      vault: { adapter: makeAdapterSpy() },
    },
  };
}

type WarnEntry = { message: string; payload?: Record<string, unknown> };
type TestLogger = Logger & { warnings: WarnEntry[]; debugs: WarnEntry[] };

function makeTestLogger(): TestLogger {
  const warnings: WarnEntry[] = [];
  const debugs: WarnEntry[] = [];
  const logger: TestLogger = {
    info: () => {},
    warn: (m: string, p?: Record<string, unknown>) => {
      warnings.push({ message: m, payload: p });
    },
    error: () => {},
    debug: (m: string, p?: Record<string, unknown>) => {
      debugs.push({ message: m, payload: p });
    },
    warnings,
    debugs,
  };
  return logger;
}

function setup(): {
  store: TokenStore;
  plugin: FakePlugin;
  logger: TestLogger;
} {
  const plugin = makePlugin();
  const logger = makeTestLogger();
  const store = new TokenStore(plugin as never, logger);
  return { store, plugin, logger };
}

const SECRET_ID = 'archivist-dropbox-tokens';

const SAMPLE_TOKENS: Tokens = {
  access_token: 'sl.u.AAA_access',
  refresh_token: 'rt_BBB_refresh',
  access_token_expires_at: '2026-04-23T12:00:00.000Z',
  dropbox_account_email: 'user@example.com',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TokenStore (SecretStorage backend, ADR-21)', () => {
  beforeEach(() => {
    // Each test gets a fresh plugin/secretStorage instance via setup();
    // no global state to reset.
  });

  describe('save()', () => {
    it('persists tokens via secretStorage.setSecret with schema_version + 4 fields', async () => {
      const { store, plugin } = setup();

      await store.save(SAMPLE_TOKENS);

      const raw = plugin.app.secretStorage.getSecret(SECRET_ID);
      expect(raw, 'secret must be populated under archivist-dropbox-tokens').not.toBeNull();
      expect(raw).not.toBe('');
      const parsed = JSON.parse(raw!);
      expect(parsed.schema_version).toBe('1.0');
      expect(parsed.access_token).toBe(SAMPLE_TOKENS.access_token);
      expect(parsed.refresh_token).toBe(SAMPLE_TOKENS.refresh_token);
      expect(parsed.access_token_expires_at).toBe(SAMPLE_TOKENS.access_token_expires_at);
      expect(parsed.dropbox_account_email).toBe(SAMPLE_TOKENS.dropbox_account_email);
    });

    it('does NOT touch the vault adapter (regression guard against disk fallback)', async () => {
      const { store, plugin } = setup();
      await store.save(SAMPLE_TOKENS);
      expect(plugin.app.vault.adapter.write).not.toHaveBeenCalled();
      expect(plugin.app.vault.adapter.read).not.toHaveBeenCalled();
      expect(plugin.app.vault.adapter.remove).not.toHaveBeenCalled();
      expect(plugin.app.vault.adapter.exists).not.toHaveBeenCalled();
    });
  });

  describe('load()', () => {
    it('returns tokens intact after save', async () => {
      const { store } = setup();
      await store.save(SAMPLE_TOKENS);
      expect(await store.load()).toEqual(SAMPLE_TOKENS);
    });

    it('returns null when secret was never set', async () => {
      const { store } = setup();
      expect(await store.load()).toBeNull();
    });

    it('returns null when secret is the empty string (Q2 — cleared state)', async () => {
      // Pins ADR-21 Verified Behavior: SecretStorage retains the id with an
      // empty value after a clear; load() must treat '' identically to null.
      const { store, plugin } = setup();
      plugin.app.secretStorage.setSecret(SECRET_ID, '');
      expect(await store.load()).toBeNull();
    });

    it('returns null and warns tokens_corrupt on malformed JSON', async () => {
      const { store, plugin, logger } = setup();
      plugin.app.secretStorage.setSecret(SECRET_ID, '{"access_token":');
      expect(await store.load()).toBeNull();
      expect(logger.warnings.some((w) => w.message === 'tokens_corrupt')).toBe(true);
    });

    it('returns null and warns tokens_corrupt with reason when fields are missing', async () => {
      const { store, plugin, logger } = setup();
      plugin.app.secretStorage.setSecret(
        SECRET_ID,
        JSON.stringify({ access_token: 'partial' }),
      );
      expect(await store.load()).toBeNull();
      const warn = logger.warnings.find((w) => w.message === 'tokens_corrupt');
      expect(warn, 'expected tokens_corrupt warn entry').toBeDefined();
      expect(warn!.payload).toMatchObject({ reason: 'missing_required_fields' });
    });

    it('does NOT touch the vault adapter (regression guard)', async () => {
      const { store, plugin } = setup();
      await store.load();
      expect(plugin.app.vault.adapter.write).not.toHaveBeenCalled();
      expect(plugin.app.vault.adapter.read).not.toHaveBeenCalled();
      expect(plugin.app.vault.adapter.remove).not.toHaveBeenCalled();
      expect(plugin.app.vault.adapter.exists).not.toHaveBeenCalled();
    });
  });

  describe('clear()', () => {
    it('overwrites the secret with the empty string', async () => {
      const { store, plugin } = setup();
      await store.save(SAMPLE_TOKENS);
      await store.clear();
      expect(plugin.app.secretStorage.getSecret(SECRET_ID)).toBe('');
    });

    it('subsequent load() returns null', async () => {
      const { store } = setup();
      await store.save(SAMPLE_TOKENS);
      await store.clear();
      expect(await store.load()).toBeNull();
    });

    it('on a never-set store is a no-op (does not throw)', async () => {
      const { store } = setup();
      await expect(store.clear()).resolves.toBeUndefined();
    });

    it('does NOT touch the vault adapter (regression guard)', async () => {
      const { store, plugin } = setup();
      await store.clear();
      expect(plugin.app.vault.adapter.write).not.toHaveBeenCalled();
      expect(plugin.app.vault.adapter.read).not.toHaveBeenCalled();
      expect(plugin.app.vault.adapter.remove).not.toHaveBeenCalled();
      expect(plugin.app.vault.adapter.exists).not.toHaveBeenCalled();
    });
  });

  describe('isAccessTokenNearExpiry()', () => {
    const now = new Date('2026-04-23T12:00:00.000Z');

    it('returns true when expiry <= now + threshold', () => {
      const { store } = setup();
      const tokens: Tokens = {
        ...SAMPLE_TOKENS,
        access_token_expires_at: '2026-04-23T12:00:30.000Z',
      };
      expect(store.isAccessTokenNearExpiry(tokens, 60, () => now)).toBe(true);
    });

    it('returns false when expiry > now + threshold', () => {
      const { store } = setup();
      const tokens: Tokens = {
        ...SAMPLE_TOKENS,
        access_token_expires_at: '2026-04-23T12:10:00.000Z',
      };
      expect(store.isAccessTokenNearExpiry(tokens, 60, () => now)).toBe(false);
    });

    it('inclusive boundary: expiry exactly at now + threshold returns true', () => {
      const { store } = setup();
      const tokens: Tokens = {
        ...SAMPLE_TOKENS,
        access_token_expires_at: '2026-04-23T12:01:00.000Z',
      };
      expect(store.isAccessTokenNearExpiry(tokens, 60, () => now)).toBe(true);
    });
  });
});
