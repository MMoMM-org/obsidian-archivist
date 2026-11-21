// T3.1 (spec 002) — declarative ArchivistSettingTab contract.
//
// The tab runs the header, the top banners and the five real sections through
// a fresh DefinitionBuilderHost on every getSettingDefinitions() call, and
// routes Obsidian's getControlValue / setControlValue back to the emitting
// spec through the per-build key registry. These tests drive the tab the way
// Obsidian does (definitions → control get/set → debounced update()) against
// the vitest obsidian mock; no DOM beyond the mock Setting is involved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  App,
  Plugin,
  Setting as ObsidianSetting,
  SettingDefinition,
  SettingDefinitionGroup,
  SettingDefinitionRender,
  SettingGroup,
} from 'obsidian';
import { Setting, type MockEl } from '../fixtures/obsidian-mock';
import { ArchivistSettingTab, persistentToBannerSpec } from '../../src/ui/SettingsTab';
import type { NoticeCenter, PersistentBanner } from '../../src/ui/NoticeCenter';
import type { SettingsContext } from '../../src/ui/settings/context';
import type { Logger } from '../../src/infra/Logger';
import { DEFAULT_SETTINGS, type PluginSettings } from '../../src/model/Settings';
import { S } from '../../src/ui/strings';

const GB = 1024 * 1024 * 1024;
const UPDATE_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  tab: ArchivistSettingTab & { _updateCalls: number; containerEl: unknown };
  ctx: SettingsContext;
  /** Call recorders only; the promises the context returns come from plain functions (see makeHarness). */
  updateSettings: ReturnType<typeof vi.fn>;
  takeOwnership: ReturnType<typeof vi.fn>;
  releaseOwnership: ReturnType<typeof vi.fn>;
  /** Fake plugin logger; every method is a spy. */
  logger: { [K in keyof Logger]: ReturnType<typeof vi.fn> };
  /** Makes every later updateSettings() call reject with `err`. */
  failSaves: (err: Error) => void;
  /** Makes every later takeOwnership() call reject with `err`. */
  failTakeOwnership: (err: Error) => void;
  setBanners: (banners: PersistentBanner[]) => void;
}

interface HarnessOptions {
  settings?: (s: PluginSettings) => void;
  usedBytes?: number;
  deviceDesignated?: boolean;
  banners?: PersistentBanner[];
}

