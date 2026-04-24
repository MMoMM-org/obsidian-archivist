// T7.8 — Retention section: fields + warning banner + live estimate.

import { describe, expect, it } from 'vitest';
import { renderRetention } from '../../src/ui/settings/sections/Retention';
import { RecordingSectionHost } from '../fixtures/recording-section-host';
import type { SettingsContext, RetentionEstimate } from '../../src/ui/settings/context';
import {
  DEFAULT_SETTINGS,
  type PluginSettings,
  type RetentionSettings,
} from '../../src/model/Settings';
import { S } from '../../src/ui/strings';

interface StubOpts {
  settings?: PluginSettings;
  dropboxUsedBytes?: number;
  estimateResult?: RetentionEstimate;
}

function makeCtx(opts: StubOpts = {}): {
  ctx: SettingsContext;
  updates: Array<Partial<PluginSettings>>;
  estimateCalls: number;
} {
  const settings = opts.settings ?? DEFAULT_SETTINGS;
  const updates: Array<Partial<PluginSettings>> = [];
  let estimateCalls = 0;

  const ctx: SettingsContext = {
    getSettings: () => settings,
    updateSettings: async (patch) => {
      updates.push(patch);
    },
    deviceId: 'd0',
    deviceDesignated: true,
    dropboxAccountEmail: null,
    dropboxUsedBytes: opts.dropboxUsedBytes ?? 0,
    device: {
      getDeviceId: async () => 'd0',
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
    getRetentionProfile: () => ({ vault_bytes: 1024 * 1024, avg_edits_per_day: 10 }),
    estimateRetention: () => {
      estimateCalls += 1;
      return opts.estimateResult ?? { snapshots: 123, gb: 4.56 };
    },
    copyToClipboard: async () => {},
    confirm: async () => true,
  };

  return {
    ctx,
    updates,
    get estimateCalls() {
      return estimateCalls;
    },
  } as { ctx: SettingsContext; updates: Array<Partial<PluginSettings>>; estimateCalls: number };
}

// ---------------------------------------------------------------------------
// Field presence + defaults
// ---------------------------------------------------------------------------

describe('renderRetention — fields present', () => {
  it('registers heading then 4 tier inputs + hard-limit + warn% + estimate row', () => {
    const host = new RecordingSectionHost();
    renderRetention(host, makeCtx().ctx);

    expect(host.headings()).toEqual([S.SETTINGS_SECTION_RETENTION]);

    const numberLabels = host
      .fields()
      .filter((f) => f.kind === 'number')
      .map((f) => (f as { label: string }).label);
    expect(numberLabels).toEqual([
      S.SETTINGS_RETENTION_RECENT_HOURS,
      S.SETTINGS_RETENTION_NEVER_PRUNE,
      S.SETTINGS_RETENTION_DAILY_DAYS,
      S.SETTINGS_RETENTION_MONTHLY_YEARS,
      S.SETTINGS_STORAGE_HARD_LIMIT,
      S.SETTINGS_STORAGE_WARN_AT,
    ]);
  });

  it('tier bounds match the plan: recent_hours 0–168, never-prune 0–14, daily 0–90, monthly 0–10', () => {
    const host = new RecordingSectionHost();
    renderRetention(host, makeCtx().ctx);
    const bounds = (label: string): { min: number; max: number } => {
      const f = host.findField('number', label);
      return { min: f!.min!, max: f!.max! };
    };
    expect(bounds(S.SETTINGS_RETENTION_RECENT_HOURS)).toEqual({ min: 0, max: 168 });
    expect(bounds(S.SETTINGS_RETENTION_NEVER_PRUNE)).toEqual({ min: 0, max: 14 });
    expect(bounds(S.SETTINGS_RETENTION_DAILY_DAYS)).toEqual({ min: 0, max: 90 });
    expect(bounds(S.SETTINGS_RETENTION_MONTHLY_YEARS)).toEqual({ min: 0, max: 10 });
  });

  it('renders a live-estimate row after the inputs', () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx({ estimateResult: { snapshots: 42, gb: 1.25 } });
    renderRetention(host, harness.ctx);

    const staticFields = host
      .fields()
      .filter((f) => f.kind === 'static')
      .map((f) => (f as { text: string }).text);
    expect(staticFields).toHaveLength(1);
    expect(staticFields[0]).toContain('42');
    expect(staticFields[0]).toContain('1.25');
    expect(harness.estimateCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// onChange wiring
// ---------------------------------------------------------------------------

describe('renderRetention — onChange wiring', () => {
  it('changing a tier persists only the retention sub-field', () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx();
    renderRetention(host, harness.ctx);

    host.findField('number', S.SETTINGS_RETENTION_DAILY_DAYS)!.onChange(45);
    expect(harness.updates).toHaveLength(1);
    const patch = harness.updates[0].retention as Partial<RetentionSettings>;
    expect(patch.daily_days).toBe(45);
    // Other retention fields round-tripped from current settings, unchanged.
    expect(patch.monthly_years).toBe(DEFAULT_SETTINGS.retention.monthly_years);
  });
});

// ---------------------------------------------------------------------------
// Storage warning banner
// ---------------------------------------------------------------------------

describe('renderRetention — storage warning banner', () => {
  it('prepends a STORAGE banner when used bytes ≥ warn_pct × hard_limit', () => {
    const host = new RecordingSectionHost();
    // 200 GB hard limit, 80% warn → 160 GB. Set used = 180 GB.
    const settings = {
      ...DEFAULT_SETTINGS,
      retention: { ...DEFAULT_SETTINGS.retention, storage_hard_limit_gb: 200, storage_warn_at_percent: 80 },
    };
    const usedBytes = 180 * 1024 * 1024 * 1024;
    renderRetention(host, makeCtx({ settings, dropboxUsedBytes: usedBytes }).ctx);

    const banners = host.fields().filter((f) => f.kind === 'banner');
    expect(banners).toHaveLength(1);
    expect((banners[0] as { code: string }).code).toBe('STORAGE');
  });

  it('no banner when usage is below the warn threshold', () => {
    const host = new RecordingSectionHost();
    const usedBytes = 50 * 1024 * 1024 * 1024; // 50 GB of 200 limit × 80% = 160 GB threshold
    renderRetention(host, makeCtx({ dropboxUsedBytes: usedBytes }).ctx);
    const banners = host.fields().filter((f) => f.kind === 'banner');
    expect(banners).toHaveLength(0);
  });

  it('no banner when hard_limit_gb is 0 (avoids always-true threshold)', () => {
    const host = new RecordingSectionHost();
    const settings = {
      ...DEFAULT_SETTINGS,
      retention: { ...DEFAULT_SETTINGS.retention, storage_hard_limit_gb: 0 },
    };
    renderRetention(host, makeCtx({ settings, dropboxUsedBytes: 10 }).ctx);
    const banners = host.fields().filter((f) => f.kind === 'banner');
    expect(banners).toHaveLength(0);
  });
});
