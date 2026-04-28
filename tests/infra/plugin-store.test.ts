// T4.2 — PluginStore persistence: data.json, index.json, pending_changes.json
// ADR-7 / ADR-11: index.json and pending_changes.json go through adapter.write
// directly (not Obsidian Sync); settings go through plugin.loadData/saveData.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/infra/Logger';
import { PluginStore } from '../../src/infra/PluginStore';
import { DEFAULT_SETTINGS } from '../../src/model/Settings';
import type { PluginSettings } from '../../src/model/Settings';
import type { LocalIndex } from '../../src/model/Index';
import { emptyLocalIndex } from '../../src/model/Index';
import type { EventQueue } from '../../src/model/QueueEntry';
import { emptyEventQueue } from '../../src/model/QueueEntry';
import { ConfigError } from '../../src/model/Errors';

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
  app: { vault: { adapter: FakeAdapter; configDir: string } };
  _data: unknown;
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
};

function makePlugin(adapter: FakeAdapter): FakePlugin {
  return {
    manifest: { id: 'archivist', dir: '.obsidian/plugins/archivist' },
    app: { vault: { adapter, configDir: '.obsidian' } },
    _data: null,
    async loadData() {
      return this._data;
    },
    async saveData(d: unknown) {
      this._data = d;
    },
  };
}

type TestLogger = Logger & {
  warnCalls: Array<{ message: string; payload?: Record<string, unknown> }>;
};

function makeTestLogger(): TestLogger {
  const warnCalls: Array<{ message: string; payload?: Record<string, unknown> }> = [];
  return {
    info: vi.fn(),
    warn: vi.fn((message: string, payload?: Record<string, unknown>) => {
      warnCalls.push({ message, payload });
    }),
    error: vi.fn(),
    warnCalls,
  };
}

const PLUGIN_DIR = '.obsidian/plugins/archivist';
const INDEX_PATH = `${PLUGIN_DIR}/index.json`;
const QUEUE_PATH = `${PLUGIN_DIR}/pending_changes.json`;

function makeSampleIndex(): LocalIndex {
  return {
    schema_version: '1.0',
    last_full_snapshot_id: 'snap-abc',
    last_inc_snapshot_id: null,
    last_full_commit_at: '2026-04-24T00:00:00.000Z',
    last_inc_commit_at: null,
    last_retention_at: null,
    index_missing_recovery_required: false,
    files: {},
  };
}

function makeSampleQueue(): EventQueue {
  return {
    schema_version: '1.0',
    committed_through: null,
    entries: [
      {
        id: 'e1',
        type: 'create',
        path: 'notes/foo.md',
        prev_path: null,
        observed_at: '2026-04-24T01:00:00.000Z',
      },
    ],
  };
}

function makeSampleSettings(): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    retention: { ...DEFAULT_SETTINGS.retention, daily_days: 60 },
  };
}

// ---------------------------------------------------------------------------
// Tests: loadSettings / saveSettings
// ---------------------------------------------------------------------------

