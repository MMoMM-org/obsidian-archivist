// T5.3 (spec 002) — whole-tab integration test from a 0.11.x data.json.
//
// Upgrade safety for the declarative settings tab (PRD F1 AC1, F2 AC1-3; SDD
// Quality Requirements → Reliability). A data.json captured in the 0.11.x
// on-disk shape (tests/fixtures/settings-0.11.x.data.json, every field set to
// a non-default value) is loaded through the real PluginStore.loadSettings —
// the function main.ts calls at onload — and handed to the real
// ArchivistSettingTab with all five real sections. Writes go back through the
// same merge-then-saveSettings path main.ts wires into SettingsContext, so a
// round-trip proves each control still saves to the PluginSettings path it
// saved to in 0.11.x. Only the boundaries are faked: Obsidian's
// loadData/saveData (a JSON-serialising in-memory disk), the adapter, the
// device / Dropbox / OAuth surfaces and the NoticeCenter.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { Setting, _reconcileRenderRow, type MockEl } from '../fixtures/obsidian-mock';
import { ArchivistSettingTab } from '../../src/ui/SettingsTab';
import type { NoticeCenter, PersistentBanner } from '../../src/ui/NoticeCenter';
import type { SettingsContext } from '../../src/ui/settings/context';
import { PluginStore } from '../../src/infra/PluginStore';
import { DEFAULT_SETTINGS, type PluginSettings } from '../../src/model/Settings';
import { S } from '../../src/ui/strings';

const GB = 1024 * 1024 * 1024;
const FIXTURE_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../fixtures/settings-0.11.x.data.json',
);

type Json = Record<string, unknown>;

function readFixture(): Json {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Json;
}

/** Value at a dotted path (`retention.daily_days`) inside a settings object. */
function at(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Json | undefined)?.[k], obj);
}

/** Deep copy of `obj` with the dotted `path` set to `value`. */
function withPath<T>(obj: T, path: string, value: unknown): T {
  const copy = structuredClone(obj) as Json;
  const keys = path.split('.');
  const last = keys.pop() as string;
  const parent = keys.reduce<Json>((o, k) => o[k] as Json, copy);
  parent[last] = value;
  return copy as T;
}

// ---------------------------------------------------------------------------
// Harness — real PluginStore + real tab, fake Obsidian disk and surfaces
// ---------------------------------------------------------------------------

interface Disk {
  /** What Obsidian would read back from data.json (a fresh parse each time). */
  read: () => Json;
}

interface IntegrationHarness {
  tab: ArchivistSettingTab;
  ctx: SettingsContext;
  store: PluginStore;
  disk: Disk;
  /** The settings loadSettings returned at "onload". */
  loaded: PluginSettings;
  takeOwnership: ReturnType<typeof vi.fn>;
  releaseOwnership: ReturnType<typeof vi.fn>;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
}

interface IntegrationOptions {
  usedBytes?: number;
  email?: string | null;
  banners?: PersistentBanner[];
}

