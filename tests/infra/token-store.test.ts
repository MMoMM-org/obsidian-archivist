// T3.2 — TokenStore persistence + chmod guard + proactive-refresh predicate.
// ADR-7 (revised): tokens live in <plugin-data>/tokens.json, written via
// adapter.write — NEVER through loadData/saveData (which would sync via
// Obsidian Sync). chmod 0o600 applied on desktop via Node fs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Node fs BEFORE importing TokenStore. TokenStore dynamically requires
// 'fs' to stay mobile-safe, but vitest's vi.mock('fs', …) still intercepts
// require('fs') from the module under test.
const chmodMock = vi.fn(async (_p: string, _mode: number) => {});
vi.mock('fs', () => ({
  promises: { chmod: chmodMock },
  default: { promises: { chmod: chmodMock } },
}));

// Re-export Platform from the mock so tests can mutate `isDesktopApp` to hit
// the mobile branch. TokenStore imports `Platform` from 'obsidian', and the
// shared obsidian mock exposes a single mutable object.
import * as obsidianMock from '../fixtures/obsidian-mock';
import { FileSystemAdapter } from '../fixtures/obsidian-mock';
import type { Logger } from '../../src/infra/Logger';
import { TokenStore, type Tokens } from '../../src/infra/TokenStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeAdapter = {
  files: Map<string, string>;
  read: (p: string) => Promise<string>;
  write: (p: string, data: string) => Promise<void>;
  exists: (p: string) => Promise<boolean>;
  remove: (p: string) => Promise<void>;
};

