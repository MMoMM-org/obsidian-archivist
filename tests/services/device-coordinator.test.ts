// T5.1 — DeviceCoordinator: device identity, ownership, HEAD conflict detection.
//
// Test coverage:
//   - getOrCreateDeviceId: generates UUIDv4 on first call, persists, stable on reload
//   - isActiveOwner: reflects data.json.device.designated
//   - takeOwnership / releaseOwnership: pure data.json mutation, zero Dropbox calls
//   - verifyNoConflict: fresh folder (PathError → OK)
//   - verifyNoConflict: HEAD matches own device_id → OK
//   - verifyNoConflict: HEAD different device, older than window → OK
//   - verifyNoConflict: HEAD different device, within window → throws ConflictError
//   - verifyNoConflict SEC-M4: missing schema_version → OK + head_invalid warn
//   - verifyNoConflict SEC-M4: unknown schema_version → OK + head_invalid warn
//   - verifyNoConflict SEC-M4: malformed snapshot_id → OK + head_invalid warn
//   - verifyNoConflict SEC-M4: malformed device_id → OK + head_invalid warn
//   - verifyNoConflict SEC-M4: committed_at in future beyond clock-skew → OK + head_invalid warn
//   - verifyNoConflict SEC-M4: committed_at malformed string → OK + head_invalid warn
//   - verifyNoConflict: NetworkError from downloadJson propagates

import { describe, expect, it, vi } from 'vitest';
import { PluginStore } from '../../src/infra/PluginStore';
import { DeviceCoordinator } from '../../src/services/DeviceCoordinator';
import type { Logger } from '../../src/infra/Logger';
import type { DropboxClient } from '../../src/infra/DropboxClient';
import { ConflictError, NetworkError, PathError } from '../../src/model/Errors';

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
    manifest: { id: 'obsidian-archivist', dir: '.obsidian/plugins/obsidian-archivist' },
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

type WarnCapture = { message: string; payload?: Record<string, unknown> };

function makeLogger(): Logger & { warnCalls: WarnCapture[] } {
  const warnCalls: WarnCapture[] = [];
  return {
    info: vi.fn(),
    warn: vi.fn((message: string, payload?: Record<string, unknown>) => {
      warnCalls.push({ message, payload });
    }),
    error: vi.fn(),
    warnCalls,
  };
}

