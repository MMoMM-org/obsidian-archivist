// Integration test harness — boots a full Archivist service graph against a
// mocked Dropbox and in-memory vault. Used by all tests under tests/integration/.
//
// Design:
//   - MockDropboxClient holds an in-memory file map and satisfies the same
//     interface surface as the real DropboxClient.
//   - createArchivistFixture() constructs ALL services directly (not via the
//     plugin's onload()) so the mock Dropbox can be wired at construction time
//     without proxy indirection.
//   - The fixture exposes helpers to drive scenarios and assert outcomes.
//   - vi.useFakeTimers() is called by individual tests that need time control;
//     the harness does not manage timers.

import type { SnapshotManifest } from '../../src/model/Manifest';
import type { SnapshotIndex, SnapshotIndexEntry } from '../../src/model/SnapshotIndex';
import { PathError, QuotaExceededError, AuthError, ConflictError } from '../../src/model/Errors';
import type { ListFolderEntry } from '../../src/infra/DropboxClient';
import type { PluginSettings } from '../../src/model/Settings';
import { DEFAULT_SETTINGS } from '../../src/model/Settings';
import type { LocalIndex } from '../../src/model/Index';
import type { EventQueue as EventQueueData } from '../../src/model/QueueEntry';
import { BackupService } from '../../src/services/BackupService';
import { DeviceCoordinator } from '../../src/services/DeviceCoordinator';
import { SnapshotIndexStore } from '../../src/services/SnapshotIndexStore';
import { RetentionService } from '../../src/services/RetentionService';
import { GCService } from '../../src/services/GCService';
import { MaintenanceScheduler } from '../../src/services/MaintenanceScheduler';
import { ManifestCache } from '../../src/services/ManifestCache';
import { RestoreService } from '../../src/services/RestoreService';
import { RestoreOperations } from '../../src/services/RestoreOperations';
import { NoticeCenter } from '../../src/ui/NoticeCenter';
import { SchedulerFSM } from '../../src/services/SchedulerFSM';
import { sha256hex } from '../../src/infra/Hasher';
import { createLogger, type Logger } from '../../src/infra/Logger';
import { App } from '../fixtures/obsidian-mock';
import { VaultAdapter } from '../../src/infra/VaultAdapter';
import { EventQueue } from '../../src/infra/EventQueue';
import type { Plugin } from 'obsidian';

// ---------------------------------------------------------------------------
// MockDropboxClient
// ---------------------------------------------------------------------------

export type DropboxError = PathError | QuotaExceededError | AuthError | ConflictError | Error;

export interface DropboxNextError {
  op: string;
  error: DropboxError;
}

export class MockDropboxClient {
  readonly store = new Map<string, Uint8Array>();
  readonly nextErrors: DropboxNextError[] = [];
  readonly uploadLog: string[] = [];
  readonly deleteLog: string[] = [];
  readonly downloadLog: string[] = [];

  constructor(opts?: {
    files?: Map<string, Uint8Array>;
    nextErrors?: DropboxNextError[];
  }) {
    if (opts?.files) {
      for (const [k, v] of opts.files) this.store.set(k, v);
    }
    if (opts?.nextErrors) {
      this.nextErrors.push(...opts.nextErrors);
    }
  }

  private maybeThrow(op: string): void {
    const idx = this.nextErrors.findIndex((e) => e.op === op || e.op === '*');
    if (idx === -1) return;
    const { error } = this.nextErrors.splice(idx, 1)[0];
    throw error;
  }

  async uploadBlob(path: string, bytes: Uint8Array): Promise<void> {
    this.maybeThrow('uploadBlob');
    this.store.set(path, bytes);
    this.uploadLog.push(path);
  }

  async uploadJson(path: string, value: unknown): Promise<void> {
    this.maybeThrow('uploadJson');
    this.store.set(path, new TextEncoder().encode(JSON.stringify(value)));
    this.uploadLog.push(path);
  }

  async downloadBytes(path: string): Promise<Uint8Array> {
    this.maybeThrow('downloadBytes');
    this.downloadLog.push(path);
    const bytes = this.store.get(path);
    if (!bytes) throw new PathError('PATH_NOT_FOUND', `Not found: ${path}`, false);
    return bytes;
  }