function cloneDefaults(): PluginSettings {
  return structuredClone(DEFAULT_SETTINGS);
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  let settings = cloneDefaults();
  opts.settings?.(settings);
  let banners = opts.banners ?? [];

  // vi.fn() attaches settle handlers to the promises it returns, which would
  // mask an unhandled rejection. The spies only record calls; the promise is
  // built by a plain function so a rejection stays observable to Node.
  const updateSettings = vi.fn();
  const takeOwnership = vi.fn();
  const releaseOwnership = vi.fn();
  let saveError: Error | null = null;
  let takeError: Error | null = null;

  const ctx: SettingsContext = {
    getSettings: () => settings,
    updateSettings: (patch) => {
      updateSettings(patch);
      if (saveError) return Promise.reject(saveError);
      settings = { ...settings, ...patch };
      return Promise.resolve();
    },
    deviceId: '7f3a2c01-1111-4111-8111-111111111111',
    deviceDesignated: opts.deviceDesignated ?? true,
    dropboxAccountEmail: null,
    dropboxUsedBytes: opts.usedBytes ?? 0,
    device: {
      getDeviceId: async () => 'test-device',
      isDesignated: async () => true,
      takeOwnership: () => {
        takeOwnership();
        return takeError ? Promise.reject(takeError) : Promise.resolve();
      },
      releaseOwnership: () => {
        releaseOwnership();
        return Promise.resolve();
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

  const noticeCenter = {
    getPersistentBanners: () => banners,
    subscribePersistentBanners: () => () => {},
  } as unknown as NoticeCenter;

  const plugin = {
    manifest: {
      id: 'archivist',
      name: 'Archivist',
      version: '0.11.1',
      author: 'Marcus <marcus@example.org>',
      authorUrl: 'https://example.org/marcus',
    },
  } as unknown as Plugin;

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const tab = new ArchivistSettingTab({} as App, { plugin, noticeCenter, context: ctx, logger }) as Harness['tab'];
  return {
    tab,
    ctx,
    logger,
    updateSettings,
    takeOwnership,
    releaseOwnership,
    failSaves: (err) => {
      saveError = err;
    },
    failTakeOwnership: (err) => {
      takeError = err;
    },
    setBanners: (next) => {
      banners = next;
    },
  };
}

function groupsOf(tab: ArchivistSettingTab): SettingDefinitionGroup[] {
  return tab.getSettingDefinitions() as SettingDefinitionGroup[];
}

function itemsOf(group: SettingDefinitionGroup): SettingDefinition[] {
  return (group.items ?? []) as SettingDefinition[];
}

function namesOf(group: SettingDefinitionGroup): string[] {
  return itemsOf(group).map((d) => d.name);
}

function groupByHeading(tab: ArchivistSettingTab, heading: string): SettingDefinitionGroup {
  const group = groupsOf(tab).find((g) => g.heading === heading);
  if (!group) throw new Error(`no group "${heading}"`);
  return group;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets pending microtasks and Node's unhandled-rejection pass run. */
async function flushRejections(): Promise<void> {
  vi.useRealTimers();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

describe('ArchivistSettingTab — getSettingDefinitions', () => {
  it('is synchronous: returns an array, not a Promise', () => {
    const { tab } = makeHarness();
    const result = tab.getSettingDefinitions();
    expect(Array.isArray(result)).toBe(true);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('returns six groups: untitled top, then the five sections in documented order', () => {
    const { tab } = makeHarness();
    const groups = groupsOf(tab);
    expect(groups.every((g) => g.type === 'group')).toBe(true);
    expect(groups.map((g) => g.heading)).toEqual([
      undefined,
      S.SETTINGS_SECTION_SCHEDULE,
      S.SETTINGS_SECTION_RETENTION,
      S.SETTINGS_SECTION_NOTIFICATIONS,
      S.SETTINGS_SECTION_ADVANCED,
      S.SETTINGS_SECTION_DROPBOX,
    ]);
  });

  it('top group holds the header followed by banners in getPersistentBanners() order', () => {
    const { tab } = makeHarness({
      banners: [
        { code: 'AUTH_LOST', message: 'auth lost' },
        { code: 'CHAIN_RECOVERY', message: 'recovering' },
      ],
    });
    const [top] = groupsOf(tab);
    expect(namesOf(top)).toEqual(['header', 'banner:AUTH_LOST', 'banner:CHAIN_RECOVERY']);
  });

  it('rebuilds the top banners from the latest getPersistentBanners() on each call', () => {
    const h = makeHarness({ banners: [{ code: 'AUTH_LOST', message: 'a' }] });
    h.tab.getSettingDefinitions();
    h.setBanners([]);
    const [top] = groupsOf(h.tab);
    expect(namesOf(top)).toEqual(['header']);
  });

  it('header row renders plugin name, version, author (email stripped) and docs link from the manifest', () => {
    const { tab } = makeHarness();
    const [top] = groupsOf(tab);
    const header = itemsOf(top)[0] as SettingDefinitionRender;
    const setting = new Setting({}).setName('header');
    header.render(setting as unknown as ObsidianSetting, {} as SettingGroup);

    const root = setting.settingEl as unknown as MockEl;
    const [box] = root.querySelectorAll('.archivist-version-header');
    expect(box.querySelectorAll('.archivist-plugin-name')[0].textContent).toBe('Archivist ');
    const links = box.querySelectorAll('a');
    expect(links.map((l) => l.textContent)).toEqual(['Marcus', 'Documentation']);
    expect(links[0].attrs.href).toBe('https://example.org/marcus');
    expect(links[1].attrs.href).toBe('https://github.com/MMoMM-org/obsidian-archivist#readme');
  });

  it('emits every section input as a control row keyed by its dotted path', () => {
    const { tab } = makeHarness();
    const keys = groupsOf(tab)
      .flatMap(itemsOf)
      .flatMap((d) => (d.control ? [d.control.key] : []));
    expect(keys).toEqual(
      expect.arrayContaining([
        'ui.device_designated',
        'schedule.full_cadence',
        'schedule.active_window_enabled',
        'retention.daily_days',
        'notifications.toast_on_error',
        'advanced.exclusion_globs',
        'advanced.vault_prefix',
        'advanced.chunk_size_mb',
      ]),
    );
  });

  it('places the STORAGE banner in the Retention group when usage is at the warn threshold', () => {
    const { tab } = makeHarness({
      settings: (s) => {
        s.retention.storage_hard_limit_gb = 10;
        s.retention.storage_warn_at_percent = 80;
      },
      usedBytes: 8 * GB,
    });
    expect(namesOf(groupByHeading(tab, S.SETTINGS_SECTION_RETENTION))).toContain('banner:STORAGE');
    const [top] = groupsOf(tab);
    expect(namesOf(top)).not.toContain('banner:STORAGE');
  });

  it('omits the STORAGE banner when usage is below the warn threshold', () => {
    const { tab } = makeHarness({
      settings: (s) => {
        s.retention.storage_hard_limit_gb = 10;
        s.retention.storage_warn_at_percent = 80;
      },
      usedBytes: 8 * GB - 1,
    });
    expect(namesOf(groupByHeading(tab, S.SETTINGS_SECTION_RETENTION))).not.toContain('banner:STORAGE');
  });

  it('omits the STORAGE banner when the hard limit is 0', () => {
    const { tab } = makeHarness({
      settings: (s) => {
        s.retention.storage_hard_limit_gb = 0;
      },
      usedBytes: 50 * GB,
    });
    expect(namesOf(groupByHeading(tab, S.SETTINGS_SECTION_RETENTION))).not.toContain('banner:STORAGE');
  });
});

// ---------------------------------------------------------------------------
// Control values
// ---------------------------------------------------------------------------

describe('ArchivistSettingTab — getControlValue', () => {
  it('returns the value from the current build', () => {
    const { tab } = makeHarness({ settings: (s) => (s.retention.daily_days = 30) });
    tab.getSettingDefinitions();
    expect(tab.getControlValue('retention.daily_days')).toBe(30);
    expect(tab.getControlValue('ui.device_designated')).toBe(true);
  });

  it('reflects the latest settings after a rebuild', async () => {
    const h = makeHarness({ settings: (s) => (s.retention.daily_days = 30) });
    h.tab.getSettingDefinitions();
    await h.tab.setControlValue('retention.daily_days', 45);
    h.tab.getSettingDefinitions();
    expect(h.tab.getControlValue('retention.daily_days')).toBe(45);
  });

  it('returns undefined for an unknown key', () => {
    const { tab } = makeHarness();
    tab.getSettingDefinitions();
    expect(tab.getControlValue('nope.missing')).toBeUndefined();
  });
});

describe('ArchivistSettingTab — setControlValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the spec onChange exactly once for an accepted number', async () => {
    const h = makeHarness();
    h.tab.getSettingDefinitions();
    await h.tab.setControlValue('retention.daily_days', 45);
    expect(h.updateSettings).toHaveBeenCalledTimes(1);
    expect(h.ctx.getSettings().retention.daily_days).toBe(45);
  });

  it('coerces a numeric string for a number control, as the legacy text input did', async () => {
    const h = makeHarness();
    h.tab.getSettingDefinitions();
    await h.tab.setControlValue('retention.daily_days', '12');
    expect(h.ctx.getSettings().retention.daily_days).toBe(12);
  });

  it('keeps dropdown coercion in the section (day of week string → number)', async () => {
    const h = makeHarness();
    h.tab.getSettingDefinitions();
    await h.tab.setControlValue('schedule.full_day_of_week', '3');
    expect(h.updateSettings).toHaveBeenCalledTimes(1);
    expect(h.ctx.getSettings().schedule.full_day_of_week).toBe(3);
  });

  it('keeps glob splitting in the section (textarea lines trimmed, empties dropped)', async () => {
    const h = makeHarness();
    h.tab.getSettingDefinitions();
    await h.tab.setControlValue('advanced.exclusion_globs', ' a/**\n\n  b/*.md ');
    expect(h.ctx.getSettings().advanced.exclusion_globs).toEqual(['a/**', 'b/*.md']);
  });

  it.each([
    ['NaN', 'abc'],
    ['below min', -1],
    ['above max', 91],
  ])('silently drops a %s number', async (_label, value) => {
    const h = makeHarness();
    h.tab.getSettingDefinitions();
    await h.tab.setControlValue('retention.daily_days', value);
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);
    expect(h.updateSettings).not.toHaveBeenCalled();
    expect(h.tab._updateCalls).toBe(0);
  });

  it('silently drops a textarea value that fails validation', async () => {
    const h = makeHarness();
    h.tab.getSettingDefinitions();
    await h.tab.setControlValue('advanced.exclusion_globs', 'ok/**\n/abs/path');
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);
    expect(h.updateSettings).not.toHaveBeenCalled();
    expect(h.tab._updateCalls).toBe(0);
  });

  it('rejects a text value that fails validate (parity with Obsidian inline validation)', async () => {
    const h = makeHarness();
    h.tab.getSettingDefinitions();
    await h.tab.setControlValue('schedule.full_time_of_day', '25:99');
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  it('ignores an unknown key', async () => {
    const h = makeHarness();
    h.tab.getSettingDefinitions();
    await h.tab.setControlValue('nope.missing', 1);
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);
    expect(h.updateSettings).not.toHaveBeenCalled();
    expect(h.tab._updateCalls).toBe(0);
  });

  it('ui.device_designated on calls takeOwnership and writes no settings', async () => {
    const h = makeHarness({ deviceDesignated: false });
    h.tab.getSettingDefinitions();
    await h.tab.setControlValue('ui.device_designated', true);
    expect(h.takeOwnership).toHaveBeenCalledTimes(1);
    expect(h.releaseOwnership).not.toHaveBeenCalled();
    expect(h.updateSettings).not.toHaveBeenCalled();
    expect(h.ctx.deviceDesignated).toBe(true);
  });

  it('ui.device_designated off calls releaseOwnership and writes no settings', async () => {
    const h = makeHarness({ deviceDesignated: true });
    h.tab.getSettingDefinitions();
    await h.tab.setControlValue('ui.device_designated', false);
    expect(h.releaseOwnership).toHaveBeenCalledTimes(1);
    expect(h.takeOwnership).not.toHaveBeenCalled();
    expect(h.updateSettings).not.toHaveBeenCalled();
    expect(h.ctx.deviceDesignated).toBe(false);
  });

  it('schedules update() after every accepted write', async () => {
    const h = makeHarness();
    h.tab.getSettingDefinitions();
    await h.tab.setControlValue('notifications.toast_on_error', false);
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS - 1);
    expect(h.tab._updateCalls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(h.tab._updateCalls).toBe(1);

    await h.tab.setControlValue('notifications.toast_on_error', true);
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);
    expect(h.tab._updateCalls).toBe(2);
  });

  it('defers update() until a pending save has settled', async () => {
    const h = makeHarness();
    const save = deferred();
    h.ctx.updateSettings = () => save.promise;
    h.tab.getSettingDefinitions();

    const write = h.tab.setControlValue('notifications.toast_on_error', false);
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS + 1);
    expect(h.tab._updateCalls).toBe(0);

    save.resolve();
    await write;
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS + 1);
    expect(h.tab._updateCalls).toBe(1);
  });

  it('serializes quick designated toggles: last request wins even when ownership calls settle out of order', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = makeHarness({ deviceDesignated: false });
      const take = deferred();
      const release = deferred();
      const calls: string[] = [];
      h.ctx.device.takeOwnership = () => (calls.push('take'), take.promise);
      h.ctx.device.releaseOwnership = () => (calls.push('release'), release.promise);
      h.tab.getSettingDefinitions();

      const on = h.tab.setControlValue('ui.device_designated', true);
      const off = h.tab.setControlValue('ui.device_designated', false);
      release.resolve();
      await Promise.resolve();
      take.resolve();
      await Promise.all([on, off]);

      expect(calls).toEqual(['take', 'release']);
      expect(h.ctx.deviceDesignated).toBe(false);
      await flushRejections();
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps applying later writes after an earlier write failed', async () => {
    const h = makeHarness();
    h.failSaves(new Error('disk full'));
    h.tab.getSettingDefinitions();
    const first = h.tab.setControlValue('advanced.dry_run_mode', true);
    h.ctx.updateSettings = () => Promise.resolve();
    const second = h.tab.setControlValue('ui.device_designated', false);
    await Promise.all([first, second]);
    expect(h.ctx.deviceDesignated).toBe(false);
  });

  it('logs a failed write through the plugin logger with the key and without the value', async () => {
    const h = makeHarness();
    h.failSaves(new Error('disk full'));
    h.tab.getSettingDefinitions();
    await h.tab.setControlValue('advanced.vault_prefix', 'secret-prefix');

    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const [event, payload] = h.logger.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('setting_apply_failed');
    expect(payload).toMatchObject({ key: 'advanced.vault_prefix' });
    expect(JSON.stringify(payload)).not.toContain('secret-prefix');
  });

  it('coalesces rapid toggling inside 150 ms into one update() and saves the last value', async () => {
    const h = makeHarness();
    h.tab.getSettingDefinitions();
    await h.tab.setControlValue('schedule.active_window_enabled', true);
    vi.advanceTimersByTime(50);
    await h.tab.setControlValue('schedule.active_window_enabled', false);
    vi.advanceTimersByTime(50);
    await h.tab.setControlValue('schedule.active_window_enabled', true);
    vi.advanceTimersByTime(1000);
    expect(h.tab._updateCalls).toBe(1);
    expect(h.ctx.getSettings().schedule.active_window_enabled).toBe(true);
  });

  it('survives an updateSettings rejection: no unhandled rejection, one update(), no loop', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = makeHarness();
      h.failSaves(new Error('disk full'));
      h.tab.getSettingDefinitions();

      await expect(h.tab.setControlValue('advanced.dry_run_mode', true)).resolves.toBeUndefined();
      vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);
      expect(h.tab._updateCalls).toBe(1);
      vi.advanceTimersByTime(10 * UPDATE_DEBOUNCE_MS);
      expect(h.tab._updateCalls).toBe(1);
      expect(h.updateSettings).toHaveBeenCalledTimes(1);

      await flushRejections();
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('survives a takeOwnership rejection: no settings write, deviceDesignated unchanged', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = makeHarness({ deviceDesignated: false });
      h.failTakeOwnership(new Error('conflict'));
      h.tab.getSettingDefinitions();

      await expect(h.tab.setControlValue('ui.device_designated', true)).resolves.toBeUndefined();
      expect(h.updateSettings).not.toHaveBeenCalled();
      expect(h.ctx.deviceDesignated).toBe(false);
      h.tab.getSettingDefinitions();
      expect(h.tab.getControlValue('ui.device_designated')).toBe(false);

      await flushRejections();
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ---------------------------------------------------------------------------
// Class shape
// ---------------------------------------------------------------------------

describe('ArchivistSettingTab — class shape', () => {
  it('has no own display or hide member (declarative API only)', () => {
    const proto = ArchivistSettingTab.prototype as unknown as object;
    expect(Object.prototype.hasOwnProperty.call(proto, 'display')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(proto, 'hide')).toBe(false);
  });

  it('keeps the archivist-settings class on containerEl for scoped styles', () => {
    const { tab } = makeHarness();
    const el = tab.containerEl as unknown as { _classes: string[] };
    expect(el._classes).toContain('archivist-settings');
  });

  it('refresh() forces an update() after the async fetch even when nothing changed', async () => {
    vi.useFakeTimers();
    try {
      const { tab } = makeHarness();
      tab.getSettingDefinitions();
      await tab.refresh();
      vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);
      expect(tab._updateCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// persistentToBannerSpec (unchanged)
// ---------------------------------------------------------------------------

describe('SettingsTab — persistent-banner mapping', () => {
  it('maps a vault-mismatch banner to error severity and preserves the action', () => {
    const onClick = () => {};
    const spec = persistentToBannerSpec({
      code: 'VAULT_ID_MISMATCH',
      message: S.MISMATCH_BANNER,
      action: { label: S.MISMATCH_BANNER_RESOLVE, onClick },
    });
    expect(spec.severity).toBe('error');
    expect(spec.action).toEqual({ label: S.MISMATCH_BANNER_RESOLVE, onClick });
  });

  it('maps corrupt-remote metadata to error severity', () => {
    const spec = persistentToBannerSpec({
      code: 'VAULT_META_CORRUPT',
      message: S.REMOTE_CORRUPT_BANNER,
    });
    expect(spec.severity).toBe('error');
  });

  it('defaults unknown codes to warn severity', () => {
    const spec = persistentToBannerSpec({ code: 'CHAIN_RECOVERY', message: 'x' });
    expect(spec.severity).toBe('warn');
  });

  it('carries dismissLabel and onDismiss through unchanged', () => {
    const onDismiss = () => {};
    const spec = persistentToBannerSpec({ code: 'X', message: 'm', dismissLabel: 'Hide', onDismiss });
    expect(spec).toMatchObject({ kind: 'banner', code: 'X', message: 'm', dismissLabel: 'Hide', onDismiss });
  });
});