// Valid HEAD shape for a given device_id and committed_at.
function makeValidHead(deviceId: string, committedAt: string): Record<string, unknown> {
  return {
    schema_version: '1.0',
    snapshot_id: '2026-04-24T10-30-full',
    snapshot_type: 'full',
    device_id: deviceId,
    committed_at: committedAt,
  };
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A valid UUIDv4 for "other device" tests.
const OTHER_DEVICE_ID = 'b47ac10b-58cc-4372-a567-0e02b2c3d479';

// Injectable fake DropboxClient — only downloadJson is needed.
function makeFakeDropbox(
  headPayload: unknown | 'not-found' | Error,
): DropboxClient {
  return {
    downloadJson: vi.fn(async (_path: string) => {
      if (headPayload === 'not-found') {
        throw new PathError('PATH_NOT_FOUND', 'path/not_found', false);
      }
      if (headPayload instanceof Error) {
        throw headPayload;
      }
      return headPayload;
    }),
  } as unknown as DropboxClient;
}

// Create a coordinator backed by a fresh PluginStore.
function makeCoordinator(
  dropbox: DropboxClient,
  logger: ReturnType<typeof makeLogger>,
  opts?: {
    now?: () => number;
    plugin?: FakePlugin;
    adapter?: FakeAdapter;
  },
): { coordinator: DeviceCoordinator; plugin: FakePlugin } {
  const adapter = opts?.adapter ?? makeFakeAdapter();
  const plugin = opts?.plugin ?? makePlugin(adapter);
  const store = new PluginStore(plugin as never, logger);
  const coordinator = new DeviceCoordinator({
    pluginStore: store,
    dropbox,
    logger,
    vaultPrefix: 'test-vault',
    now: opts?.now,
  });
  return { coordinator, plugin };
}

// ---------------------------------------------------------------------------
// Tests: getOrCreateDeviceId
// ---------------------------------------------------------------------------

describe('DeviceCoordinator.getOrCreateDeviceId', () => {
  it('generates a UUIDv4 on first call', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const { coordinator } = makeCoordinator(dropbox, logger);

    const id = await coordinator.getOrCreateDeviceId();

    expect(id).toMatch(UUID_V4_REGEX);
  });

  it('persists device_id to data.json', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const { coordinator } = makeCoordinator(dropbox, logger, { plugin, adapter });

    await coordinator.getOrCreateDeviceId();

    const saved = plugin._data as Record<string, unknown>;
    expect(saved).not.toBeNull();
    const device = saved.device as Record<string, unknown>;
    expect(device.device_id).toMatch(UUID_V4_REGEX);
  });

  it('returns the same value on subsequent calls', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const { coordinator } = makeCoordinator(dropbox, logger);

    const first = await coordinator.getOrCreateDeviceId();
    const second = await coordinator.getOrCreateDeviceId();

    expect(first).toBe(second);
  });

  it('survives PluginStore reload — new instance sees the same device_id', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const { coordinator: first } = makeCoordinator(dropbox, logger, { plugin, adapter });

    const originalId = await first.getOrCreateDeviceId();

    // Create a second coordinator over the same plugin state.
    const { coordinator: second } = makeCoordinator(dropbox, logger, { plugin, adapter });
    const reloadedId = await second.getOrCreateDeviceId();

    expect(reloadedId).toBe(originalId);
  });

  it('logs device_id_generated on first call', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const { coordinator } = makeCoordinator(dropbox, logger);

    await coordinator.getOrCreateDeviceId();

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const found = infoCalls.some((call) => call[0] === "device_id_generated");
    expect(found, 'expected device_id_generated info log').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: isActiveOwner
// ---------------------------------------------------------------------------

describe('DeviceCoordinator.isActiveOwner', () => {
  it('returns false by default (designated not set)', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const { coordinator } = makeCoordinator(dropbox, logger);

    const result = await coordinator.isActiveOwner();

    expect(result).toBe(false);
  });

  it('returns true after takeOwnership', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const { coordinator } = makeCoordinator(dropbox, logger);

    await coordinator.takeOwnership();
    const result = await coordinator.isActiveOwner();

    expect(result).toBe(true);
  });

  it('returns false after releaseOwnership', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const { coordinator } = makeCoordinator(dropbox, logger);

    await coordinator.takeOwnership();
    await coordinator.releaseOwnership();
    const result = await coordinator.isActiveOwner();

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: takeOwnership / releaseOwnership (pure mutation, no Dropbox calls)
// ---------------------------------------------------------------------------

describe('DeviceCoordinator.takeOwnership / releaseOwnership', () => {
  it('takeOwnership makes no Dropbox calls', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const downloadSpy = vi.spyOn(dropbox, 'downloadJson');
    const { coordinator } = makeCoordinator(dropbox, logger);

    await coordinator.takeOwnership();

    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it('releaseOwnership makes no Dropbox calls', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const downloadSpy = vi.spyOn(dropbox, 'downloadJson');
    const { coordinator } = makeCoordinator(dropbox, logger);

    await coordinator.takeOwnership();
    await coordinator.releaseOwnership();

    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it('takeOwnership persists designated=true and updates label', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const { coordinator } = makeCoordinator(dropbox, logger, { plugin, adapter });

    await coordinator.takeOwnership('My Mac');

    const saved = plugin._data as Record<string, unknown>;
    const device = saved.device as Record<string, unknown>;
    expect(device.designated).toBe(true);
    expect(device.device_label).toBe('My Mac');
  });

  it('takeOwnership logs ownership_taken', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const { coordinator } = makeCoordinator(dropbox, logger);

    await coordinator.takeOwnership();

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const found = infoCalls.some((call) => call[0] === "ownership_taken");
    expect(found, 'expected ownership_taken log').toBe(true);
  });

  it('releaseOwnership persists designated=false', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const { coordinator } = makeCoordinator(dropbox, logger, { plugin, adapter });

    await coordinator.takeOwnership();
    await coordinator.releaseOwnership();

    const saved = plugin._data as Record<string, unknown>;
    const device = saved.device as Record<string, unknown>;
    expect(device.designated).toBe(false);
  });

  it('releaseOwnership logs ownership_released', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const { coordinator } = makeCoordinator(dropbox, logger);

    await coordinator.releaseOwnership();

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const found = infoCalls.some((call) => call[0] === "ownership_released");
    expect(found, 'expected ownership_released log').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: verifyNoConflict — happy paths
// ---------------------------------------------------------------------------

describe('DeviceCoordinator.verifyNoConflict — OK paths', () => {
  it('fresh folder (PathError from Dropbox) → returns void without throwing', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const { coordinator } = makeCoordinator(dropbox, logger);

    await expect(coordinator.verifyNoConflict()).resolves.toBeUndefined();
  });

  it('HEAD with same device_id → returns void', async () => {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found'); // placeholder; overwritten below
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    // Set up coordinator, grab its device_id.
    const store = new PluginStore(plugin as never, logger);
    const coordinator = new DeviceCoordinator({
      pluginStore: store,
      dropbox,
      logger,
      vaultPrefix: 'test-vault',
    });
    const myId = await coordinator.getOrCreateDeviceId();

    // Re-point to a dropbox that returns a HEAD with our own device_id.
    const head = makeValidHead(myId, new Date(Date.now() - 1000).toISOString());
    const dropbox2 = makeFakeDropbox(head);
    const coordinator2 = new DeviceCoordinator({
      pluginStore: new PluginStore(plugin as never, logger),
      dropbox: dropbox2,
      logger,
      vaultPrefix: 'test-vault',
    });

    await expect(coordinator2.verifyNoConflict()).resolves.toBeUndefined();
  });

  it('HEAD with different device, older than recentWindowHours → returns void', async () => {
    const logger = makeLogger();
    const now = Date.now();
    // Committed 3 hours ago — beyond the 2h default window.
    const committedAt = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    const head = makeValidHead(OTHER_DEVICE_ID, committedAt);
    const dropbox = makeFakeDropbox(head);
    const { coordinator } = makeCoordinator(dropbox, logger, { now: () => now });

    await expect(coordinator.verifyNoConflict()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: verifyNoConflict — conflict
// ---------------------------------------------------------------------------

describe('DeviceCoordinator.verifyNoConflict — DEVICE_CONFLICT', () => {
  it('throws ConflictError when HEAD has different device within the recency window', async () => {
    const logger = makeLogger();
    const now = Date.now();
    // Committed 30 minutes ago — well within the 2h window.
    const committedAt = new Date(now - 30 * 60 * 1000).toISOString();
    const head = makeValidHead(OTHER_DEVICE_ID, committedAt);
    const dropbox = makeFakeDropbox(head);
    const { coordinator } = makeCoordinator(dropbox, logger, { now: () => now });

    await expect(coordinator.verifyNoConflict()).rejects.toThrow(ConflictError);
  });

  it('ConflictError contains other device_id and committed_at', async () => {
    const logger = makeLogger();
    const now = Date.now();
    const committedAt = new Date(now - 30 * 60 * 1000).toISOString();
    const head = makeValidHead(OTHER_DEVICE_ID, committedAt);
    const dropbox = makeFakeDropbox(head);
    const { coordinator } = makeCoordinator(dropbox, logger, { now: () => now });

    let thrown: ConflictError | null = null;
    try {
      await coordinator.verifyNoConflict();
    } catch (e) {
      thrown = e as ConflictError;
    }

    expect(thrown).toBeInstanceOf(ConflictError);
    expect(thrown!.code).toBe('DEVICE_CONFLICT');
    expect(thrown!.message).toContain(OTHER_DEVICE_ID);
    // Spec requires the error message to include the committed_at age so the
    // UI layer (Phase 7) can surface "the other device wrote X hours ago".
    expect(thrown!.message).toMatch(/\d+(?:\.\d+)?\s*h/);
  });

  it('SEC-M4 covers snapshot_type outside {full, inc} — treated as absent', async () => {
    // Pin the "malformed enum field" branch that the validator already
    // rejects: if someone ever loosens validateHeadSchema to accept unknown
    // snapshot_type values, this test catches the regression.
    const logger = makeLogger();
    const now = Date.now();
    const committedAt = new Date(now - 60 * 60 * 1000).toISOString();
    const head = {
      ...makeValidHead(OTHER_DEVICE_ID, committedAt),
      snapshot_type: 'delta', // not 'full' or 'inc' — must be rejected
    };
    const dropbox = makeFakeDropbox(head);
    const { coordinator } = makeCoordinator(dropbox, logger, { now: () => now });

    await expect(coordinator.verifyNoConflict()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('respects custom recentWindowHours option', async () => {
    const logger = makeLogger();
    const now = Date.now();
    // 90 minutes ago — within 2h window but outside a 1h window.
    const committedAt = new Date(now - 90 * 60 * 1000).toISOString();
    const head = makeValidHead(OTHER_DEVICE_ID, committedAt);
    const dropbox = makeFakeDropbox(head);
    const { coordinator } = makeCoordinator(dropbox, logger, { now: () => now });

    // Default 2h window → conflict.
    await expect(coordinator.verifyNoConflict()).rejects.toThrow(ConflictError);

    // 1h window → no conflict (90 min is outside).
    const dropbox2 = makeFakeDropbox(head);
    const { coordinator: coord2 } = makeCoordinator(dropbox2, logger, { now: () => now });
    await expect(coord2.verifyNoConflict({ recentWindowHours: 1 })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: verifyNoConflict SEC-M4 — HEAD schema validation
// ---------------------------------------------------------------------------

describe('DeviceCoordinator.verifyNoConflict — SEC-M4 HEAD schema validation', () => {
  async function expectHeadInvalidOk(payload: unknown): Promise<WarnCapture[]> {
    const logger = makeLogger();
    const dropbox = makeFakeDropbox(payload);
    const { coordinator } = makeCoordinator(dropbox, logger);

    await expect(coordinator.verifyNoConflict()).resolves.toBeUndefined();

    const headInvalidWarns = logger.warnCalls.filter((w) => w.message === 'head_invalid');
    expect(headInvalidWarns.length, 'expected head_invalid warn').toBeGreaterThan(0);
    return headInvalidWarns;
  }

  it('missing schema_version → treats as absent, logs head_invalid', async () => {
    await expectHeadInvalidOk({
      // schema_version intentionally omitted
      snapshot_id: '2026-04-24T10-30-full',
      snapshot_type: 'full',
      device_id: OTHER_DEVICE_ID,
      committed_at: new Date(Date.now() - 1000).toISOString(),
    });
  });

  it('unknown schema_version → treats as absent, logs head_invalid', async () => {
    await expectHeadInvalidOk({
      schema_version: '99.0',
      snapshot_id: '2026-04-24T10-30-full',
      snapshot_type: 'full',
      device_id: OTHER_DEVICE_ID,
      committed_at: new Date(Date.now() - 1000).toISOString(),
    });
  });

  it('malformed snapshot_id → treats as absent, logs head_invalid', async () => {
    await expectHeadInvalidOk({
      schema_version: '1.0',
      snapshot_id: 'not-a-valid-snapshot-id',
      snapshot_type: 'full',
      device_id: OTHER_DEVICE_ID,
      committed_at: new Date(Date.now() - 1000).toISOString(),
    });
  });

  it('malformed device_id (not UUIDv4) → treats as absent, logs head_invalid', async () => {
    await expectHeadInvalidOk({
      schema_version: '1.0',
      snapshot_id: '2026-04-24T10-30-full',
      snapshot_type: 'full',
      device_id: 'not-a-uuid',
      committed_at: new Date(Date.now() - 1000).toISOString(),
    });
  });

  it('committed_at in future beyond clock-skew tolerance → treats as absent, logs head_invalid', async () => {
    // 10 minutes in the future — beyond the 5-minute maxClockSkewMinutes default.
    const futureTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await expectHeadInvalidOk({
      schema_version: '1.0',
      snapshot_id: '2026-04-24T10-30-full',
      snapshot_type: 'full',
      device_id: OTHER_DEVICE_ID,
      committed_at: futureTime,
    });
  });

  it('committed_at within clock-skew tolerance is accepted', async () => {
    // 3 minutes in the future — within the 5-minute maxClockSkewMinutes default.
    const logger = makeLogger();
    const now = Date.now();
    const nearFuture = new Date(now + 3 * 60 * 1000).toISOString();
    // Use same device so no conflict; test is purely about schema acceptance.
    const adapter = makeFakeAdapter();
    const plugin = makePlugin(adapter);
    const store = new PluginStore(plugin as never, logger);
    const tempCoord = new DeviceCoordinator({
      pluginStore: store,
      dropbox: makeFakeDropbox('not-found'),
      logger,
      vaultPrefix: 'test-vault',
      now: () => now,
    });
    const myId = await tempCoord.getOrCreateDeviceId();

    const head = makeValidHead(myId, nearFuture);
    const dropbox2 = makeFakeDropbox(head);
    const coordinator = new DeviceCoordinator({
      pluginStore: new PluginStore(plugin as never, logger),
      dropbox: dropbox2,
      logger,
      vaultPrefix: 'test-vault',
      now: () => now,
    });

    // Should resolve (same device_id → OK regardless of clock skew tolerance).
    await expect(coordinator.verifyNoConflict()).resolves.toBeUndefined();
    // No head_invalid warn for a valid HEAD.
    const headInvalidWarns = logger.warnCalls.filter((w) => w.message === 'head_invalid');
    expect(headInvalidWarns.length).toBe(0);
  });

  it('committed_at malformed (non-ISO string) → treats as absent, logs head_invalid', async () => {
    await expectHeadInvalidOk({
      schema_version: '1.0',
      snapshot_id: '2026-04-24T10-30-full',
      snapshot_type: 'full',
      device_id: OTHER_DEVICE_ID,
      committed_at: 'not-a-date',
    });
  });

  it('malformed HEAD does NOT produce ConflictError even though device differs and is recent', async () => {
    // The SEC-M4 rule: a poisoned HEAD must never block backups.
    // We set up a HEAD that would normally trigger a conflict (different device,
    // recent) but is schema-invalid. It must be treated as absent → OK.
    const logger = makeLogger();
    const now = Date.now();
    const recentCommit = new Date(now - 30 * 60 * 1000).toISOString();
    const poisonedHead = {
      schema_version: '1.0',
      snapshot_id: 'INVALID!!',   // bad snapshot_id
      snapshot_type: 'full',
      device_id: OTHER_DEVICE_ID,  // different device, would conflict
      committed_at: recentCommit,
    };
    const dropbox = makeFakeDropbox(poisonedHead);
    const { coordinator } = makeCoordinator(dropbox, logger, { now: () => now });

    await expect(coordinator.verifyNoConflict()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: verifyNoConflict — error propagation
// ---------------------------------------------------------------------------

describe('DeviceCoordinator.verifyNoConflict — error propagation', () => {
  it('NetworkError from downloadJson propagates to caller', async () => {
    const logger = makeLogger();
    const networkError = new NetworkError('SERVER_ERROR', 'Dropbox 500', true);
    const dropbox = makeFakeDropbox(networkError);
    const { coordinator } = makeCoordinator(dropbox, logger);

    await expect(coordinator.verifyNoConflict()).rejects.toThrow(NetworkError);
  });

  it('PathError with non-not-found code propagates — fresh-folder catch is narrow', async () => {
    // Only PATH_NOT_FOUND means "HEAD.json absent". A PATH_CONFLICT, BAD_REQUEST,
    // or any other PathError code is a genuine error (permission issue,
    // malformed request) and must surface to the caller — swallowing it would
    // mask real problems as "fresh folder".
    const logger = makeLogger();
    const dropbox = makeFakeDropbox(new PathError('PATH_CONFLICT', 'permission denied', false));
    const { coordinator } = makeCoordinator(dropbox, logger);

    await expect(coordinator.verifyNoConflict()).rejects.toThrow(PathError);
  });
});

// ---------------------------------------------------------------------------
// Tests: getOrCreateDeviceId — concurrency
// ---------------------------------------------------------------------------

describe('DeviceCoordinator.getOrCreateDeviceId — concurrent first-call latch', () => {
  it('two concurrent first-time callers share the same UUID (in-flight latch)', async () => {
    // Without a latch both callers read null, generate independent UUIDs,
    // both call saveDevice — last write wins but the first caller returns
    // a UUID that is now orphaned. A proper latch returns the same UUID
    // to both callers AND issues a single saveDevice write.
    const logger = makeLogger();
    const dropbox = makeFakeDropbox('not-found');
    const { coordinator, plugin } = makeCoordinator(dropbox, logger);

    const [a, b] = await Promise.all([
      coordinator.getOrCreateDeviceId(),
      coordinator.getOrCreateDeviceId(),
    ]);

    expect(a).toBe(b);
    const saved = ((plugin._data as Record<string, unknown>).device as Record<string, unknown>).device_id;
    expect(saved).toBe(a);
  });
});