  async downloadJson<T>(path: string): Promise<T> {
    this.maybeThrow('downloadJson');
    this.downloadLog.push(path);
    const bytes = this.store.get(path);
    if (!bytes) throw new PathError('PATH_NOT_FOUND', `Not found: ${path}`, false);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  async listFolder(path: string, _opts?: { recursive?: boolean }): Promise<ListFolderEntry[]> {
    this.maybeThrow('listFolder');
    const prefix = path.endsWith('/') ? path : path + '/';
    const entries: ListFolderEntry[] = [];
    for (const [key, val] of this.store) {
      if (key.startsWith(prefix)) {
        entries.push({ path: key, tag: 'file', size: val.length });
      }
    }
    return entries;
  }

  async deleteV2(path: string): Promise<void> {
    this.maybeThrow('deleteV2');
    if (!this.store.delete(path)) {
      throw new PathError('PATH_NOT_FOUND', `Not found: ${path}`, false);
    }
    this.deleteLog.push(path);
  }

  async uploadLarge(path: string, bytes: Uint8Array): Promise<void> {
    return this.uploadBlob(path, bytes);
  }

  seedJson(path: string, value: unknown): void {
    this.store.set(path, new TextEncoder().encode(JSON.stringify(value)));
  }

  readJson<T>(path: string): T | null {
    const bytes = this.store.get(path);
    if (!bytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }
}

// ---------------------------------------------------------------------------
// InMemoryPluginStore — replaces PluginStore for harness tests
// ---------------------------------------------------------------------------

export class InMemoryPluginStore {
  settings: PluginSettings;
  index: LocalIndex | null = null;
  queue: EventQueueData = { schema_version: '1.0', committed_through: null, entries: [] };

  // DeviceCoordinator accesses pluginStore['plugin'].loadData/saveData directly
  // to read/write the device block stored in data.json.
  private dataBlob: Record<string, unknown> = {};
  readonly plugin = {
    loadData: async (): Promise<Record<string, unknown>> => this.dataBlob,
    saveData: async (blob: Record<string, unknown>): Promise<void> => { this.dataBlob = blob; },
  };

  constructor(settings?: Partial<PluginSettings>) {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...settings,
      advanced: { ...DEFAULT_SETTINGS.advanced, ...(settings?.advanced ?? {}) },
      schedule: { ...DEFAULT_SETTINGS.schedule, ...(settings?.schedule ?? {}) },
    };
  }

  async loadSettings(): Promise<PluginSettings> { return this.settings; }
  async saveSettings(s: PluginSettings): Promise<void> { this.settings = s; }
  async loadIndex(): Promise<LocalIndex | null> { return this.index; }
  async saveIndex(index: LocalIndex): Promise<void> { this.index = index; }
  async loadQueue(): Promise<EventQueueData> { return this.queue; }
  async saveQueue(q: EventQueueData): Promise<void> { this.queue = q; }
}

// ---------------------------------------------------------------------------
// InMemoryVault — replaces VaultAdapter for harness tests
// ---------------------------------------------------------------------------

export class InMemoryVaultAdapter {
  private readonly files = new Map<string, { hash?: string; content: Uint8Array; mtime: number; size: number }>();

  seedFile(path: string, content: string, mtime?: number): void {
    const bytes = new TextEncoder().encode(content);
    this.files.set(path, {
      content: bytes,
      mtime: mtime ?? Date.now(),
      size: bytes.length,
    });
  }

  removeFile(path: string): void { this.files.delete(path); }

  renameFile(from: string, to: string): void {
    const f = this.files.get(from);
    if (f) {
      this.files.set(to, f);
      this.files.delete(from);
    }
  }

  editFile(path: string, content: string): void {
    const bytes = new TextEncoder().encode(content);
    this.files.set(path, { content: bytes, mtime: Date.now(), size: bytes.length });
  }

  // VaultAdapter surface
  getFiles(): Array<{ path: string; mtime: number; size: number }> {
    return Array.from(this.files.entries()).map(([path, f]) => ({
      path,
      mtime: f.mtime,
      size: f.size,
    }));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f.content;
  }

