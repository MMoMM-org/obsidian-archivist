// T7.6 — SettingsTab scaffold: all 5 sections register their heading.

import { describe, expect, it } from 'vitest';
import { RecordingSectionHost } from '../fixtures/recording-section-host';
import { renderBackupSchedule } from '../../src/ui/settings/sections/BackupSchedule';
import { renderRetention } from '../../src/ui/settings/sections/Retention';
import { renderNotifications } from '../../src/ui/settings/sections/Notifications';
import { renderAdvanced } from '../../src/ui/settings/sections/Advanced';
import { renderDropbox } from '../../src/ui/settings/sections/Dropbox';
import type { SettingsContext } from '../../src/ui/settings/context';
import { DEFAULT_SETTINGS } from '../../src/model/Settings';
import { S } from '../../src/ui/strings';

function stubContext(): SettingsContext {
  const settings = DEFAULT_SETTINGS;
  return {
    getSettings: () => settings,
    updateSettings: async () => {},
    device: {
      getDeviceId: async () => 'test-device',
      isDesignated: async () => true,
      takeOwnership: async () => {},
      releaseOwnership: async () => {},
    },
    dropbox: {
      getAccountEmail: async () => null,
      disconnect: async () => {},
      getUsedBytes: async () => 0,
    },
    oauth: {
      isConnected: async () => false,
      beginAuth: async () => {},
    },
    getRetentionProfile: () => ({ vault_bytes: 0, avg_edits_per_day: 0 }),
    estimateRetention: () => ({ snapshots: 0, gb: 0 }),
    copyToClipboard: async () => {},
    confirm: async () => true,
  };
}

describe('SettingsTab — section scaffold', () => {
  it('all five sections register a heading in the documented order when rendered in sequence', () => {
    const host = new RecordingSectionHost();
    const ctx = stubContext();

    renderBackupSchedule(host, ctx);
    renderRetention(host, ctx);
    renderNotifications(host, ctx);
    renderAdvanced(host, ctx);
    renderDropbox(host, ctx);

    expect(host.headings()).toEqual([
      S.SETTINGS_SECTION_SCHEDULE,
      S.SETTINGS_SECTION_RETENTION,
      S.SETTINGS_SECTION_NOTIFICATIONS,
      S.SETTINGS_SECTION_ADVANCED,
      S.SETTINGS_SECTION_DROPBOX,
    ]);
  });

  it('ArchivistSettingTab module loads', async () => {
    // Smoke test: Ensures the SettingsTab production entry compiles with all
    // the section imports wired. Full display() integration is covered by
    // T7.12 manual smoke; per-section content tests land in T7.7–T7.10.
    const mod = await import('../../src/ui/SettingsTab');
    expect(mod.ArchivistSettingTab).toBeDefined();
  });
});