describe('PluginStore.loadSettings / saveSettings', () => {
  it('returns DEFAULT_SETTINGS when loadData returns null', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    const settings = await store.loadSettings();

    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips settings through loadData/saveData', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);
    const sample = makeSampleSettings();

    await store.saveSettings(sample);
    const loaded = await store.loadSettings();

    expect(loaded).toEqual(sample);
  });

  it('preserves ui fields in data.json on saveSettings', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    // Seed data.json with ui fields via the raw plugin interface. The
    // device block lives in the device.json sidecar (not data.json) since
    // the per-device-state-must-not-sync refactor.
    plugin._data = {
      schema_version: '1.0',
      settings: DEFAULT_SETTINGS,
      ui: { predecessor_notice_dismissed: true },
    };

    await store.saveSettings(makeSampleSettings());

    const saved = plugin._data as Record<string, unknown>;
    expect(saved.ui).toEqual({ predecessor_notice_dismissed: true });
  });

  it('uses plugin.saveData (Obsidian-managed), NOT adapter.write', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);
    const writeSpy = vi.spyOn(adapter, 'write');

    await store.saveSettings(makeSampleSettings());

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('throws ConfigError(SCHEMA_INCOMPATIBLE) when stored version is newer', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    // Simulate a future plugin that wrote schema_version '9.9'
    plugin._data = {
      schema_version: '9.9',
      settings: {},
    };

    await expect(store.loadSettings()).rejects.toThrow(ConfigError);
    await expect(store.loadSettings()).rejects.toMatchObject({ code: 'SCHEMA_INCOMPATIBLE' });
  });

  it('returns DEFAULT_SETTINGS and writes .bak on corrupt JSON in data.json', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    // Simulate corrupt settings stored as invalid object (guard will fail after parse)
    plugin._data = { schema_version: '1.0', settings: 'NOT_AN_OBJECT' };

    const settings = await store.loadSettings();

    expect(settings).toEqual(DEFAULT_SETTINGS);
    const warn = logger.warnCalls.find((w) => w.message === 'settings_corrupt');
    expect(warn, 'expected settings_corrupt warn').toBeDefined();
    // .bak file should be written to plugin data dir via adapter
    const bakPath = `${PLUGIN_DIR}/data.json.bak`;
    expect(adapter.files.has(bakPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadIndex / saveIndex
// ---------------------------------------------------------------------------

describe('PluginStore.loadIndex / saveIndex', () => {
  it('round-trips index via adapter.write to index.json', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);
    const index = makeSampleIndex();

    await store.saveIndex(index);

    expect(adapter.files.has(INDEX_PATH), 'index.json must be at plugin-data path').toBe(true);
    const loaded = await store.loadIndex();
    expect(loaded).toEqual(index);
  });

  it('writes to index.json via adapter.write, NOT plugin.saveData', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);
    const saveDataSpy = vi.spyOn(plugin, 'saveData');

    await store.saveIndex(makeSampleIndex());

    expect(saveDataSpy).not.toHaveBeenCalled();
    expect(adapter.files.has(INDEX_PATH)).toBe(true);
  });

  it('returns null and warns index_corrupt on invalid JSON', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    adapter.files.set(INDEX_PATH, '{"schema_version":');

    const result = await store.loadIndex();

    expect(result).toBeNull();
    const warn = logger.warnCalls.find((w) => w.message === 'index_corrupt');
    expect(warn, 'expected index_corrupt warn').toBeDefined();
  });

  it('returns null and warns index_corrupt when schema guard fails', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    // Valid JSON, wrong schema shape
    adapter.files.set(INDEX_PATH, JSON.stringify({ schema_version: '9.9', files: {} }));

    const result = await store.loadIndex();

    expect(result).toBeNull();
    const warn = logger.warnCalls.find((w) => w.message === 'index_corrupt');
    expect(warn, 'expected index_corrupt warn on schema failure').toBeDefined();
  });

  it('returns null when index.json does not exist', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    const result = await store.loadIndex();

    expect(result).toBeNull();
    // No warn expected for missing file — that is the INDEX_MISSING flow
  });
});

// ---------------------------------------------------------------------------
// Tests: loadQueue / saveQueue
// ---------------------------------------------------------------------------

