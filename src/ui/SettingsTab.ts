// SettingsTab — Archivist's declarative settings tab (spec 002, ADR-1/2/3).
//
// Obsidian 1.13+ builds the tab from `getSettingDefinitions()`, which makes
// every row searchable. This class is the thin Obsidian contract around the
// five section renderers (src/ui/settings/sections/*.ts):
//   - getSettingDefinitions: runs the header, the persistent banners and the
//     sections through a fresh DefinitionBuilderHost and keeps the per-build
//     key → spec registry.
//   - getControlValue / setControlValue: route Obsidian's control reads and
//     writes back to the emitting spec, behind the legacy write guard.
//   - refresh(): re-fetches the async fields (device, Dropbox account, usage)
//     and re-renders through a debounced update().
//
// Sections stay DOM-free and describe rows through SectionHost; the non-input
// rows are drawn by settings/customRows.ts.

import {
  debounce,
  PluginSettingTab,
  type App,
  type Plugin,
  type PluginManifest,
  type SettingDefinitionItem,
} from 'obsidian';
import type { NoticeCenter, PersistentBanner } from './NoticeCenter';
import type { BannerSpec, HeaderInfo, OnChangeResult, SectionHost } from './settings/SectionHost';
import { DefinitionBuilderHost, guardWrite, type InputFieldSpec } from './settings/DefinitionBuilderHost';
import { customRowRenderers } from './settings/customRows';
import type { SettingsContext } from './settings/context';
import type { Logger } from '../infra/Logger';
import { renderBackupSchedule } from './settings/sections/BackupSchedule';
import { renderRetention } from './settings/sections/Retention';
import { renderNotifications } from './settings/sections/Notifications';
import { renderAdvanced } from './settings/sections/Advanced';
import { renderDropbox } from './settings/sections/Dropbox';

const PLUGIN_README_URL = 'https://github.com/MMoMM-org/obsidian-archivist#readme';

/** Coalescing window for update(); resetTimer=false fires after the FIRST call of a burst. */
const UPDATE_DEBOUNCE_MS = 150;

/** Reserved control key of the designated-device toggle (not a PluginSettings field). */
const DESIGNATED_KEY = 'ui.device_designated';

type SectionRenderer = (host: SectionHost, ctx: SettingsContext) => void;

/** Documented top-to-bottom section order. */
const SECTIONS: readonly SectionRenderer[] = [
  renderBackupSchedule,
  renderRetention,
  renderNotifications,
  renderAdvanced,
  renderDropbox,
];

/** Banner codes that pause backups or need user action — shown as errors. */
const ERROR_BANNER_CODES: ReadonlySet<string> = new Set([
  'AUTH_LOST',
  'DEVICE_CONFLICT',
  'VAULT_ID_MISMATCH',
  'VAULT_META_CORRUPT',
]);

export interface ArchivistSettingTabDeps {
  plugin: Plugin;
  noticeCenter: NoticeCenter;
  /** Snapshot of dependencies needed by section renderers. */
  context: SettingsContext;
  /** Plugin logger; failed control writes are logged as metadata only. */
  logger: Logger;
}

export class ArchivistSettingTab extends PluginSettingTab {
  private registry = new Map<string, InputFieldSpec>();
  private refreshing = false;
  /** Serializes control writes so they apply in request order; never rejects. */
  private writeChain: Promise<void> = Promise.resolve();
  private readonly scheduleUpdate = debounce(() => this.update(), UPDATE_DEBOUNCE_MS, false);

  constructor(
    app: App,
    private readonly deps: ArchivistSettingTabDeps,
  ) {
    super(app, deps.plugin);
    // styles.css scopes .archivist-static-text / .archivist-doc-link under it.
    this.containerEl.addClass('archivist-settings');
  }

