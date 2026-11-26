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
    deviceDesignated: opts.deviceDesignated ?? true,
    dropboxAccountEmail: null,
    dropboxUsedBytes: 0,
    device: {
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
      'Active window start',
      'Active window end',
    ]);
  });

  it('hides active-window time pickers when the toggle is off (default)', () => {
    const host = new RecordingSectionHost();
    const { ctx } = makeCtx();
    renderBackupSchedule(host, ctx);
    expect(host.findField('text', 'Active window start')).toBeUndefined();
    expect(host.findField('text', 'Active window end')).toBeUndefined();
  });

  it('renders active-window time pickers when the toggle is on', () => {
    const host = new RecordingSectionHost();
    const settings = {
      ...DEFAULT_SETTINGS,
      schedule: { ...DEFAULT_SETTINGS.schedule, active_window_enabled: true },
    };
    const { ctx } = makeCtx({ settings });
    renderBackupSchedule(host, ctx);
    expect(host.findField('text', 'Active window start')).toBeDefined();
    expect(host.findField('text', 'Active window end')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Active window rows react live (spec 002 F7)
// ---------------------------------------------------------------------------

/** A ctx whose updateSettings merges into the settings getSettings returns. */
function makeLiveCtx(enabled = false): { ctx: SettingsContext; current: () => PluginSettings } {
  let settings: PluginSettings = {
    ...DEFAULT_SETTINGS,
    schedule: { ...DEFAULT_SETTINGS.schedule, active_window_enabled: enabled },
  };
  const { ctx } = makeCtx({ settings });
  ctx.getSettings = () => settings;
  ctx.updateSettings = async (patch) => {
    settings = { ...settings, ...patch };
  };
  return { ctx, current: () => settings };
}

const WINDOW_LABELS = ['Active window start', 'Active window end'];

function windowEntries(host: RecordingSectionHost) {
  return host.fieldEntries().filter((e) => 'label' in e.spec && WINDOW_LABELS.includes(e.spec.label));
}

describe('renderBackupSchedule — active window rows (F7)', () => {
  it('always emits both window rows with a visible predicate, right after the toggle', () => {
    const host = new RecordingSectionHost();
    renderBackupSchedule(host, makeLiveCtx(false).ctx);
    const labels = host.fields().map((f) => ('label' in f ? f.label : f.kind));
    expect(labels.slice(-3)).toEqual(['Active backup window', ...WINDOW_LABELS]);
    const entries = windowEntries(host);
    expect(entries).toHaveLength(2);
    for (const e of entries) expect(typeof e.visible).toBe('function');
  });

  it('predicate follows the toggle without re-running the section', async () => {
    const host = new RecordingSectionHost();
    const live = makeLiveCtx(false);
    renderBackupSchedule(host, live.ctx);
    const entries = windowEntries(host);
    expect(entries.map((e) => e.visible?.())).toEqual([false, false]);

    await host.findField('toggle', 'Active backup window')!.onChange(true);
    expect(entries.map((e) => e.visible?.())).toEqual([true, true]);

    await host.findField('toggle', 'Active backup window')!.onChange(false);
    expect(entries.map((e) => e.visible?.())).toEqual([false, false]);
  });

  it('findField skips the hidden rows by default and finds them with includeHidden', () => {
    const host = new RecordingSectionHost();
    renderBackupSchedule(host, makeLiveCtx(false).ctx);
    for (const label of WINDOW_LABELS) {
      expect(host.findField('text', label)).toBeUndefined();
      const spec = host.findField('text', label, { includeHidden: true });
      expect(spec?.placeholder).toBe('HH:MM');
      expect(spec?.validate?.('08:00')).toBeNull();
      expect(spec?.validate?.('24:00')).toBe('Expected HH:MM (24-hour).');
    }
  });

  it('rows become findable once the toggle flips on', async () => {
    const host = new RecordingSectionHost();
    renderBackupSchedule(host, makeLiveCtx(false).ctx);
    await host.findField('toggle', 'Active backup window')!.onChange(true);
    expect(host.findField('text', 'Active window start')).toBeDefined();
    expect(host.findField('text', 'Active window end')).toBeDefined();
  });

  it('a write to one window field keeps a just-written value of the other (fresh read)', async () => {
    const host = new RecordingSectionHost();
    const live = makeLiveCtx(true);
    renderBackupSchedule(host, live.ctx);
    await host.findField('text', 'Active window start')!.onChange('07:15');
    await host.findField('text', 'Active window end')!.onChange('21:45');
    expect(live.current().schedule.active_window_start).toBe('07:15');
    expect(live.current().schedule.active_window_end).toBe('21:45');
    expect(live.current().schedule.active_window_enabled).toBe(true);
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

// ---------------------------------------------------------------------------
// Control keys (spec 002 T2.1) — dotted PluginSettings paths
// ---------------------------------------------------------------------------

describe('renderBackupSchedule — control keys', () => {
  const allFieldsSettings: PluginSettings = {
    ...DEFAULT_SETTINGS,
    schedule: { ...DEFAULT_SETTINGS.schedule, active_window_enabled: true },
  };

  it('every input field carries its dotted settings key, in order', () => {
    const host = new RecordingSectionHost();
    renderBackupSchedule(host, makeCtx({ settings: allFieldsSettings }).ctx);
    expect(host.fieldEntries().map((e) => e.key)).toEqual([
      'ui.device_designated',
      'schedule.full_cadence',
      'schedule.full_day_of_week',
      'schedule.full_time_of_day',
      'schedule.inc_interval_minutes',
      'schedule.startup_grace_minutes',
      'schedule.quiet_after_event_minutes',
      'schedule.active_window_enabled',
      'schedule.active_window_start',
      'schedule.active_window_end',
    ]);
  });

  it('designated toggle uses the reserved ui.device_designated key', () => {
    const host = new RecordingSectionHost();
    renderBackupSchedule(host, makeCtx().ctx);
    expect(host.findField('toggle', S.SETTINGS_DESIGNATED_TOGGLE)?.key).toBe('ui.device_designated');
  });

  it('keys are unique within the section', () => {
    const host = new RecordingSectionHost();
    renderBackupSchedule(host, makeCtx({ settings: allFieldsSettings }).ctx);
    const keys = host.fieldEntries().map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