function makeFakeAdapter(): FakeAdapter {
  const files = new Map<string, string>();
  return {
    files,
    read: async (p) => {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    write: async (p, data) => {
      files.set(p, data);
    },
    exists: async (p) => files.has(p),
    remove: async (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`) as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }
      files.delete(p);
    },
  };
}

type FakePlugin = {
  manifest: { id: string; dir: string };
  app: {
    vault: { adapter: FakeAdapter };
  };
  _data: unknown;
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
};

function makePlugin(adapter: FakeAdapter): FakePlugin {
  return {
    manifest: { id: 'archivist', dir: '.obsidian/plugins/archivist' },
    app: { vault: { adapter } },
    _data: null,
    async loadData() {
      return this._data;
    },
    async saveData(d: unknown) {
      this._data = d;
    },
  };
}

type WarnEntry = { message: string; payload?: Record<string, unknown> };

type TestLogger = Logger & { warnings: WarnEntry[] };

function makeTestLogger(): TestLogger {
  const warnings: WarnEntry[] = [];
  // Bypass createLogger — we want to capture the raw message key (e.g.
  // `tokens_corrupt`) so assertions stay stable across formatting tweaks in
  // the production Logger.
  const logger: TestLogger = {
    info: () => {},
    warn: (message: string, payload?: Record<string, unknown>) => {
      warnings.push({ message, payload });
    },
    error: () => {},
    debug: () => {},
    warnings,
  };
  return logger;
}

/** Shared setup used by every test. Returns the full 4-tuple so the test can
 *  pick whatever it needs without re-wiring the fake graph. */
function setup(): {
  store: TokenStore;
  adapter: FakeAdapter;
  plugin: FakePlugin;
  logger: TestLogger;
} {
  const adapter = makeFakeAdapter();
  const plugin = makePlugin(adapter);
  const logger = makeTestLogger();
  const store = new TokenStore(plugin as never, logger);
  return { store, adapter, plugin, logger };
}

const SAMPLE_TOKENS: Tokens = {
  access_token: 'sl.u.AAA_access',
  refresh_token: 'rt_BBB_refresh',
  access_token_expires_at: '2026-04-23T12:00:00.000Z',
  dropbox_account_email: 'user@example.com',
};

const EXPECTED_PATH = '.obsidian/plugins/archivist/tokens.json';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TokenStore', () => {
  beforeEach(() => {
    chmodMock.mockClear();
    chmodMock.mockImplementation(async () => {});
    // Default every test to the desktop branch — mobile tests explicitly flip
    // this. Reset via obsidianMock.Platform to make the mutation obvious.
    obsidianMock.Platform.isDesktopApp = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Leave Platform in desktop state for the next suite.
    obsidianMock.Platform.isDesktopApp = true;
  });

  it('save() persists tokens via adapter.write with exact 4-field shape', async () => {
    const { store, adapter } = setup();

    await store.save(SAMPLE_TOKENS);

    const raw = adapter.files.get(EXPECTED_PATH);
    expect(raw, 'tokens.json must be written at plugin-data path').toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.access_token).toBe(SAMPLE_TOKENS.access_token);
    expect(parsed.refresh_token).toBe(SAMPLE_TOKENS.refresh_token);
    expect(parsed.access_token_expires_at).toBe(SAMPLE_TOKENS.access_token_expires_at);
    expect(parsed.dropbox_account_email).toBe(SAMPLE_TOKENS.dropbox_account_email);
  });

  it('load() returns tokens intact when file exists', async () => {
    const { store } = setup();

    await store.save(SAMPLE_TOKENS);
    const loaded = await store.load();

    expect(loaded).toEqual(SAMPLE_TOKENS);
  });

  it('load() returns null when tokens.json missing', async () => {
    const { store } = setup();

    const loaded = await store.load();
    expect(loaded).toBeNull();
  });

  it('clear() calls adapter.remove', async () => {
    const { store, adapter } = setup();
    const removeSpy = vi.spyOn(adapter, 'remove');

    await store.save(SAMPLE_TOKENS);
    await store.clear();

    expect(removeSpy).toHaveBeenCalledWith(EXPECTED_PATH);
    expect(adapter.files.has(EXPECTED_PATH)).toBe(false);
  });

  it('chmod 0o600 applied to tokens.json on desktop', async () => {
    const { store, plugin, adapter } = setup();
    // Swap in a FileSystemAdapter so the desktop chmod branch fires.
    const fsAdapter = new FileSystemAdapter();
    // Attach the adapter-surface methods onto the FileSystemAdapter instance
    // so it quacks like both.
    Object.assign(fsAdapter, adapter);
    plugin.app.vault.adapter = fsAdapter as unknown as FakeAdapter;

    await store.save(SAMPLE_TOKENS);

    expect(chmodMock).toHaveBeenCalledTimes(1);
    const [absPath, mode] = chmodMock.mock.calls[0]!;
    expect(absPath.endsWith('tokens.json')).toBe(true);
    expect((mode as number) & 0o777).toBe(0o600);
  });

  it('tokens.json does NOT appear in data.json contents', async () => {
    const { store, plugin } = setup();

    await store.save(SAMPLE_TOKENS);
    const dataJson = await plugin.loadData();

    // loadData() must still reflect whatever Obsidian manages — NOT our tokens.
    const serialized = JSON.stringify(dataJson ?? {});
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');
  });

  it('isAccessTokenNearExpiry(60) returns true when expiry <= now + 60s', () => {
    const { store } = setup();

    const now = new Date('2026-04-23T12:00:00.000Z');
    const tokens: Tokens = {
      ...SAMPLE_TOKENS,
      // expires 30s from "now" — well inside the 60s threshold
      access_token_expires_at: '2026-04-23T12:00:30.000Z',
    };

    expect(store.isAccessTokenNearExpiry(tokens, 60, () => now)).toBe(true);
  });

  it('isAccessTokenNearExpiry(60) returns false when expiry > now + 60s', () => {
    const { store } = setup();

    const now = new Date('2026-04-23T12:00:00.000Z');
    const tokens: Tokens = {
      ...SAMPLE_TOKENS,
      // expires 10 minutes from "now" — comfortably outside threshold
      access_token_expires_at: '2026-04-23T12:10:00.000Z',
    };

    expect(store.isAccessTokenNearExpiry(tokens, 60, () => now)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Resilience / regression guards (code-quality review findings)
  // -------------------------------------------------------------------------

  it('save() tolerates chmod EPERM — file is written, warn logged, promise resolves', async () => {
    const { store, plugin, adapter, logger } = setup();
    const fsAdapter = new FileSystemAdapter();
    Object.assign(fsAdapter, adapter);
    plugin.app.vault.adapter = fsAdapter as unknown as FakeAdapter;

    const err = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    chmodMock.mockRejectedValueOnce(err);

    // Must NOT throw.
    await expect(store.save(SAMPLE_TOKENS)).resolves.toBeUndefined();

    // (a) file is on disk
    expect(adapter.files.has(EXPECTED_PATH)).toBe(true);
    // (b) warn was emitted with the stable key
    const warn = logger.warnings.find((w) => w.message === 'tokens_chmod_failed');
    expect(warn, 'expected tokens_chmod_failed warn entry').toBeDefined();
  });

  it('load() returns null and warns tokens_corrupt on malformed JSON', async () => {
    const { store, adapter, logger } = setup();
    // Truncated JSON — JSON.parse throws SyntaxError.
    adapter.files.set(EXPECTED_PATH, '{"access_token":');

    const loaded = await store.load();

    expect(loaded).toBeNull();
    const warn = logger.warnings.find((w) => w.message === 'tokens_corrupt');
    expect(warn, 'expected tokens_corrupt warn entry').toBeDefined();
  });

  it('load() returns null when on-disk JSON is missing required fields', async () => {
    const { store, adapter, logger } = setup();
    // Valid JSON, but missing refresh_token/expires_at/email — toTokens rejects.
    adapter.files.set(
      EXPECTED_PATH,
      JSON.stringify({ access_token: 'sl.u.partial' }),
    );

    const loaded = await store.load();

    expect(loaded).toBeNull();
    // toTokens rejection logs nothing itself — we want a stable warn too.
    // Current impl returns null silently when toTokens fails inside the try
    // block; assert at least one warn key is emitted so partial files surface
    // in ops logs.
    const warn = logger.warnings.find(
      (w) => w.message === 'tokens_corrupt' || w.message === 'tokens_load_failed',
    );
    expect(warn, 'expected a warn entry for partial tokens on disk').toBeDefined();
  });

  it('save() on mobile does NOT call fs.chmod (regression guard)', async () => {
    const { store, plugin, adapter } = setup();
    // Flip to mobile BEFORE the save call.
    obsidianMock.Platform.isDesktopApp = false;

    // Even with a FileSystemAdapter-shaped adapter, mobile must short-circuit.
    const fsAdapter = new FileSystemAdapter();
    Object.assign(fsAdapter, adapter);
    plugin.app.vault.adapter = fsAdapter as unknown as FakeAdapter;

    await store.save(SAMPLE_TOKENS);

    expect(chmodMock).not.toHaveBeenCalled();
    // And the file still lands on disk.
    expect(adapter.files.has(EXPECTED_PATH)).toBe(true);
  });

  it('save() on desktop with non-FileSystemAdapter skips chmod but still succeeds', async () => {
    // Platform.isDesktopApp is true by default from beforeEach.
    const { store, adapter } = setup();
    // Adapter is a plain object — NOT `instanceof FileSystemAdapter`.

    await expect(store.save(SAMPLE_TOKENS)).resolves.toBeUndefined();

    expect(chmodMock).not.toHaveBeenCalled();
    expect(adapter.files.has(EXPECTED_PATH)).toBe(true);
  });

  it('isAccessTokenNearExpiry at exactly now+threshold returns true (boundary)', () => {
    const { store } = setup();

    const now = new Date('2026-04-23T12:00:00.000Z');
    const tokens: Tokens = {
      ...SAMPLE_TOKENS,
      // Pin behavior: <= (inclusive of the boundary) → true.
      access_token_expires_at: '2026-04-23T12:01:00.000Z',
    };

    expect(store.isAccessTokenNearExpiry(tokens, 60, () => now)).toBe(true);
  });

  it('clear() on missing file does not throw and warns', async () => {
    const { store, adapter, logger } = setup();
    // No save() beforehand — tokens.json does not exist.
    expect(adapter.files.has(EXPECTED_PATH)).toBe(false);

    await expect(store.clear()).resolves.toBeUndefined();

    const warn = logger.warnings.find((w) => w.message === 'tokens_clear_failed');
    expect(warn, 'expected tokens_clear_failed warn entry').toBeDefined();
  });
});