async function bootFromFixture(opts: IntegrationOptions = {}): Promise<IntegrationHarness> {
  // loadData/saveData serialise through JSON like Obsidian's data.json does.
  let onDisk = JSON.stringify(readFixture());
  const disk: Disk = { read: () => JSON.parse(onDisk) as Json };
  const adapterFiles = new Map<string, string>();
  const plugin = {
    manifest: {
      id: 'archivist',
      dir: '.obsidian/plugins/archivist',
      name: 'Archivist',
      version: '0.12.0',
      author: 'Marcus <marcus@example.org>',
      authorUrl: 'https://example.org/marcus',
    },
    app: {
      vault: {
        configDir: '.obsidian',
        adapter: {
          read: async (p: string) => adapterFiles.get(p) ?? '',
          write: async (p: string, data: string) => {
            adapterFiles.set(p, data);
          },
          exists: async (p: string) => adapterFiles.has(p),
          remove: async (p: string) => {
            adapterFiles.delete(p);
          },
        },
      },
    },
    loadData: async () => disk.read(),
    saveData: async (data: unknown) => {
      onDisk = JSON.stringify(data);
    },
  } as unknown as Plugin;

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const store = new PluginStore(plugin, logger);
  const loaded = await store.loadSettings();

  // Mirrors main.ts Step 15: an in-memory cache, merged then persisted.
  const cachedRef = { settings: loaded };
  const takeOwnership = vi.fn();
  const releaseOwnership = vi.fn();
  const email = opts.email ?? null;
  const ctx: SettingsContext = {
    getSettings: () => cachedRef.settings,
    updateSettings: async (patch) => {
      const merged = { ...cachedRef.settings, ...patch };
      cachedRef.settings = merged;
      await store.saveSettings(merged);
    },
    deviceDesignated: true,
    dropboxAccountEmail: null,
    dropboxUsedBytes: opts.usedBytes ?? 0,
    device: {
      isDesignated: async () => true,
      takeOwnership: () => {
        takeOwnership();
        return Promise.resolve();
      },
      releaseOwnership: () => {
        releaseOwnership();
        return Promise.resolve();
      },
    },
    dropbox: {
      getAccountEmail: async () => email,
      disconnect: async () => {},
      getUsedBytes: async () => opts.usedBytes ?? 0,
    },
    oauth: { isConnected: async () => email !== null, beginAuth: async () => {} },
    getRetentionProfile: () => ({ vault_bytes: 2 * GB, avg_edits_per_day: 40 }),
    estimateRetention: () => ({ snapshots: 123, gb: 4.5 }),
    confirm: async () => true,
  };

  const banners = opts.banners ?? [];
  const noticeCenter = {
    getPersistentBanners: () => banners,
    subscribePersistentBanners: () => () => {},
  } as unknown as NoticeCenter;

  const tab = new ArchivistSettingTab({} as App, {
    plugin,
    noticeCenter,
    context: ctx,
    logger,
    register: () => {},
  });
  return { tab, ctx, store, disk, loaded, takeOwnership, releaseOwnership, logger };
}

function groupsOf(tab: ArchivistSettingTab): SettingDefinitionGroup[] {
  return tab.getSettingDefinitions() as SettingDefinitionGroup[];
}

function itemsOf(group: SettingDefinitionGroup): SettingDefinition[] {
  return (group.items ?? []) as SettingDefinition[];
}

function groupByHeading(tab: ArchivistSettingTab, heading: string): SettingDefinitionGroup {
  const group = groupsOf(tab).find((g) => g.heading === heading);
  if (!group) throw new Error(`no group "${heading}"`);
  return group;
}

function allRows(tab: ArchivistSettingTab): SettingDefinition[] {
  return groupsOf(tab).flatMap(itemsOf);
}

function renderedStaticText(row: SettingDefinition): string {
  const setting = new Setting({});
  (row as SettingDefinitionRender).render(setting as unknown as ObsidianSetting, {} as SettingGroup);
  const root = setting.settingEl as unknown as MockEl;
  return root.querySelectorAll('.archivist-static-text').map((p) => p.textContent).join('\n');
}

// ---------------------------------------------------------------------------
// Expectations — written out literally so a renamed key or label fails here
// ---------------------------------------------------------------------------

/** PRD "Settings inventory", grouped as the tab shows it. */
const INVENTORY: ReadonlyArray<{ heading: string; labels: readonly string[] }> = [
  {
    heading: 'Schedule',
    labels: [
      'This device backs up the vault',
      'Full backup cadence',
      'Full backup day',
      'Full backup time (local)',
      'Incremental backup interval',
      'Startup grace period (minutes)',
      'Quiet period after edits (minutes)',
      'Active backup window',
      'Active window start',
      'Active window end',
    ],
  },
  {
    heading: 'Retention',
    labels: [
      'Always keep most-recent snapshots',
      'Recent high-frequency window (hours)',
      'Never-prune window (days)',
      'Daily retention (days)',
      'Monthly retention (years)',
      'Hard storage limit (GB)',
      'Warn at percent of cap',
    ],
  },
  {
    heading: 'Notifications',
    labels: [
      'Show pre-flight notice before full backups',
      'Show toast after incremental backup',
      'Show toast after full backup',
      'Show toast on error',
    ],
  },
  {
    heading: 'Advanced',
    labels: [
      'Exclusion globs',
      'Enable reconcile scan on startup',
      'Dry-run mode (no uploads)',
      'Diagnostic logging (paths visible in logs)',
      'Dropbox vault folder',
      'Concurrent uploads',
      'Upload chunk size (MB)',
    ],
  },
  {
    heading: 'Dropbox account',
    labels: ['Account', 'How tokens are stored →'],
  },
];

