// PluginStore — durable storage for settings, index, and event queue.
//
// Storage layout (ADR-7, ADR-11):
//   data.json              → plugin.loadData/saveData (Obsidian-managed, Sync-eligible)
//   index.json             → adapter.write at <plugin-data-dir>/index.json (NOT synced)
//   pending_changes.json   → adapter.write at <plugin-data-dir>/pending_changes.json (NOT synced)
//
// ROB-003: adapter.write calls are serialized through a per-instance writeQueue
// promise chain so concurrent saves never interleave partial JSON.
//
// SCHEMA_INCOMPATIBLE (future plugin wrote data.json) propagates to the caller —
// the UI layer shows "upgrade the plugin". All other load errors fall back to
// safe defaults and log a warning.

import type { Plugin } from 'obsidian';
import type { Logger } from './Logger';
import { ConfigError } from '../model/Errors';
import { DEFAULT_SETTINGS, parseSettings } from '../model/Settings';
import type { PluginSettings } from '../model/Settings';
import { isLocalIndex, parseLocalIndex } from '../model/Index';
import type { LocalIndex } from '../model/Index';
import { emptyEventQueue, isEventQueue, parseEventQueue } from '../model/QueueEntry';
import type { EventQueue } from '../model/QueueEntry';

const INDEX_FILENAME = 'index.json';
const QUEUE_FILENAME = 'pending_changes.json';
const DATA_BAK_FILENAME = 'data.json.bak';

export class PluginStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly plugin: Plugin,
    private readonly logger: Logger,
  ) {}

  // ---- Path resolution -------------------------------------------------------

  private get pluginDataDir(): string {
    return (
      this.plugin.manifest.dir ??
      `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`
    );
  }

  // ---- Write serialization (ROB-003) -----------------------------------------

  private enqueueWrite(path: string, data: string): Promise<void> {
    const next = this.writeQueue.then(() =>
      this.plugin.app.vault.adapter.write(path, data),
    );
    // Chain advances on `recovered` (rejection neutralized) so a failed write
    // does not poison later writes. Caller still sees the raw rejection on `next`.
    const recovered = next.catch(() => undefined);
    this.writeQueue = recovered;
    return next;
  }

  // ---- Settings (data.json via Obsidian) -------------------------------------

  async loadSettings(): Promise<PluginSettings> {
    const raw: unknown = await this.plugin.loadData();
    if (raw === null || raw === undefined) return DEFAULT_SETTINGS;

    const blob = raw as Record<string, unknown>;
    const settingsField = blob.settings;
    const settingsObj: Record<string, unknown> =
      typeof settingsField === 'object' && settingsField !== null && !Array.isArray(settingsField)
        ? (settingsField as Record<string, unknown>)
        : {};

    // Wrap blob in schema_version context that parseSettings expects.
    // The top-level blob contains schema_version; settings sub-object does not.
    const parseTarget: Record<string, unknown> = {
      schema_version: blob.schema_version,
      ...settingsObj,
    };

    try {
      const { settings } = parseSettings(parseTarget);
      return settings;
    } catch (err) {
      if (err instanceof ConfigError && err.code === 'SCHEMA_INCOMPATIBLE') {
        throw err;
      }
      // Corrupt or unrecognized — preserve .bak and fall back to defaults
      this.logger.warn('settings_corrupt', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
      // data.json.bak is written directly (not via writeQueue) — it targets a
      // dedicated filename that no other method writes, so no same-path race
      // is possible. The await keeps loadSettings() from resolving before the
      // bak lands.
      await this.plugin.app.vault.adapter.write(
        `${this.pluginDataDir}/${DATA_BAK_FILENAME}`,
        JSON.stringify(raw, null, 2),
      );
      return DEFAULT_SETTINGS;
    }
  }

  async saveSettings(settings: PluginSettings): Promise<void> {
    const existing = (await this.plugin.loadData()) as Record<string, unknown> | null;
    const blob: Record<string, unknown> = {
      schema_version: settings.schema_version,
      ...(existing ? { device: existing.device, ui: existing.ui } : {}),
      settings,
    };
    await this.plugin.saveData(blob);
  }

  // ---- Index (index.json via adapter) ----------------------------------------

  async loadIndex(): Promise<LocalIndex | null> {
    const path = `${this.pluginDataDir}/${INDEX_FILENAME}`;
    const adapter = this.plugin.app.vault.adapter;
    try {
      const exists = await adapter.exists(path);
      if (!exists) return null;
      const raw: unknown = JSON.parse(await adapter.read(path));
      if (!isLocalIndex(raw)) {
        parseLocalIndex(raw); // throws ConfigError with field detail
      }
      return raw as LocalIndex;
    } catch (err) {
      this.logger.warn('index_corrupt', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return null;
    }
  }

  async saveIndex(index: LocalIndex): Promise<void> {
    const path = `${this.pluginDataDir}/${INDEX_FILENAME}`;
    return this.enqueueWrite(path, JSON.stringify(index, null, 2));
  }

  // ---- Queue (pending_changes.json via adapter) -------------------------------

  async loadQueue(): Promise<EventQueue> {
    const path = `${this.pluginDataDir}/${QUEUE_FILENAME}`;
    const adapter = this.plugin.app.vault.adapter;
    try {
      const exists = await adapter.exists(path);
      if (!exists) return emptyEventQueue();
      const raw: unknown = JSON.parse(await adapter.read(path));
      if (!isEventQueue(raw)) {
        parseEventQueue(raw); // throws ConfigError with field detail
      }
      return raw as EventQueue;
    } catch (err) {
      this.logger.warn('queue_corrupt', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return emptyEventQueue();
    }
  }

  async saveQueue(queue: EventQueue): Promise<void> {
    const path = `${this.pluginDataDir}/${QUEUE_FILENAME}`;
    return this.enqueueWrite(path, JSON.stringify(queue, null, 2));
  }
}