  /** Synchronous by contract: no await, no I/O. Replaces this build's registry. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const builder = new DefinitionBuilderHost(customRowRenderers);
    builder.header(headerInfoOf(this.deps.plugin.manifest));
    for (const banner of this.deps.noticeCenter.getPersistentBanners()) {
      builder.topBanner(persistentToBannerSpec(banner));
    }
    for (const render of SECTIONS) render(builder, this.deps.context);
    const { items, registry } = builder.result();
    this.registry = registry;
    return items;
  }

  getControlValue(key: string): unknown {
    return this.registry.get(key)?.value;
  }

  /**
   * Queues the write behind any in-flight one and resolves once it has been
   * applied, so quick toggles settle in request order (last request wins).
   */
  setControlValue(key: string, value: unknown): Promise<void> {
    const write = this.writeChain.then(() => this.applyWrite(key, value));
    this.writeChain = write.catch(() => undefined);
    return write;
  }

  /**
   * Write guard → the emitting spec's onChange → debounced update(). Unknown
   * (stale) keys and guard rejections are dropped silently, as today.
   */
  private async applyWrite(key: string, value: unknown): Promise<void> {
    const spec = this.registry.get(key);
    if (!spec) return;
    const guarded = guardWrite(spec, value);
    if (!guarded.accept) return;
    const applied = await this.applyChange(key, spec, guarded.value);
    if (applied && key === DESIGNATED_KEY) {
      this.deps.context.deviceDesignated = guarded.value === true;
    }
    this.scheduleUpdate();
  }

  /**
   * Public refresh — call after OAuth callback / disconnect / token mutation.
   * Forces a re-render even if values haven't changed (defensive: ensures UI
   * mirrors the latest backing state).
   */
  async refresh(): Promise<void> {
    await this.refreshAsyncFields(/* force = */ true);
  }

  /**
   * Runs spec.onChange and awaits whatever it returns, so a failed save or
   * ownership change never becomes an unhandled rejection. Returns false when
   * it failed; the scheduled update() then re-reads the stored state.
   */
  private async applyChange(key: string, spec: InputFieldSpec, value: unknown): Promise<boolean> {
    try {
      await (spec.onChange as (v: unknown) => OnChangeResult)(value);
      return true;
    } catch (err) {
      this.deps.logger.error('setting_apply_failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async refreshAsyncFields(force: boolean): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const ctx = this.deps.context;
      const [deviceId, designated, email, used] = await Promise.all([
        ctx.device.getDeviceId().catch(() => ctx.deviceId),
        ctx.device.isDesignated().catch(() => ctx.deviceDesignated),
        ctx.dropbox.getAccountEmail().catch(() => ctx.dropboxAccountEmail),
        ctx.dropbox.getUsedBytes().catch(() => ctx.dropboxUsedBytes),
      ]);
      const changed =
        ctx.deviceId !== deviceId ||
        ctx.deviceDesignated !== designated ||
        ctx.dropboxAccountEmail !== email ||
        ctx.dropboxUsedBytes !== used;
      ctx.deviceId = deviceId;
      ctx.deviceDesignated = designated;
      ctx.dropboxAccountEmail = email;
      ctx.dropboxUsedBytes = used;
      if (changed || force) this.scheduleUpdate();
    } finally {
      this.refreshing = false;
    }
  }
}

/** Header identity from the manifest; drops any `<email>` suffix from the author. */
function headerInfoOf(manifest: PluginManifest): HeaderInfo {
  const rawAuthor = manifest.author ?? '';
  const authorName = (rawAuthor.split('<')[0] ?? rawAuthor).trim();
  return {
    pluginName: manifest.name,
    version: manifest.version,
    authorName: authorName || undefined,
    authorUrl: manifest.authorUrl,
    docsUrl: PLUGIN_README_URL,
  };
}

export function persistentToBannerSpec(b: PersistentBanner): BannerSpec {
  // Default to 'warn' for anything not known to pause the backup loop.
  const severity: BannerSpec['severity'] = ERROR_BANNER_CODES.has(b.code) ? 'error' : 'warn';
  return {
    kind: 'banner',
    code: b.code,
    message: b.message,
    severity,
    action: b.action,
    dismissLabel: b.dismissLabel,
    onDismiss: b.onDismiss,
  };
}
