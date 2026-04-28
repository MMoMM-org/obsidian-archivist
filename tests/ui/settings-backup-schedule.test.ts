// T7.7 — Backup Schedule section field map + onChange wiring.

import { describe, expect, it } from 'vitest';
import { renderBackupSchedule } from '../../src/ui/settings/sections/BackupSchedule';
import { RecordingSectionHost } from '../fixtures/recording-section-host';
import type { SettingsContext } from '../../src/ui/settings/context';
import { DEFAULT_SETTINGS, type PluginSettings } from '../../src/model/Settings';
import { S } from '../../src/ui/strings';

interface StubOpts {
  settings?: PluginSettings;
  deviceDesignated?: boolean;
  deviceId?: string;
}

function makeCtx(opts: StubOpts = {}): {
  ctx: SettingsContext;
  updates: Array<Partial<PluginSettings>>;
  takeOwnershipCalls: number;
  releaseOwnershipCalls: number;
} {
  const settings = opts.settings ?? DEFAULT_SETTINGS;
  const updates: Array<Partial<PluginSettings>> = [];
  let takeOwnershipCalls = 0;
  let releaseOwnershipCalls = 0;

  const ctx: SettingsContext = {
    getSettings: () => settings,
    updateSettings: async (patch) => {
      updates.push(patch);
    },
    deviceId: opts.deviceId ?? '7f3a2c01-aaaa-4bbb-8ccc-dddddddddddd',
    deviceDesignated: opts.deviceDesignated ?? true,
    dropboxAccountEmail: null,
    dropboxUsedBytes: 0,
    device: {
      getDeviceId: async () => opts.deviceId ?? 'x',
      isDesignated: async () => true,
      takeOwnership: async () => {
        takeOwnershipCalls += 1;
      },
      releaseOwnership: async () => {
        releaseOwnershipCalls += 1;
      },
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

  return {
    ctx,
    updates,
    get takeOwnershipCalls() {
      return takeOwnershipCalls;
    },
    get releaseOwnershipCalls() {
      return releaseOwnershipCalls;
    },
  } as {
    ctx: SettingsContext;
    updates: Array<Partial<PluginSettings>>;
    takeOwnershipCalls: number;
    releaseOwnershipCalls: number;
  };
}

// ---------------------------------------------------------------------------
// Field presence + structure
// ---------------------------------------------------------------------------

describe('renderBackupSchedule — fields present', () => {
  it('registers heading then all documented fields in order', () => {
    const host = new RecordingSectionHost();
    const { ctx } = makeCtx();
    renderBackupSchedule(host, ctx);

    expect(host.headings()).toEqual([S.SETTINGS_SECTION_SCHEDULE]);

    const fieldLabels = host.fields().map((f) => 'label' in f ? f.label : f.kind);
    expect(fieldLabels).toEqual([
      S.SETTINGS_DESIGNATED_TOGGLE,
      S.SETTINGS_FULL_CADENCE,
      'Full backup day',
      S.SETTINGS_FULL_TIME,
      S.SETTINGS_INC_INTERVAL,
      S.SETTINGS_STARTUP_GRACE,
      S.SETTINGS_QUIET_PERIOD,
      'Active backup window',
    ]);
  });

  it('does NOT render active-window time pickers when the toggle is off (default)', () => {
    const host = new RecordingSectionHost();
    const { ctx } = makeCtx();
    renderBackupSchedule(host, ctx);
    const labels = host.fields().map((f) => 'label' in f ? f.label : '');
    expect(labels).not.toContain('Active window start');
    expect(labels).not.toContain('Active window end');
  });

  it('renders active-window time pickers when the toggle is on', () => {
    const host = new RecordingSectionHost();
    const settings = {
      ...DEFAULT_SETTINGS,
      schedule: { ...DEFAULT_SETTINGS.schedule, active_window_enabled: true },
    };
    const { ctx } = makeCtx({ settings });
    renderBackupSchedule(host, ctx);
    const labels = host.fields().map((f) => 'label' in f ? f.label : '');
    expect(labels).toContain('Active window start');
    expect(labels).toContain('Active window end');
  });
});

// ---------------------------------------------------------------------------
// Designated toggle
// ---------------------------------------------------------------------------

describe('renderBackupSchedule — designated toggle', () => {
  it('reflects ctx.deviceDesignated as initial value', () => {
    const host = new RecordingSectionHost();
    renderBackupSchedule(host, makeCtx({ deviceDesignated: false }).ctx);
    const field = host.findField('toggle', S.SETTINGS_DESIGNATED_TOGGLE);
    expect(field?.value).toBe(false);
  });

  it('calls takeOwnership when turned ON', () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx();
    renderBackupSchedule(host, harness.ctx);
    const field = host.findField('toggle', S.SETTINGS_DESIGNATED_TOGGLE);
    field!.onChange(true);
    expect(harness.takeOwnershipCalls).toBe(1);
    expect(harness.releaseOwnershipCalls).toBe(0);
  });

  it('calls releaseOwnership when turned OFF', () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx();
    renderBackupSchedule(host, harness.ctx);
    const field = host.findField('toggle', S.SETTINGS_DESIGNATED_TOGGLE);
    field!.onChange(false);
    expect(harness.releaseOwnershipCalls).toBe(1);
    expect(harness.takeOwnershipCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dropdown + number + text wiring
// ---------------------------------------------------------------------------

describe('renderBackupSchedule — onChange wiring', () => {
  it('cadence dropdown persists to schedule.full_cadence', () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx();
    renderBackupSchedule(host, harness.ctx);
    const field = host.findField('dropdown', S.SETTINGS_FULL_CADENCE);
    field!.onChange('biweekly');
    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0].schedule?.full_cadence).toBe('biweekly');
  });

  it('day-of-week dropdown persists as number', () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx();
    renderBackupSchedule(host, harness.ctx);
    const field = host.findField('dropdown', 'Full backup day');
    field!.onChange('3');
    expect(harness.updates[0].schedule?.full_day_of_week).toBe(3);
  });

  it('full time validates HH:MM and rejects garbage', () => {
    const host = new RecordingSectionHost();
    renderBackupSchedule(host, makeCtx().ctx);
    const field = host.findField('text', S.SETTINGS_FULL_TIME);
    expect(field?.validate?.('03:15')).toBeNull();
    expect(field?.validate?.('25:99')).not.toBeNull();
    expect(field?.validate?.('garbage')).not.toBeNull();
  });

  it('inc interval dropdown persists as number literal', () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx();
    renderBackupSchedule(host, harness.ctx);
    const field = host.findField('dropdown', S.SETTINGS_INC_INTERVAL);
    field!.onChange('30');
    expect(harness.updates[0].schedule?.inc_interval_minutes).toBe(30);
  });

  it('startup grace number respects min/max bounds', () => {
    const host = new RecordingSectionHost();
    renderBackupSchedule(host, makeCtx().ctx);
    const field = host.findField('number', S.SETTINGS_STARTUP_GRACE);
    expect(field?.min).toBe(1);
    expect(field?.max).toBe(60);
  });

  it('active-window toggle change persists active_window_enabled', () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx();
    renderBackupSchedule(host, harness.ctx);
    const field = host.findField('toggle', 'Active backup window');
    field!.onChange(true);
    expect(harness.updates[0].schedule?.active_window_enabled).toBe(true);
  });
});
