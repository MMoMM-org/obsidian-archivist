// SettingsTab — Obsidian PluginSettingTab host + section orchestration (T7.6).
//
// Five sections rendered top-to-bottom in the documented order:
//   1. Backup Schedule   (T7.7)
//   2. Retention         (T7.8)
//   3. Notifications     (T7.9)
//   4. Advanced          (T7.9)
//   5. Dropbox           (T7.10)
//
// Each section's rendering logic lives in src/ui/settings/sections/*.ts as a
// pure function that takes a SectionHost + context. This file:
//   - Owns the PluginSettingTab lifecycle
//   - Renders the persistent-banner slot at the top (driven by NoticeCenter)
//   - Constructs an ObsidianSectionHost over the containerEl and delegates
//     to each section renderer in order
//   - Subscribes to NoticeCenter banner updates; re-renders on change
//
// Tests exercise section renderers directly with a RecordingSectionHost —
// no DOM / PluginSettingTab machinery needed.

import { PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import type { NoticeCenter, PersistentBanner } from './NoticeCenter';
import type {
  FieldSpec,
  SectionHost,
  BannerSpec,
  LinkFieldSpec,
  ActionRowFieldSpec,
} from './settings/SectionHost';
import type { SettingsContext } from './settings/context';
import { renderBackupSchedule } from './settings/sections/BackupSchedule';
import { renderRetention } from './settings/sections/Retention';
import { renderNotifications } from './settings/sections/Notifications';
import { renderAdvanced } from './settings/sections/Advanced';
import { renderDropbox } from './settings/sections/Dropbox';

const PLUGIN_README_URL = 'https://github.com/MMoMM-org/obsidian-archivist#readme';

export interface ArchivistSettingTabDeps {
  plugin: Plugin;
  noticeCenter: NoticeCenter;
  /** Snapshot of dependencies needed by section renderers. */
  context: SettingsContext;
}

export class ArchivistSettingTab extends PluginSettingTab {
  private unsubscribeBanners: (() => void) | null = null;
  private refreshing = false;

  constructor(
    app: App,
    private readonly deps: ArchivistSettingTabDeps,
  ) {
    super(app, deps.plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('archivist-settings');

    this.renderHeader(containerEl);

    const host = new ObsidianSectionHost(containerEl, this.deps.context);

    // Persistent-banner slot — latest from NoticeCenter, mapped to BannerSpec.
    for (const b of this.deps.noticeCenter.getPersistentBanners()) {
      host.topBanner(persistentToBannerSpec(b));
    }

    renderBackupSchedule(host, this.deps.context);
    renderRetention(host, this.deps.context);
    renderNotifications(host, this.deps.context);
    renderAdvanced(host, this.deps.context);
    renderDropbox(host, this.deps.context);

    this.subscribeBannerUpdates();

    // Background refresh of async fields (Dropbox account email, device id,
    // etc.) — re-renders if anything changed since last paint. Important for:
    //   - First open after enable: tokens may have been written by a prior run
    //   - After OAuth callback: settings tab needs to reflect connected state
    //   - After Disconnect: settings tab needs to switch to empty state
    if (!this.refreshing) {
      void this.refreshAsyncFields(/* forceRedisplay = */ false);
    }
  }

  /**
   * Public refresh — call after OAuth callback / disconnect / token mutation.
   * Forces a re-render even if values haven't changed (defensive: ensures UI
   * mirrors the latest backing state).
   */
  async refresh(): Promise<void> {
    await this.refreshAsyncFields(/* forceRedisplay = */ true);
  }

  hide(): void {
    this.unsubscribeBanners?.();
    this.unsubscribeBanners = null;
  }

  private subscribeBannerUpdates(): void {
    this.unsubscribeBanners?.();
    this.unsubscribeBanners = this.deps.noticeCenter.subscribePersistentBanners(() => {
      // Cheapest implementation: re-render the entire tab. Banner changes are
      // rare (quota, auth-lost, device-conflict) so cost is acceptable.
      this.display();
    });
  }

  private async refreshAsyncFields(forceRedisplay: boolean): Promise<void> {
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
      if (changed || forceRedisplay) {
        this.display();
      }
    } finally {
      this.refreshing = false;
    }
  }

  private renderHeader(containerEl: HTMLElement): void {
    const manifest = this.deps.plugin.manifest as typeof this.deps.plugin.manifest & {
      author?: string;
      authorUrl?: string;
    };
    const rawAuthor = manifest.author ?? '';
    const authorName = (rawAuthor.split('<')[0] ?? rawAuthor).trim();

    const header = containerEl.createDiv({ cls: 'archivist-version-header' });
    header.createSpan({ text: `${manifest.name} `, cls: 'archivist-plugin-name' });
    header.createSpan({ text: `v${manifest.version}` });

    if (authorName) {
      header.createSpan({ text: ' · ', cls: 'archivist-header-sep' });
      header.createEl('a', {
        text: authorName,
        href: manifest.authorUrl ?? PLUGIN_README_URL,
      });
    }
    header.createSpan({ text: ' · ', cls: 'archivist-header-sep' });
    header.createEl('a', { text: 'Documentation', href: PLUGIN_README_URL });
  }
}

function persistentToBannerSpec(b: PersistentBanner): BannerSpec {
  // Map known codes to severity. Default to 'warn' for anything else.
  const severity: BannerSpec['severity'] =
    b.code === 'AUTH_LOST' || b.code === 'DEVICE_CONFLICT' ? 'error' : 'warn';
  return {
    kind: 'banner',
    code: b.code,
    message: b.message,
    severity,
    dismissLabel: b.dismissLabel,
    onDismiss: b.onDismiss,
  };
}

// ---------------------------------------------------------------------------
// ObsidianSectionHost — production adapter that materialises FieldSpec as
// Obsidian Setting rows. This is the ONLY place that touches the DOM — all
// section renderers describe the UI via SectionHost methods.
// ---------------------------------------------------------------------------

class ObsidianSectionHost implements SectionHost {
  constructor(
    private readonly container: HTMLElement,
    private readonly context: SettingsContext,
  ) {}

  heading(text: string): void {
    this.container.createEl('h2', { text });
  }

  field(spec: FieldSpec): void {
    switch (spec.kind) {
      case 'static':
        this.container.createEl('p', { text: spec.text, cls: 'archivist-static-text' });
        return;
      case 'link':
        this.renderLink(spec);
        return;
      case 'banner':
        this.renderBanner(spec);
        return;
      case 'button':
        this.renderButton(spec);
        return;
      case 'actionRow':
        this.renderActionRow(spec);
        return;
      case 'readonly':
        this.renderReadonly(spec);
        return;
      case 'text':
        this.renderText(spec);
        return;
      case 'textarea':
        this.renderTextarea(spec);
        return;
      case 'toggle':
        this.renderToggle(spec);
        return;
      case 'number':
        this.renderNumber(spec);
        return;
      case 'dropdown':
        this.renderDropdown(spec);
        return;
      case 'slider':
        this.renderSlider(spec);
        return;
    }
  }

  topBanner(spec: BannerSpec): void {
    this.renderBanner(spec);
  }

  // ---------------------------------------------------------------------------
  // Per-field renderers — thin wrappers over Obsidian Setting
  // ---------------------------------------------------------------------------

  private renderActionRow(spec: ActionRowFieldSpec): void {
    const setting = new Setting(this.container).setName(spec.label);
    if (spec.description) setting.setDesc(spec.description);
    for (const action of spec.actions) {
      setting.addButton((btn) => {
        btn.setButtonText(action.label).onClick(action.onClick);
        if (action.cta) btn.setCta();
        if (action.warning) btn.setWarning();
      });
    }
  }

  private renderLink(spec: LinkFieldSpec): void {
    const wrapper = this.container.createDiv({ cls: 'archivist-link-row' });
    wrapper.createEl('a', {
      text: spec.label,
      href: spec.href,
      cls: 'archivist-doc-link',
    });
  }

  private renderBanner(spec: BannerSpec): void {
    const cls = `archivist-banner archivist-banner-${spec.severity}`;
    const el = this.container.createDiv({ cls }) as unknown as HTMLElement;
    el.createEl('strong', { text: `[${spec.code}] ` });
    el.createSpan({ text: spec.message });
    if (spec.onDismiss) {
      const setting = new Setting(el);
      setting.addButton((btn) => {
        btn.setButtonText(spec.dismissLabel ?? 'Dismiss').onClick(() => {
          void spec.onDismiss?.();
        });
      });
    }
  }

  private renderButton(spec: { label: string; cta?: boolean; onClick: () => void }): void {
    const setting = new Setting(this.container);
    setting.addButton((btn) => {
      btn.setButtonText(spec.label);
      if (spec.cta) btn.setCta();
      btn.onClick(spec.onClick);
    });
  }

  private renderReadonly(spec: {
    label: string;
    description?: string;
    value: string;
    copyable?: boolean;
  }): void {
    const setting = new Setting(this.container).setName(spec.label);
    if (spec.description) setting.setDesc(spec.description);
    setting.addText((text) => {
      text.setValue(spec.value).setDisabled(true);
    });
    if (spec.copyable) {
      setting.addButton((btn) => {
        btn.setButtonText('Copy').onClick(() => {
          void this.context.copyToClipboard(spec.value);
        });
      });
    }
  }

  private renderText(spec: {
    label: string;
    description?: string;
    value: string;
    placeholder?: string;
    onChange: (v: string) => void;
    validate?: (v: string) => string | null;
  }): void {
    const setting = new Setting(this.container).setName(spec.label);
    if (spec.description) setting.setDesc(spec.description);
    setting.addText((text) => {
      text.setValue(spec.value);
      if (spec.placeholder) text.setPlaceholder(spec.placeholder);
      text.onChange((v) => {
        const err = spec.validate?.(v) ?? null;
        if (err) return;
        spec.onChange(v);
      });
    });
  }

  private renderTextarea(spec: {
    label: string;
    description?: string;
    value: string;
    onChange: (v: string) => void;
    validate?: (v: string) => string | null;
  }): void {
    const setting = new Setting(this.container).setName(spec.label);
    if (spec.description) setting.setDesc(spec.description);
    setting.addTextArea((area) => {
      area.setValue(spec.value);
      area.onChange((v) => {
        const err = spec.validate?.(v) ?? null;
        if (err) return;
        spec.onChange(v);
      });
    });
  }

  private renderToggle(spec: {
    label: string;
    description?: string;
    value: boolean;
    onChange: (v: boolean) => void;
  }): void {
    const setting = new Setting(this.container).setName(spec.label);
    if (spec.description) setting.setDesc(spec.description);
    setting.addToggle((toggle) => {
      toggle.setValue(spec.value).onChange(spec.onChange);
    });
  }

  private renderNumber(spec: {
    label: string;
    description?: string;
    value: number;
    min?: number;
    max?: number;
    onChange: (v: number) => void;
    validate?: (v: number) => string | null;
  }): void {
    const setting = new Setting(this.container).setName(spec.label);
    if (spec.description) setting.setDesc(spec.description);
    setting.addText((text) => {
      text.setValue(String(spec.value));
      text.onChange((raw) => {
        const n = Number(raw);
        if (Number.isNaN(n)) return;
        if (spec.min !== undefined && n < spec.min) return;
        if (spec.max !== undefined && n > spec.max) return;
        const err = spec.validate?.(n) ?? null;
        if (err) return;
        spec.onChange(n);
      });
    });
  }

  private renderDropdown(spec: {
    label: string;
    description?: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (v: string) => void;
  }): void {
    const setting = new Setting(this.container).setName(spec.label);
    if (spec.description) setting.setDesc(spec.description);
    setting.addDropdown((dd) => {
      for (const o of spec.options) dd.addOption(o.value, o.label);
      dd.setValue(spec.value).onChange(spec.onChange);
    });
  }

  private renderSlider(spec: {
    label: string;
    description?: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (v: number) => void;
  }): void {
    const setting = new Setting(this.container).setName(spec.label);
    if (spec.description) setting.setDesc(spec.description);
    setting.addSlider((slider) => {
      slider
        .setLimits(spec.min, spec.max, spec.step)
        .setValue(spec.value)
        .setDynamicTooltip()
        .onChange(spec.onChange);
    });
  }
}
