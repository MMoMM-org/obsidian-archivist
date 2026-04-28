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
  /**
   * Separate serialization chain for `data.json` updates. Both
   * saveSettings and saveVaultId do a load-modify-save against the same
   * Obsidian-managed file via `plugin.loadData()` / `plugin.saveData()`,
   * so two concurrent calls would otherwise read the same stale blob and
   * the second writer would silently drop the first writer's changes
   * (e.g. settings update racing with vault-id adoption — a known
   * lost-update scenario, H2 from the post-V1 review).
   */
  private dataJsonQueue: Promise<void> = Promise.resolve();

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

  /**
   * Serialize a `data.json` read-modify-write through the dedicated
   * dataJsonQueue. The updater runs inside the critical section: it
   * receives the freshly-loaded blob and returns the blob to persist.
   * Two concurrent calls execute strictly sequentially so the second
   * always sees the first's committed state.
   */
  private enqueueDataJsonUpdate(
    updater: (existing: Record<string, unknown> | null) => Record<string, unknown>,
  ): Promise<void> {
    const next = this.dataJsonQueue.then(async () => {
      const existing = (await this.plugin.loadData()) as Record<string, unknown> | null;
      const blob = updater(existing);
      await this.plugin.saveData(blob);
    });
    const recovered = next.catch(() => undefined);
    this.dataJsonQueue = recovered;
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
    return this.enqueueDataJsonUpdate((existing) => ({
      schema_version: settings.schema_version,
      ...(existing
        ? {
            device: existing.device,
            ui: existing.ui,
            // Preserve top-level vault_id (set by VaultIdentity); without
            // this entry, calling saveSettings would silently drop it on
            // every settings update, undoing the adoption work.
            ...(typeof existing.vault_id === 'string' ? { vault_id: existing.vault_id } : {}),
          }
        : {}),
      settings,
    }));
  }

  // ---- Vault identity (top-level vault_id in data.json) ----------------------

  /**
   * Read the locally-stored `vault_id` from the top of `data.json`.
   * Returns null when the field is missing or has the wrong type — the
   * caller is expected to generate a UUID and persist it via
   * {@link saveVaultId} on first run.
   */
  async loadVaultId(): Promise<string | null> {
    const raw = (await this.plugin.loadData()) as Record<string, unknown> | null;
    if (!raw) return null;
    return typeof raw.vault_id === 'string' && raw.vault_id.length > 0 ? raw.vault_id : null;
  }

  /**
   * Write the given UUID into the top-level `vault_id` field of
   * `data.json`, preserving every other top-level key. Used for both
   * the initial generation and the adoption flow (overwrite-with-the-
   * Dropbox-side ID).
   */
  async saveVaultId(vaultId: string): Promise<void> {
    return this.enqueueDataJsonUpdate((existing) => ({
      ...(existing ?? {}),
      vault_id: vaultId,
    }));
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
