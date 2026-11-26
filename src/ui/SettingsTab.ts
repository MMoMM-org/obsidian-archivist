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
//   - refresh orchestration (SDD Complex Logic): a NoticeCenter banner change
//     and every header render (open + each re-render) feed a debounced
//     update(); the header render re-fetches the async fields (device, Dropbox
//     account, usage) and only schedules update() when a value changed, so the open →
//     fetch → update → fetch loop stops after one round. refresh() forces the update().
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
import type {
  BannerSpec,
  CustomRowRenderers,
  HeaderInfo,
  OnChangeResult,
  SectionHost,
} from './settings/SectionHost';
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
  /** Plugin-lifetime cleanup registration (Component.register); runs on unload. */
  register: (teardown: () => void) => void;
}

interface AsyncFields {
  designated: boolean;
  email: string | null;
  used: number;
}

export class ArchivistSettingTab extends PluginSettingTab {
  private registry = new Map<string, InputFieldSpec>();
  /** The running fetch chain (incl. forced follow-ups); null when idle. */
  private inFlight: Promise<void> | null = null;
  /** A refresh() arrived during the in-flight fetch; run one more forced fetch. */
  private pendingForce = false;
  /** Serializes control writes so they apply in request order; never rejects. */
  private writeChain: Promise<void> = Promise.resolve();
  private readonly scheduleUpdate = debounce(() => this.update(), UPDATE_DEBOUNCE_MS, false);
  /** Applied designated writes; a fetch that saw this change keeps the written value. */
  private designatedWrites = 0;
  private disposed = false;
  /** Shared row renderers, except the header also starts the async-field fetch. */
  private readonly renderers: CustomRowRenderers = {
    ...customRowRenderers,
    header: (setting, info) => {
      const cleanup = customRowRenderers.header(setting, info);
      void this.refreshAsyncFields(false);
      return cleanup;
    },
  };

  constructor(
    app: App,
    private readonly deps: ArchivistSettingTabDeps,
  ) {
    super(app, deps.plugin);
    // styles.css scopes .archivist-static-text / .archivist-doc-link under it.
    this.containerEl.addClass('archivist-settings');
    this.subscribeBanners();
  }

  /** Live banners: rebuild on every change; unsubscribe on plugin unload. */
  private subscribeBanners(): void {
    const unsubscribe = this.deps.noticeCenter.subscribePersistentBanners(() => this.scheduleUpdate());
    this.deps.register(() => {
      unsubscribe();
      this.disposed = true;
      this.scheduleUpdate.cancel();
    });
  }

  /** Synchronous by contract: no await, no I/O. Replaces this build's registry. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const builder = new DefinitionBuilderHost(this.renderers);
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
      this.designatedWrites += 1;
    }
    if (!this.disposed) this.scheduleUpdate();
  }

  /** After OAuth / disconnect / token change: re-fetch, then always update(). */
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

  /**
   * One fetch chain at a time. A skipped header fetch is dropped; a skipped
   * forced one queues a single follow-up and resolves when the chain is done.
   */
  private refreshAsyncFields(force: boolean): Promise<void> {
    if (this.inFlight) {
      if (force) this.pendingForce = true;
      return force ? this.inFlight : Promise.resolve();
    }
    // Assigned before runFetches can reach its finally: its body opens with await.
    this.inFlight = this.runFetches(force);
    return this.inFlight;
  }

  /** Bounded loop; clears the guard in the exit turn, so no refresh() gets a finished chain. */
  private async runFetches(force: boolean): Promise<void> {
    try {
      await this.fetchOnce(force);
      while (this.pendingForce && !this.disposed) {
        this.pendingForce = false;
        await this.fetchOnce(true);
      }
    } finally {
      this.inFlight = null;
    }
  }

  /** Never rejects; update() on a change, or always when forced (even on failure). */
  private async fetchOnce(force: boolean): Promise<void> {
    const writesAtStart = this.designatedWrites;
    let changed = false;
    try {
      const fetched = await this.fetchAsyncFields();
      changed = this.applyFetched(fetched, writesAtStart !== this.designatedWrites);
    } catch (err) {
      this.deps.logger.warn('settings_refresh_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if ((changed || force) && !this.disposed) this.scheduleUpdate();
  }

  /** Each fetch falls back to the cached ctx value when it rejects. */
  private async fetchAsyncFields(): Promise<AsyncFields> {
    const ctx = this.deps.context;
    const [designated, email, used] = await Promise.all([
      ctx.device.isDesignated().catch(() => ctx.deviceDesignated),
      ctx.dropbox.getAccountEmail().catch(() => ctx.dropboxAccountEmail),
      ctx.dropbox.getUsedBytes().catch(() => ctx.dropboxUsedBytes),
    ]);
    return { designated, email, used };
  }

  /**
   * Writes the fetched values into ctx and reports whether any changed. When a
   * designated toggle was applied while the fetch ran, its read is stale and
   * the written value is kept.
   */
  private applyFetched(f: AsyncFields, keepDesignated: boolean): boolean {
    const ctx = this.deps.context;
    const designated = keepDesignated ? ctx.deviceDesignated : f.designated;
    const changed =
      ctx.deviceDesignated !== designated ||
      ctx.dropboxAccountEmail !== f.email ||
      ctx.dropboxUsedBytes !== f.used;
    ctx.deviceDesignated = designated;
    ctx.dropboxAccountEmail = f.email;
    ctx.dropboxUsedBytes = f.used;
    return changed;
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
