// Phase 7 — Settings UI is not yet implemented.
// This stub keeps the file compilable; it will be fleshed out in Phase 7.
import type ArchivistPlugin from '../main';
import { type App, PluginSettingTab } from 'obsidian';

export class SettingsTab extends PluginSettingTab {
  plugin: ArchivistPlugin;

  constructor(app: App, plugin: ArchivistPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // Phase 7 will populate the settings UI here.
  }
}