  async stat(path: string): Promise<{ mtime: number; size: number } | null> {
    const f = this.files.get(path);
    return f ? { mtime: f.mtime, size: f.size } : null;
  }

  async writeAtomic(_path: string, _bytes: Uint8Array): Promise<void> {
    // In tests we accept writes but don't validate
  }

  hasPath(path: string): boolean { return this.files.has(path); }
}

// ---------------------------------------------------------------------------
// Fixture config + types
// ---------------------------------------------------------------------------

export interface FixtureConfig {
  vaultName?: string;
  vaultPrefix?: string;
  designated?: boolean;
  initialFiles?: Array<{ path: string; content: string }>;
  dropbox?: {
    files?: Map<string, Uint8Array>;
    nextErrors?: DropboxNextError[];
  };
  settings?: Partial<PluginSettings>;
  now?: () => number;
}

export interface Fixture {
  // Core services
  backupService: BackupService;
  restoreService: RestoreService;
  manifestCache: ManifestCache;
  noticeCenter: NoticeCenter;
  fsm: SchedulerFSM;
  retentionService: RetentionService;
  gcService: GCService;
  maintenanceScheduler: MaintenanceScheduler;
  deviceCoordinator: DeviceCoordinator;
  snapshotIndexStore: SnapshotIndexStore;
  // Infra
  mockDropbox: MockDropboxClient;
  pluginStore: InMemoryPluginStore;
  vault: InMemoryVaultAdapter;
  logger: Logger;
  // Helpers
  editFile(path: string, content: string): void;
  addFile(path: string, content: string): void;
  deleteFile(path: string): void;
  renameFile(from: string, to: string): void;
  triggerFull(): Promise<void>;
  triggerInc(): Promise<void>;
  // Path helpers for Dropbox assertions
  paths: {
    head(): string;
    snapshotIndex(): string;
    snapshot(id: string): string;
    content(hash: string): string;
    gcLock(): string;
    contentFolder(): string;
  };
}

// ---------------------------------------------------------------------------
// createArchivistFixture
// ---------------------------------------------------------------------------

export function createArchivistFixture(config: FixtureConfig = {}): Fixture {
  const vaultName = config.vaultName ?? 'test-vault';
  const vaultPrefix = config.vaultPrefix ?? 'test-vault';

  const pluginStore = new InMemoryPluginStore({
    ...config.settings,
    advanced: {
      ...DEFAULT_SETTINGS.advanced,
      vault_prefix: vaultPrefix,
      ...(config.settings?.advanced ?? {}),
    },
  });

  const vault = new InMemoryVaultAdapter();
  for (const f of config.initialFiles ?? []) {
    vault.seedFile(f.path, f.content);
  }

  const mockDropbox = new MockDropboxClient(config.dropbox);
  const logger = createLogger(() => false);

  const deviceCoordinator = new DeviceCoordinator({
    pluginStore: pluginStore as unknown as Parameters<typeof DeviceCoordinator>[0]['pluginStore'],
    dropbox: mockDropbox as unknown as Parameters<typeof DeviceCoordinator>[0]['dropbox'],
    logger,
    vaultPrefix,
    // Default to 'no conflict' (fresh folder) unless a HEAD is seeded in mockDropbox
  });

  const snapshotIndexStore = new SnapshotIndexStore({
    dropbox: mockDropbox as unknown as Parameters<typeof SnapshotIndexStore>[0]['dropbox'],
    vaultPrefix,
  });

  const backupService = new BackupService({
    dropbox: mockDropbox as unknown as Parameters<typeof BackupService>[0]['dropbox'],
    vault: vault as unknown as Parameters<typeof BackupService>[0]['vault'],
    hasher: sha256hex,
    deviceCoordinator,
    pluginStore: pluginStore as unknown as Parameters<typeof BackupService>[0]['pluginStore'],
    snapshotIndexStore,
    vaultPrefix,
    vaultName,
  });

  const gcService = new GCService({
    dropbox: mockDropbox as unknown as Parameters<typeof GCService>[0]['dropbox'],
    snapshotIndexStore,
    logger,
    vaultPrefix,
    deviceId: 'test-device',
  });

  const retentionService = new RetentionService({
    dropbox: mockDropbox as unknown as Parameters<typeof RetentionService>[0]['dropbox'],
    pluginStore: pluginStore as unknown as Parameters<typeof RetentionService>[0]['pluginStore'],
    snapshotIndexStore,
    logger,
    vaultPrefix,
    triggerGcSweep: () => {
      void gcService.sweep().catch(() => {});
    },
  });

  const maintenanceScheduler = new MaintenanceScheduler({
    runRetention: async () => { await retentionService.runIfDue(); },
    loadIndex: async () => {
      const idx = await pluginStore.loadIndex();
      return idx ?? emptyIndex();
    },
    saveIndex: (idx) => pluginStore.saveIndex(idx),
    logger,
  });

  const manifestCache = new ManifestCache({
    dropbox: mockDropbox as unknown as Parameters<typeof ManifestCache>[0]['dropbox'],
    vaultPrefix,
    logger,
  });

  const restoreService = new RestoreService({
    loader: manifestCache,
    dropbox: mockDropbox as unknown as Parameters<typeof RestoreService>[0]['dropbox'],
    logger,
  });

  const restoreOperations = new RestoreOperations({
    restoreService,
    loader: manifestCache,
    vault: vault as unknown as Parameters<typeof RestoreOperations>[0]['vault'],
    logger,
  });
  void restoreOperations;

  const noticeCenter = new NoticeCenter({
    getSettings: () => pluginStore.settings.notifications,
    notify: () => {},
    logger,
  });

  const lastCommit: { inc: number | null; full: number | null } = { inc: null, full: null };

  const fsm = new SchedulerFSM({
    schedule: pluginStore.settings.schedule,
    isDesignated: () => config.designated ?? true,
    getQueueSize: () => pluginStore.queue.entries.length,
    getLastIncCommitAt: () => lastCommit.inc,
    getLastFullCommitAt: () => lastCommit.full,
    preflightHost: noticeCenter,
    logger,
  });

  const root = `${vaultPrefix}`;
  const paths: Fixture['paths'] = {
    head: () => `${root}/HEAD.json`,
    snapshotIndex: () => `${root}/snapshot_index.json`,
    snapshot: (id) => `${root}/snapshots/${id}.json`,
    content: (hash) => `${root}/content/${hash.slice(0, 2)}/${hash}`,
    gcLock: () => `${root}/gc_lock`,
    contentFolder: () => `${root}/content`,
  };

  return {
    backupService,
    restoreService,
    manifestCache,
    noticeCenter,
    fsm,
    retentionService,
    gcService,
    maintenanceScheduler,
    deviceCoordinator,
    snapshotIndexStore,
    mockDropbox,
    pluginStore,
    vault,
    logger,

    editFile(path: string, content: string) {
      vault.editFile(path, content);
    },

    addFile(path: string, content: string) {
      vault.seedFile(path, content);
    },

    deleteFile(path: string) {
      vault.removeFile(path);
      // Add delete queue entry
      const ts = new Date().toISOString();
      pluginStore.queue.entries.push({
        id: crypto.randomUUID(),
        type: 'delete',
        path,
        prev_path: null,
        observed_at: ts,
      });
    },

    renameFile(from: string, to: string) {
      vault.renameFile(from, to);
      const ts = new Date().toISOString();
      pluginStore.queue.entries.push({
        id: crypto.randomUUID(),
        type: 'rename',
        path: to,
        prev_path: from,
        observed_at: ts,
      });
    },

    async triggerFull() {
      await backupService.runFull();
      const now = Date.now();
      lastCommit.full = now;
      lastCommit.inc = null;
      manifestCache.invalidate();
    },

    async triggerInc() {
      await backupService.runIncremental();
      lastCommit.inc = Date.now();
      manifestCache.invalidate();
    },

    paths,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyIndex(): LocalIndex {
  return {
    schema_version: '1.0',
    last_full_snapshot_id: null,
    last_full_commit_at: null,
    last_inc_snapshot_id: null,
    last_inc_commit_at: null,
    last_retention_at: null,
    index_missing_recovery_required: false,
    files: {},
  };
}

// Re-export types commonly used in tests
export type { SnapshotManifest, SnapshotIndex, SnapshotIndexEntry };
export { PathError, QuotaExceededError, AuthError, ConflictError };