interface ControlCase {
  /** Control key, which is also the PluginSettings path it persists to. */
  key: string;
  /** What getControlValue must return for the fixture's stored value. */
  shown: unknown;
  /** A different valid value written through setControlValue. */
  write: unknown;
  /** What must land at `key` in data.json's `settings` after the write. */
  stored: unknown;
}

/** Every persisted control, in tab order. `ui.device_designated` is covered separately. */
const CONTROLS: readonly ControlCase[] = [
  { key: 'schedule.full_cadence', shown: 'biweekly', write: 'monthly', stored: 'monthly' },
  { key: 'schedule.full_day_of_week', shown: '3', write: '5', stored: 5 },
  { key: 'schedule.full_time_of_day', shown: '02:30', write: '04:10', stored: '04:10' },
  { key: 'schedule.inc_interval_minutes', shown: '30', write: '60', stored: 60 },
  { key: 'schedule.startup_grace_minutes', shown: 20, write: 30, stored: 30 },
  { key: 'schedule.quiet_after_event_minutes', shown: 5, write: 10, stored: 10 },
  { key: 'schedule.active_window_enabled', shown: true, write: false, stored: false },
  { key: 'schedule.active_window_start', shown: '07:15', write: '06:00', stored: '06:00' },
  { key: 'schedule.active_window_end', shown: '23:45', write: '21:00', stored: '21:00' },
  { key: 'retention.always_keep_n', shown: 5, write: 8, stored: 8 },
  { key: 'retention.recent_hours', shown: 48, write: 72, stored: 72 },
  { key: 'retention.never_prune_window_days', shown: 7, write: 10, stored: 10 },
  { key: 'retention.daily_days', shown: 45, write: 60, stored: 60 },
  { key: 'retention.monthly_years', shown: 5, write: 7, stored: 7 },
  { key: 'retention.storage_hard_limit_gb', shown: 50, write: 75, stored: 75 },
  { key: 'retention.storage_warn_at_percent', shown: 90, write: 70, stored: 70 },
  { key: 'notifications.preflight_notice_enabled', shown: false, write: true, stored: true },
  { key: 'notifications.toast_after_inc', shown: true, write: false, stored: false },
  { key: 'notifications.toast_after_full', shown: false, write: true, stored: true },
  { key: 'notifications.toast_on_error', shown: false, write: true, stored: true },
  {
    key: 'advanced.exclusion_globs',
    shown: 'Private/**\n*.tmp',
    write: 'Archive/**\n\n  *.bak  ',
    stored: ['Archive/**', '*.bak'],
  },
  { key: 'advanced.reconcile_scan_enabled', shown: false, write: true, stored: true },
  { key: 'advanced.dry_run_mode', shown: true, write: false, stored: false },
  { key: 'advanced.diagnostic_logging', shown: true, write: false, stored: false },
  { key: 'advanced.vault_prefix', shown: 'my-vault_01', write: 'other-vault', stored: 'other-vault' },
  { key: 'advanced.upload_parallelism', shown: 4, write: 6, stored: 6 },
  { key: 'advanced.chunk_size_mb', shown: 16, write: 32, stored: 32 },
];