describe('PluginStore.loadQueue / saveQueue', () => {
  it('round-trips queue via adapter.write to pending_changes.json', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);
    const queue = makeSampleQueue();

    await store.saveQueue(queue);

    expect(adapter.files.has(QUEUE_PATH)).toBe(true);
    const loaded = await store.loadQueue();
    expect(loaded).toEqual(queue);
  });

  it('returns emptyEventQueue() and warns on corrupt JSON', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    adapter.files.set(QUEUE_PATH, '{"schema_version":');

    const result = await store.loadQueue();

    expect(result).toEqual(emptyEventQueue());
    const warn = logger.warnCalls.find((w) => w.message === 'queue_corrupt');
    expect(warn, 'expected queue_corrupt warn').toBeDefined();
  });

  it('returns emptyEventQueue() and warns when schema guard fails', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    adapter.files.set(QUEUE_PATH, JSON.stringify({ schema_version: '9.9', entries: [] }));

    const result = await store.loadQueue();

    expect(result).toEqual(emptyEventQueue());
    const warn = logger.warnCalls.find((w) => w.message === 'queue_corrupt');
    expect(warn, 'expected queue_corrupt warn on schema failure').toBeDefined();
  });

  it('returns emptyEventQueue() when pending_changes.json does not exist', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    const result = await store.loadQueue();

    expect(result).toEqual(emptyEventQueue());
  });

  it('writes to pending_changes.json via adapter.write, NOT plugin.saveData', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);
    const saveDataSpy = vi.spyOn(plugin, 'saveData');

    await store.saveQueue(makeSampleQueue());

    expect(saveDataSpy).not.toHaveBeenCalled();
    expect(adapter.files.has(QUEUE_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: write serialization (writeQueue)
// ---------------------------------------------------------------------------

describe('PluginStore write serialization', () => {
  it('concurrent saveIndex + saveQueue preserve both files on disk', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    const index = makeSampleIndex();
    const queue = makeSampleQueue();

    // Fire both concurrently — the writeQueue must serialize them
    await Promise.all([store.saveIndex(index), store.saveQueue(queue)]);

    const savedIndex = adapter.files.get(INDEX_PATH);
    const savedQueue = adapter.files.get(QUEUE_PATH);

    expect(savedIndex).toBeDefined();
    expect(savedQueue).toBeDefined();

    const parsedIndex = JSON.parse(savedIndex!);
    const parsedQueue = JSON.parse(savedQueue!);

    expect(parsedIndex.last_full_snapshot_id).toBe('snap-abc');
    expect(parsedQueue.entries).toHaveLength(1);
  });

  it('writeQueue does not stall after a rejected write', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    // First write fails
    const writeSpy = vi.spyOn(adapter, 'write').mockRejectedValueOnce(new Error('disk full'));

    // First save rejects
    await expect(store.saveIndex(emptyLocalIndex())).rejects.toThrow('disk full');

    // Restore write to succeed
    writeSpy.mockRestore();

    // Second save should succeed — queue must not be poisoned
    await expect(store.saveQueue(emptyEventQueue())).resolves.toBeUndefined();
    expect(adapter.files.has(QUEUE_PATH)).toBe(true);
  });

  it('same-path concurrent saves are serialized and last-writer wins (ROB-003)', async () => {
    // Target: 3 concurrent saveIndex calls on the SAME path. The writeQueue
    // must (1) prevent overlapping adapter.write invocations and (2) preserve
    // call order so the final on-disk blob matches the LAST submitted call.
    // A broken implementation (e.g. no writeQueue) would allow overlapping
    // writes and could land an arbitrary call's bytes as the final state.
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    let activeWrites = 0;
    let maxActive = 0;
    const underlyingWrite = adapter.write;
    adapter.write = async (path: string, data: string) => {
      activeWrites += 1;
      maxActive = Math.max(maxActive, activeWrites);
      // Force a macrotask boundary so a broken impl would overlap here.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      await underlyingWrite(path, data);
      activeWrites -= 1;
    };

    const indexA: LocalIndex = { ...makeSampleIndex(), last_full_snapshot_id: 'A' };
    const indexB: LocalIndex = { ...makeSampleIndex(), last_full_snapshot_id: 'B' };
    const indexC: LocalIndex = { ...makeSampleIndex(), last_full_snapshot_id: 'C' };

    await Promise.all([
      store.saveIndex(indexA),
      store.saveIndex(indexB),
      store.saveIndex(indexC),
    ]);

    expect(maxActive).toBe(1); // no overlap ever
    const saved = JSON.parse(adapter.files.get(INDEX_PATH)!);
    expect(saved.last_full_snapshot_id).toBe('C'); // last call's payload wins
  });
});

// ---------------------------------------------------------------------------
// Tests: loadSettings corruption / partial-data fallback contract
// ---------------------------------------------------------------------------

