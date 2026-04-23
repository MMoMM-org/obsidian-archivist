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

import { FileSystemAdapter } from '../fixtures/obsidian-mock';
import { createLogger, type Logger } from '../../src/infra/Logger';
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

function silentLogger(): Logger {
  return createLogger(() => false, {
    sink: { log: () => {}, warn: () => {}, error: () => {} },
  });
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('save() persists tokens via adapter.write with exact 4-field shape', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const store = new TokenStore(plugin as never, silentLogger());

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
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const store = new TokenStore(plugin as never, silentLogger());

    await store.save(SAMPLE_TOKENS);
    const loaded = await store.load();

    expect(loaded).toEqual(SAMPLE_TOKENS);
  });

  it('load() returns null when tokens.json missing', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const store = new TokenStore(plugin as never, silentLogger());

    const loaded = await store.load();
    expect(loaded).toBeNull();
  });

  it('clear() calls adapter.remove', async () => {
    const adapter = makeFakeAdapter();
    const removeSpy = vi.spyOn(adapter, 'remove');
    const plugin = makePlugin(adapter);
    const store = new TokenStore(plugin as never, silentLogger());

    await store.save(SAMPLE_TOKENS);
    await store.clear();

    expect(removeSpy).toHaveBeenCalledWith(EXPECTED_PATH);
    expect(adapter.files.has(EXPECTED_PATH)).toBe(false);
  });

  it('chmod 0o600 applied to tokens.json on desktop', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    // Swap in a FileSystemAdapter so the desktop chmod branch fires.
    const fsAdapter = new FileSystemAdapter();
    // Attach the adapter-surface methods onto the FileSystemAdapter instance
    // so it quacks like both.
    Object.assign(fsAdapter, adapter);
    plugin.app.vault.adapter = fsAdapter as unknown as FakeAdapter;

    const store = new TokenStore(plugin as never, silentLogger());
    await store.save(SAMPLE_TOKENS);

    expect(chmodMock).toHaveBeenCalledTimes(1);
    const [absPath, mode] = chmodMock.mock.calls[0]!;
    expect(absPath.endsWith('tokens.json')).toBe(true);
    expect((mode as number) & 0o777).toBe(0o600);
  });

  it('tokens.json does NOT appear in data.json contents', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const store = new TokenStore(plugin as never, silentLogger());

    await store.save(SAMPLE_TOKENS);
    const dataJson = await plugin.loadData();

    // loadData() must still reflect whatever Obsidian manages — NOT our tokens.
    const serialized = JSON.stringify(dataJson ?? {});
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');
  });

  it('isAccessTokenNearExpiry(60) returns true when expiry <= now + 60s', () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const store = new TokenStore(plugin as never, silentLogger());

    const now = new Date('2026-04-23T12:00:00.000Z');
    const tokens: Tokens = {
      ...SAMPLE_TOKENS,
      // expires 30s from "now" — well inside the 60s threshold
      access_token_expires_at: '2026-04-23T12:00:30.000Z',
    };

    expect(store.isAccessTokenNearExpiry(tokens, 60, () => now)).toBe(true);
  });

  it('isAccessTokenNearExpiry(60) returns false when expiry > now + 60s', () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const store = new TokenStore(plugin as never, silentLogger());

    const now = new Date('2026-04-23T12:00:00.000Z');
    const tokens: Tokens = {
      ...SAMPLE_TOKENS,
      // expires 10 minutes from "now" — comfortably outside threshold
      access_token_expires_at: '2026-04-23T12:10:00.000Z',
    };

    expect(store.isAccessTokenNearExpiry(tokens, 60, () => now)).toBe(false);
  });
});