/** Text-entry rows that must stay Obsidian-owned controls (typing survives refresh). */
const TEXT_ENTRY_ROWS: ReadonlyArray<{ key: string; type: string }> = [
  { key: 'advanced.vault_prefix', type: 'text' },
  { key: 'schedule.full_time_of_day', type: 'text' },
  { key: 'schedule.active_window_start', type: 'text' },
  { key: 'schedule.active_window_end', type: 'text' },
  { key: 'advanced.exclusion_globs', type: 'textarea' },
  { key: 'schedule.startup_grace_minutes', type: 'number' },
  { key: 'schedule.quiet_after_event_minutes', type: 'number' },
  { key: 'retention.always_keep_n', type: 'number' },
  { key: 'retention.recent_hours', type: 'number' },
  { key: 'retention.never_prune_window_days', type: 'number' },
  { key: 'retention.daily_days', type: 'number' },
  { key: 'retention.monthly_years', type: 'number' },
  { key: 'retention.storage_hard_limit_gb', type: 'number' },
  { key: 'retention.storage_warn_at_percent', type: 'number' },
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixture + loader
// ---------------------------------------------------------------------------

describe('0.11.x data.json fixture', () => {
  it('sets every settings field to a non-default value', () => {
    const settings = readFixture().settings;
    for (const { key } of CONTROLS) {
      expect(at(settings, key), key).not.toEqual(at(DEFAULT_SETTINGS, key));
    }
    expect(at(settings, 'ui.preview_plugin_advisory_dismissed')).not.toBe(
      DEFAULT_SETTINGS.ui.preview_plugin_advisory_dismissed,
    );
  });

  it('loads through PluginStore.loadSettings unchanged, without the corrupt-settings fallback', async () => {
    const h = await bootFromFixture();
    expect(h.loaded).toEqual(readFixture().settings);
    expect(h.logger.warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Structure and inventory
// ---------------------------------------------------------------------------

describe('ArchivistSettingTab from a 0.11.x data.json — structure', () => {
  it('shows the untitled top group, then the five sections in the 0.11.x order', async () => {
    const h = await bootFromFixture();
    expect(groupsOf(h.tab).map((g) => g.heading)).toEqual([
      undefined,
      S.SETTINGS_SECTION_SCHEDULE,
      S.SETTINGS_SECTION_RETENTION,
      S.SETTINGS_SECTION_NOTIFICATIONS,
      S.SETTINGS_SECTION_ADVANCED,
      S.SETTINGS_SECTION_DROPBOX,
    ]);
  });

  it.each(INVENTORY)('lists every $heading inventory label as a searchable definition', async ({ heading, labels }) => {
    const h = await bootFromFixture();
    const rows = itemsOf(groupByHeading(h.tab, heading));
    for (const label of labels) {
      const row = rows.find((d) => d.name === label);
      expect(row, `missing "${label}" in ${heading}`).toBeDefined();
      expect(row?.searchable, `"${label}" is not searchable`).not.toBe(false);
    }
  });

  it('shows the conditional active-window rows while the stored toggle is on, and hides them once it is off', async () => {
    const h = await bootFromFixture();
    const rows = itemsOf(groupByHeading(h.tab, S.SETTINGS_SECTION_SCHEDULE));
    const conditional = rows.filter((d) => d.name === 'Active window start' || d.name === 'Active window end');
    expect(conditional).toHaveLength(2);
    for (const row of conditional) expect(typeof row.visible === 'function' && row.visible()).toBe(true);

    await h.tab.setControlValue('schedule.active_window_enabled', false);
    for (const row of conditional) expect(typeof row.visible === 'function' && row.visible()).toBe(false);
  });

  it('marks the header, banner, static and estimate rows searchable:false', async () => {
    const banner: PersistentBanner = { code: 'AUTH_LOST', message: 'Reconnect Dropbox' } as PersistentBanner;
    const h = await bootFromFixture({ banners: [banner], usedBytes: 50 * GB });
    const [top] = groupsOf(h.tab);
    const topNames = itemsOf(top).map((d) => d.name);
    expect(topNames).toEqual(['header', 'banner:AUTH_LOST']);

    const nonInput = allRows(h.tab).filter(
      (d) => d.name === 'header' || d.name.startsWith('banner:') || d.name.startsWith('static:'),
    );
    expect(nonInput.map((d) => d.name)).toEqual(
      expect.arrayContaining(['header', 'banner:AUTH_LOST', 'banner:STORAGE']),
    );
    for (const row of nonInput) expect(row.searchable, row.name).toBe(false);

    const retentionStatics = itemsOf(groupByHeading(h.tab, S.SETTINGS_SECTION_RETENTION)).filter((d) =>
      d.name.startsWith('static:'),
    );
    expect(retentionStatics).toHaveLength(1);
    expect(renderedStaticText(retentionStatics[0])).toContain('Estimate: ~123 snapshots kept, ~4.5 GB');
    expect(retentionStatics[0].searchable).toBe(false);
  });

  it('keeps the Account and documentation-link rows as the only searchable non-input rows', async () => {
    const h = await bootFromFixture();
    const searchableRender = allRows(h.tab).filter((d) => !d.control && d.searchable !== false);
    expect(searchableRender.map((d) => d.name)).toEqual(['Account', S.OAUTH_TOKEN_DISCLOSURE_LINK_LABEL]);
  });

  it.each(TEXT_ENTRY_ROWS)('emits $key as a $type control row, never a render row', async ({ key, type }) => {
    const h = await bootFromFixture();
    const row = allRows(h.tab).find((d) => d.control?.key === key);
    expect(row, `no control row for ${key}`).toBeDefined();
    expect(row?.control?.type).toBe(type);
    expect(row).not.toHaveProperty('render');
  });

  it('exposes the Account row while Dropbox is disconnected', async () => {
    const h = await bootFromFixture({ email: null });
    const account = itemsOf(groupByHeading(h.tab, S.SETTINGS_SECTION_DROPBOX)).find((d) => d.name === 'Account');
    expect(account?.searchable).not.toBe(false);
    expect(account?.desc).toBe(S.OAUTH_NOT_CONNECTED);
  });

  it('exposes the Account row once Dropbox is connected', async () => {
    const h = await bootFromFixture({ email: 'user@example.org' });
    await h.tab.refresh();
    const account = itemsOf(groupByHeading(h.tab, S.SETTINGS_SECTION_DROPBOX)).find((d) => d.name === 'Account');
    expect(account?.searchable).not.toBe(false);
    expect(account?.desc).toBe(S.OAUTH_CONNECTED_AS('user@example.org'));
  });

  // Fixture: 50 GB hard limit, warn at 90 % → threshold 45 GB.
  it('shows the STORAGE banner in the Retention group with usage at the stored threshold', async () => {
    const h = await bootFromFixture({ usedBytes: 45 * GB });
    const retention = itemsOf(groupByHeading(h.tab, S.SETTINGS_SECTION_RETENTION)).map((d) => d.name);
    expect(retention[0]).toBe('banner:STORAGE');
    const elsewhere = groupsOf(h.tab)
      .filter((g) => g.heading !== S.SETTINGS_SECTION_RETENTION)
      .flatMap(itemsOf)
      .map((d) => d.name);
    expect(elsewhere).not.toContain('banner:STORAGE');
  });

  it('omits the STORAGE banner with usage just below the stored threshold', async () => {
    const h = await bootFromFixture({ usedBytes: 45 * GB - 1 });
    expect(allRows(h.tab).map((d) => d.name)).not.toContain('banner:STORAGE');
  });
});

// ---------------------------------------------------------------------------
// Values and round-trip
// ---------------------------------------------------------------------------

describe('ArchivistSettingTab from a 0.11.x data.json — values', () => {
  it('emits exactly the 0.11.x control keys, no more and no fewer', async () => {
    const h = await bootFromFixture();
    const keys = allRows(h.tab).flatMap((d) => (d.control ? [d.control.key] : []));
    expect(keys).toEqual(['ui.device_designated', ...CONTROLS.map((c) => c.key)]);
  });

  it.each(CONTROLS)('getControlValue($key) shows the stored value', async ({ key, shown }) => {
    const h = await bootFromFixture();
    h.tab.getSettingDefinitions();
    expect(h.tab.getControlValue(key)).toEqual(shown);
  });

  it.each(CONTROLS)(
    'setControlValue($key) saves to the same data.json path and resets nothing else',
    async ({ key, write, stored }) => {
      const h = await bootFromFixture();
      const before = h.disk.read();
      h.tab.getSettingDefinitions();
      await h.tab.setControlValue(key, write);

      const after = h.disk.read();
      expect(at(after.settings, key)).toEqual(stored);
      expect(after.settings).toEqual(withPath(before.settings, key, stored));
      expect(after.vault_id).toBe(before.vault_id);
      expect(after.schema_version).toBe(before.schema_version);
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
      expect(await h.store.loadSettings()).toEqual(withPath(h.loaded, key, stored));
    },
  );

  it('ui.device_designated routes to device ownership and leaves data.json untouched', async () => {
    const h = await bootFromFixture();
    const before = h.disk.read();
    h.tab.getSettingDefinitions();
    expect(h.tab.getControlValue('ui.device_designated')).toBe(true);

    await h.tab.setControlValue('ui.device_designated', false);
    expect(h.releaseOwnership).toHaveBeenCalledTimes(1);
    await h.tab.setControlValue('ui.device_designated', true);
    expect(h.takeOwnership).toHaveBeenCalledTimes(1);
    expect(h.disk.read()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Render rows across update() (T5.4 regression: duplicated header / static text)
// ---------------------------------------------------------------------------

/** A MockEl subtree as plain data, for "looks identical" comparisons. */
function snapshot(node: MockEl): unknown {
  return { tag: node.tagName, cls: node.className, text: node.textContent, kids: node.children.map(snapshot) };
}

/** One render pass, keyed by name like Obsidian: same key → same Setting. */
function renderPass(tab: ArchivistSettingTab, settings: Map<string, Setting>, runCleanup = true): void {
  for (const row of allRows(tab)) {
    if (!('render' in row) || typeof row.render !== 'function') continue;
    const setting = settings.get(row.name) ?? new Setting({});
    settings.set(row.name, setting);
    _reconcileRenderRow(setting, row as SettingDefinitionRender & { desc?: string }, { runCleanup });
  }
}

describe('ArchivistSettingTab from a 0.11.x data.json — render rows across update()', () => {
  it('toggling the active window on/off/on leaves every render row exactly as first drawn', async () => {
    const h = await bootFromFixture({ email: 'user@example.org' });
    await h.tab.refresh();
    const settings = new Map<string, Setting>();
    renderPass(h.tab, settings);
    const first = new Map([...settings].map(([name, s]) => [name, snapshot(s.settingEl as unknown as MockEl)]));

    for (const on of [false, true, false, true]) {
      await h.tab.setControlValue('schedule.active_window_enabled', on);
      renderPass(h.tab, settings);
    }

    const root = (name: string): MockEl => settings.get(name)?.settingEl as unknown as MockEl;
    expect(root('header').querySelectorAll('.archivist-version-header')).toHaveLength(1);
    const disclosure = [...settings.keys()].filter((name) =>
      root(name).querySelectorAll('.archivist-static-text').some((p) => p.textContent === S.OAUTH_TOKEN_DISCLOSURE),
    );
    expect(disclosure).toHaveLength(1);
    expect(root(disclosure[0]).querySelectorAll('.archivist-static-text')).toHaveLength(1);
    for (const [name, setting] of settings) {
      expect(snapshot(setting.settingEl as unknown as MockEl), name).toEqual(first.get(name));
    }
  });
  // A runtime that runs cleanups only on teardown must not stack rows either.
  it('the same toggle sequence without the cleanups between passes still leaves one copy of each row', async () => {
    const h = await bootFromFixture({ email: 'user@example.org' });
    await h.tab.refresh();
    const settings = new Map<string, Setting>();
    renderPass(h.tab, settings, false);
    const first = new Map([...settings].map(([name, s]) => [name, snapshot(s.settingEl as unknown as MockEl)]));

    for (const on of [false, true, false, true]) {
      await h.tab.setControlValue('schedule.active_window_enabled', on);
      renderPass(h.tab, settings, false);
    }

    const root = (name: string): MockEl => settings.get(name)?.settingEl as unknown as MockEl;
    expect(root('header').querySelectorAll('.archivist-version-header')).toHaveLength(1);
    const tokens = [...settings.values()].flatMap((s) =>
      (s.settingEl as unknown as MockEl)
        .querySelectorAll('.archivist-static-text')
        .filter((p) => p.textContent === S.OAUTH_TOKEN_DISCLOSURE),
    );
    expect(tokens).toHaveLength(1);
    for (const [name, setting] of settings) {
      expect(snapshot(setting.settingEl as unknown as MockEl), name).toEqual(first.get(name));
    }
  });
});