describe('PluginStore.loadSettings partial/corrupt fallback contract', () => {
  it('partially-populated data.json (missing sub-objects) is treated as corrupt — defaults returned, .bak preserved', async () => {
    // Contract: loadSettings returns DEFAULT_SETTINGS + writes data.json.bak
    // whenever the parser throws anything other than SCHEMA_INCOMPATIBLE. This
    // covers partial data (e.g. only `retention` present), malformed JSON, and
    // future subtly-broken shapes. Future schema additions must ship as
    // SETTINGS_MIGRATIONS entries — absent a migration, partial data is
    // corruption by definition.
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    plugin._data = {
      schema_version: '1.0',
      settings: {
        // Only retention is present — schedule / notifications / advanced
        // missing. isPluginSettings rejects; PluginStore falls back.
        retention: { ...DEFAULT_SETTINGS.retention, never_prune_window_days: 7 },
      },
    };

    const loaded = await store.loadSettings();
    expect(loaded).toEqual(DEFAULT_SETTINGS); // user's customization is NOT retained
    expect(adapter.files.has(`${PLUGIN_DIR}/data.json.bak`)).toBe(true);
    expect(logger.warnCalls.some((c) => c.message === 'settings_corrupt')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// device.json sidecar — per-device state lives outside data.json so
// Obsidian Sync (and other vault-folder syncers, given path exclusion of
// the plugin folder is hard to configure) cannot replicate device_id +
// designated flag across machines. Includes a one-time migration from
// the legacy data.json.device location.
// ---------------------------------------------------------------------------

describe('PluginStore device.json sidecar', () => {
  it('loadDevice returns the empty block on a fresh install', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const store = new PluginStore(plugin as never, makeTestLogger());
    const device = await store.loadDevice();
    expect(device).toEqual({ device_id: null, designated: false, device_label: '' });
  });

  it('saveDevice + loadDevice round-trip via the device.json sidecar', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const store = new PluginStore(plugin as never, makeTestLogger());

    await store.saveDevice({ device_id: 'd-1', designated: true, device_label: 'My Mac' });

    // Sidecar lives next to index.json — adapter.write was used, NOT plugin.saveData.
    expect(adapter.files.has(`${PLUGIN_DIR}/device.json`)).toBe(true);
    expect(plugin._data).toBeNull();

    const reloaded = await store.loadDevice();
    expect(reloaded).toEqual({ device_id: 'd-1', designated: true, device_label: 'My Mac' });
  });

  it('migrates legacy data.json.device into device.json on first load', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    plugin._data = {
      schema_version: '1.0',
      settings: DEFAULT_SETTINGS,
      device: { device_id: 'legacy-id', designated: true, device_label: 'Legacy Mac' },
      vault_id: '3f2a8c1e-7d4b-4f12-a1c0-bc5d76e9a2e1',
    };
    const store = new PluginStore(plugin as never, makeTestLogger());

    const device = await store.loadDevice();
    expect(device).toEqual({ device_id: 'legacy-id', designated: true, device_label: 'Legacy Mac' });

    // Sidecar now exists with the migrated content.
    const sidecar = JSON.parse(adapter.files.get(`${PLUGIN_DIR}/device.json`)!);
    expect(sidecar).toEqual({ device_id: 'legacy-id', designated: true, device_label: 'Legacy Mac' });

    // Legacy field cleared from data.json — but the rest survives.
    const data = plugin._data as Record<string, unknown>;
    expect(data.device).toBeUndefined();
    expect(data.vault_id).toBe('3f2a8c1e-7d4b-4f12-a1c0-bc5d76e9a2e1');
    expect(data.settings).toBeDefined();
  });

  it('subsequent loadDevice calls go to the sidecar — no second migration', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    plugin._data = {
      device: { device_id: 'legacy-id', designated: false, device_label: '' },
    };
    const store = new PluginStore(plugin as never, makeTestLogger());

    await store.loadDevice(); // triggers migration
    await store.loadDevice(); // hits the sidecar

    // The migration ran exactly once — even if a third party re-injected
    // device into data.json (it shouldn't), sidecar is now authoritative.
    const sidecar = JSON.parse(adapter.files.get(`${PLUGIN_DIR}/device.json`)!);
    expect(sidecar.device_id).toBe('legacy-id');
  });

  it('returns the empty block for a corrupt sidecar and warns', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    adapter.files.set(`${PLUGIN_DIR}/device.json`, '{not valid json');
    const logger = makeTestLogger();
    const store = new PluginStore(plugin as never, logger);

    const device = await store.loadDevice();
    expect(device).toEqual({ device_id: null, designated: false, device_label: '' });
    expect(logger.warnCalls.some((c) => c.message === 'device_corrupt')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// H2: data.json read-modify-write serialization. Concurrent saveSettings +
// saveVaultId must NOT lose updates — both target plugin.loadData/saveData,
// the same blob, and prior to the fix both did an unserialized
// load → mutate → save cycle.
// ---------------------------------------------------------------------------

describe('PluginStore data.json write serialization (H2)', () => {
  it('concurrent saveSettings + saveVaultId both land in data.json (no lost update)', async () => {
    // Plain plugin — no gate needed when the queue serializes correctly,
    // because the second call only reads existing AFTER the first's
    // saveData has resolved.
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    plugin._data = null;
    const store = new PluginStore(plugin as never, makeTestLogger());

    const settings = makeSampleSettings();
    const vaultId = '3f2a8c1e-7d4b-4f12-a1c0-bc5d76e9a2e1';

    // Fire concurrently — pre-fix this would race: both calls read the
    // same null `existing`, build their own blob, and the second save
    // wipes the first's field.
    const [a, b] = await Promise.allSettled([
      store.saveSettings(settings),
      store.saveVaultId(vaultId),
    ]);

    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');

    const final = plugin._data as Record<string, unknown>;
    expect(final.vault_id).toBe(vaultId);
    expect(final.settings).toMatchObject({ schema_version: settings.schema_version });
  });

  it('reverse order: saveVaultId then saveSettings still preserves vault_id', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    plugin._data = null;
    const store = new PluginStore(plugin as never, makeTestLogger());

    const settings = makeSampleSettings();
    const vaultId = '3f2a8c1e-7d4b-4f12-a1c0-bc5d76e9a2e1';

    // saveVaultId first, settings second — the existing `saveSettings`
    // already preserves vault_id when reading existing, so this case is
    // an end-to-end belt-and-braces verification.
    await Promise.all([
      store.saveVaultId(vaultId),
      store.saveSettings(settings),
    ]);

    const final = plugin._data as Record<string, unknown>;
    expect(final.vault_id).toBe(vaultId);
    expect(final.settings).toBeDefined();
  });

  it('a rejected saveSettings does not poison the dataJsonQueue', async () => {
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    plugin._data = null;
    const failingPlugin = {
      ...plugin,
      saveData: vi.fn(async (d: unknown): Promise<void> => {
        // First call rejects; subsequent calls succeed.
        if (failingPlugin.saveData.mock.calls.length === 1) {
          throw new Error('boom');
        }
        plugin._data = d;
      }),
      loadData: vi.fn(async (): Promise<unknown> => plugin._data),
    };
    const store = new PluginStore(failingPlugin as never, makeTestLogger());

    await expect(store.saveSettings(makeSampleSettings())).rejects.toThrow('boom');
    // Next call must still succeed — the queue must not be wedged on the
    // prior rejection (mirrors the writeQueue recovery pattern).
    await store.saveVaultId('3f2a8c1e-7d4b-4f12-a1c0-bc5d76e9a2e1');
    expect((plugin._data as Record<string, unknown>).vault_id).toBe(
      '3f2a8c1e-7d4b-4f12-a1c0-bc5d76e9a2e1',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: DEFAULT_SETTINGS match PRD 3-tier spec
// ---------------------------------------------------------------------------

describe('DEFAULT_SETTINGS PRD compliance', () => {
  it('matches PRD 3-tier retention defaults', () => {
    expect(DEFAULT_SETTINGS.retention.never_prune_window_days).toBe(14);
    expect(DEFAULT_SETTINGS.retention.recent_hours).toBe(24);
    expect(DEFAULT_SETTINGS.retention.daily_days).toBe(30);
    expect(DEFAULT_SETTINGS.retention.monthly_years).toBe(3);
  });

  it('has no hourly_days or weekly_months fields (3-tier MVP cut)', () => {
    const r = DEFAULT_SETTINGS.retention as unknown as Record<string, unknown>;
    expect(r['hourly_days']).toBeUndefined();
    expect(r['weekly_months']).toBeUndefined();
  });

  it('matches PRD schedule defaults', () => {
    expect(DEFAULT_SETTINGS.schedule.inc_interval_minutes).toBe(15);
    expect(DEFAULT_SETTINGS.schedule.full_cadence).toBe('weekly');
    expect(DEFAULT_SETTINGS.schedule.full_day_of_week).toBe(0);
    expect(DEFAULT_SETTINGS.schedule.full_time_of_day).toBe('03:00');
  });
});
