// T2.2 (spec 002) — DefinitionBuilderHost: FieldSpec stream → Obsidian
// SettingDefinitionItem[] + key registry, and the pure write guard that
// Phase 3's setControlValue runs before calling spec.onChange.

import { describe, expect, it, vi } from 'vitest';
import type {
  Setting,
  SettingDefinition,
  SettingDefinitionGroup,
  SettingDefinitionRender,
  SettingGroup,
} from 'obsidian';
import { DefinitionBuilderHost, guardWrite } from '../../src/ui/settings/DefinitionBuilderHost';
import type { CustomRowRenderers, HeaderInfo, BannerSpec } from '../../src/ui/settings/SectionHost';
import { renderBackupSchedule } from '../../src/ui/settings/sections/BackupSchedule';
import type { SettingsContext } from '../../src/ui/settings/context';
import { DEFAULT_SETTINGS } from '../../src/model/Settings';
import { S } from '../../src/ui/strings';

const INFO: HeaderInfo = { pluginName: 'Archivist', version: '1.2.3', docsUrl: 'https://x' };
const FAKE_SETTING = {} as Setting;
const FAKE_GROUP = {} as SettingGroup;

function fakeRenderers(): CustomRowRenderers & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const rec = (name: string) => (_s: Setting, arg: unknown) => {
    calls.push([name, arg]);
  };
  return {
    calls,
    header: rec('header'),
    banner: rec('banner'),
    static: rec('static'),
    link: rec('link'),
    actionRow: rec('actionRow'),
  };
}

function banner(code: string): BannerSpec {
  return { kind: 'banner', code, message: `msg ${code}`, severity: 'warn' };
}

function groups(b: DefinitionBuilderHost): SettingDefinitionGroup[] {
  return b.result().items as SettingDefinitionGroup[];
}

function itemsOf(g: SettingDefinitionGroup): SettingDefinition[] {
  return (g.items ?? []) as SettingDefinition[];
}

function stubContext(): SettingsContext {
  return {
    getSettings: () => DEFAULT_SETTINGS,
    updateSettings: async () => {},
    deviceId: 'd0',
    deviceDesignated: true,
    dropboxAccountEmail: null,
    dropboxUsedBytes: 0,
    device: {
      getDeviceId: async () => 'd0',
      isDesignated: async () => true,
      takeOwnership: async () => {},
      releaseOwnership: async () => {},
    },
    dropbox: { getAccountEmail: async () => null, disconnect: async () => {}, getUsedBytes: async () => 0 },
    oauth: { isConnected: async () => false, beginAuth: async () => {} },
    getRetentionProfile: () => ({ vault_bytes: 0, avg_edits_per_day: 0 }),
    estimateRetention: () => ({ snapshots: 0, gb: 0 }),
    copyToClipboard: async () => {},
    confirm: async () => true,
  };
}

describe('DefinitionBuilderHost — group structure', () => {
  it('heading() opens a new group carrying that heading', () => {
    const b = new DefinitionBuilderHost(fakeRenderers());
    b.heading('Retention');
    b.field({ kind: 'toggle', key: 'a.b', label: 'A', value: true, onChange: () => {} });
    b.heading('Advanced');

    const [top, retention, advanced] = groups(b);
    expect(top).toMatchObject({ type: 'group' });
    expect(top?.heading).toBeUndefined();
    expect(retention).toMatchObject({ type: 'group', heading: 'Retention' });
    expect(itemsOf(retention!)).toHaveLength(1);
    expect(advanced).toMatchObject({ type: 'group', heading: 'Advanced', items: [] });
  });

  it('header() and topBanner() land in the untitled first group, header first', () => {
    const r = fakeRenderers();
    const b = new DefinitionBuilderHost(r);
    b.topBanner(banner('b1'));
    b.heading('Schedule');
    b.topBanner(banner('b2'));
    b.header(INFO);

    const [top, schedule] = groups(b);
    expect(itemsOf(top!).map((d) => d.name)).toEqual(['header', 'banner:b1', 'banner:b2']);
    expect(itemsOf(schedule!)).toEqual([]);
  });

  it('a top group with zero banners holds only the header', () => {
    const b = new DefinitionBuilderHost(fakeRenderers());
    b.header(INFO);
    b.heading('Schedule');
    const [top] = groups(b);
    expect(itemsOf(top!).map((d) => d.name)).toEqual(['header']);
  });

  it('emits a group whose rows are all hidden, keeping every predicate', () => {
    const hidden = (): boolean => false;
    const b = new DefinitionBuilderHost(fakeRenderers());
    b.heading('Window');
    b.field({ kind: 'text', key: 'w.start', label: 'Start', value: '', visible: hidden, onChange: () => {} });
    b.field({ kind: 'text', key: 'w.end', label: 'End', value: '', visible: hidden, onChange: () => {} });

    const [, win] = groups(b);
    expect(win?.heading).toBe('Window');
    expect(itemsOf(win!).map((d) => d.visible)).toEqual([hidden, hidden]);
  });
});

describe('DefinitionBuilderHost — input kinds become control rows', () => {
  function single(spec: Parameters<DefinitionBuilderHost['field']>[0]): SettingDefinition {
    const b = new DefinitionBuilderHost(fakeRenderers());
    b.heading('S');
    b.field(spec);
    return itemsOf(groups(b)[1]!)[0]!;
  }

  it('text → control text with key and placeholder', () => {
    const d = single({ kind: 'text', key: 'k.t', label: 'T', value: '', placeholder: 'hh:mm', onChange: () => {} });
    expect(d).toMatchObject({ name: 'T', control: { type: 'text', key: 'k.t', placeholder: 'hh:mm' } });
  });

  it('toggle → control toggle with key', () => {
    const d = single({ kind: 'toggle', key: 'k.g', label: 'G', value: false, onChange: () => {} });
    expect(d).toMatchObject({ control: { type: 'toggle', key: 'k.g' } });
  });

  it('number → control number with key, min, max and step', () => {
    const d = single({ kind: 'number', key: 'k.n', label: 'N', value: 3, min: 1, max: 60, step: 1, onChange: () => {} });
    expect(d).toMatchObject({ control: { type: 'number', key: 'k.n', min: 1, max: 60, step: 1 } });
  });

  it('dropdown → control dropdown with an options record', () => {
    const d = single({
      kind: 'dropdown', key: 'k.d', label: 'D', value: 'weekly', onChange: () => {},
      options: [{ value: 'weekly', label: 'Weekly' }, { value: 'biweekly', label: 'Every 2 weeks' }, { value: 'monthly', label: 'Monthly' }],
    });
    expect(d).toMatchObject({ control: { type: 'dropdown', key: 'k.d' } });
    const control = (d as { control: { options: Record<string, string> } }).control;
    expect(Object.entries(control.options)).toEqual([
      ['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Monthly'],
    ]);
  });

  it('textarea → control textarea with key', () => {
    const d = single({ kind: 'textarea', key: 'k.a', label: 'A', value: '', onChange: () => {} });
    expect(d).toMatchObject({ control: { type: 'textarea', key: 'k.a' } });
  });

  it('slider → control slider with key, min, max and step', () => {
    const d = single({ kind: 'slider', key: 'k.s', label: 'S', value: 2, min: 0, max: 10, step: 2, onChange: () => {} });
    expect(d).toMatchObject({ control: { type: 'slider', key: 'k.s', min: 0, max: 10, step: 2 } });
  });

  it('text validate: null maps to undefined, a message passes through', () => {
    const d = single({
      kind: 'text', key: 'k.v', label: 'V', value: '', onChange: () => {},
      validate: (v) => (v === 'ok' ? null : 'bad value'),
    });
    const validate = (d as { control: { validate?: (v: string) => unknown } }).control.validate;
    expect(validate?.('ok')).toBeUndefined();
    expect(validate?.('nope')).toBe('bad value');
  });

  // #111: number and textarea rejections used to be silent — the typed value
  // stayed in the field but was never saved. Obsidian shows a string returned
  // by control.validate as an inline error, so both kinds must provide one.
  it('number validate: explains NaN, out-of-range and validator failures', () => {
    const d = single({
      kind: 'number', key: 'k.n', label: 'N', value: 5, min: 1, max: 60, onChange: () => {},
      validate: (n) => (n === 13 ? 'not 13' : null),
    });
    const validate = (d as { control: { validate?: (v: number) => unknown } }).control.validate;
    expect(validate).toBeDefined();
    expect(validate?.(Number.NaN)).toBe(S.SETTINGS_NUMBER_INVALID);
    expect(validate?.(0)).toBe(S.SETTINGS_NUMBER_MIN(1));
    expect(validate?.(61)).toBe(S.SETTINGS_NUMBER_MAX(60));
    expect(validate?.(13)).toBe('not 13');
    expect(validate?.(1)).toBeUndefined();
    expect(validate?.(60)).toBeUndefined();
  });

  it('number validate: bounds are optional', () => {
    const d = single({ kind: 'number', key: 'k.n', label: 'N', value: 5, onChange: () => {} });
    const validate = (d as { control: { validate?: (v: number) => unknown } }).control.validate;
    expect(validate?.(-1000)).toBeUndefined();
    expect(validate?.(Number.NaN)).toBe(S.SETTINGS_NUMBER_INVALID);
  });

  it('textarea validate: passes the spec validator message through', () => {
    const d = single({
      kind: 'textarea', key: 'k.a', label: 'A', value: '', onChange: () => {},
      validate: (v) => (v.includes('[') ? 'bad glob' : null),
    });
    const validate = (d as { control: { validate?: (v: string) => unknown } }).control.validate;
    expect(validate?.('a[')).toBe('bad glob');
    expect(validate?.('ok/**')).toBeUndefined();
  });

  it('copies name, desc, aliases and visible from the spec', () => {
    const visible = (): boolean => true;
    const d = single({
      kind: 'toggle', key: 'k.m', label: 'Label', description: 'Desc', aliases: ['alt'], visible,
      value: true, onChange: () => {},
    });
    expect(d).toMatchObject({ name: 'Label', desc: 'Desc', aliases: ['alt'], visible });
  });

  it('every text-entry kind is a control row, never a render row', () => {
    for (const kind of ['text', 'textarea', 'number'] as const) {
      const spec = kind === 'number'
        ? { kind, key: 'x', label: 'X', value: 0, onChange: () => {} }
        : { kind, key: 'x', label: 'X', value: '', onChange: () => {} };
      const d = single(spec);
      expect('control' in d).toBe(true);
      expect('render' in d).toBe(false);
    }
  });
});

describe('DefinitionBuilderHost — dropdown option order for the real option sets', () => {
  function controlOptions(key: string): string[] {
    const b = new DefinitionBuilderHost(fakeRenderers());
    renderBackupSchedule(b, stubContext());
    const def = itemsOf(groups(b)[1]!).find(
      (d) => 'control' in d && d.control?.key === key,
    ) as { control: { options: Record<string, string> } } | undefined;
    return Object.keys(def?.control.options ?? {});
  }

  it('day-of-week keeps "0"–"6" in emitted order', () => {
    expect(controlOptions('schedule.full_day_of_week')).toEqual(['0', '1', '2', '3', '4', '5', '6']);
  });

  it('incremental interval keeps "5", "15", "30", "60" in emitted order', () => {
    expect(controlOptions('schedule.inc_interval_minutes')).toEqual(['5', '15', '30', '60']);
  });
});

describe('DefinitionBuilderHost — non-input kinds become render rows', () => {
  function rows(): { defs: SettingDefinitionRender[]; r: ReturnType<typeof fakeRenderers> } {
    const r = fakeRenderers();
    const b = new DefinitionBuilderHost(r);
    b.header(INFO);
    b.topBanner(banner('quota'));
    b.field({ kind: 'static', text: 'top note' });
    b.heading('Retention');
    b.field({ kind: 'static', text: 'first' });
    b.field({ kind: 'link', label: 'Docs', href: 'https://d' });
    b.field({ kind: 'static', text: 'second' });
    b.field({ kind: 'actionRow', label: 'Account', description: 'Connected', actions: [] });
    b.field(banner('inline'));
    const defs = groups(b).flatMap(itemsOf) as SettingDefinitionRender[];
    return { defs, r };
  }

  it('header, banner and static rows are unsearchable with internal names', () => {
    const { defs } = rows();
    const internal = defs.filter((d) => d.searchable === false).map((d) => d.name);
    expect(internal).toEqual([
      'header', 'banner:quota', 'static:top:0',
      'static:Retention:0', 'static:Retention:1', 'banner:inline',
    ]);
  });

  it('link and actionRow stay searchable with name = label', () => {
    const { defs } = rows();
    const link = defs.find((d) => d.name === 'Docs');
    const action = defs.find((d) => d.name === 'Account');
    expect(link?.searchable).not.toBe(false);
    expect(action?.searchable).not.toBe(false);
    expect(action?.desc).toBe('Connected');
  });

  it('render callbacks hand the Obsidian Setting and the spec to the injected renderer', () => {
    const { defs, r } = rows();
    for (const d of defs) d.render(FAKE_SETTING, FAKE_GROUP);
    expect(r.calls.map(([n]) => n)).toEqual([
      'header', 'banner', 'static', 'static', 'link', 'static', 'actionRow', 'banner',
    ]);
    expect(r.calls[0]?.[1]).toBe(INFO);
    expect(r.calls[1]?.[1]).toMatchObject({ code: 'quota' });
  });

  it('render callbacks return the renderer cleanup hook', () => {
    const cleanup = vi.fn();
    const r = { ...fakeRenderers(), link: () => cleanup };
    const b = new DefinitionBuilderHost(r);
    b.field({ kind: 'link', label: 'Docs', href: 'https://d' });
    const [def] = itemsOf(groups(b)[0]!) as SettingDefinitionRender[];
    expect(def?.render(FAKE_SETTING, FAKE_GROUP)).toBe(cleanup);
  });

  it('copies visible onto render rows', () => {
    const visible = (): boolean => false;
    const b = new DefinitionBuilderHost(fakeRenderers());
    b.topBanner({ ...banner('x'), visible });
    expect(itemsOf(groups(b)[0]!)[0]?.visible).toBe(visible);
  });

  it('readonly and button kinds throw as unsupported (#112)', () => {
    const b = new DefinitionBuilderHost(fakeRenderers());
    expect(() => b.field({ kind: 'readonly', label: 'R', value: 'v' })).toThrow(/unsupported.*#112/);
    expect(() => b.field({ kind: 'button', label: 'B', onClick: () => {} })).toThrow(/unsupported.*#112/);
  });
});

describe('DefinitionBuilderHost — key registry', () => {
  it('result().registry maps each key to its spec', () => {
    const b = new DefinitionBuilderHost(fakeRenderers());
    const toggle = { kind: 'toggle' as const, key: 'a.t', label: 'T', value: true, onChange: () => {} };
    const num = { kind: 'number' as const, key: 'b.n', label: 'N', value: 1, onChange: () => {} };
    b.heading('A');
    b.field(toggle);
    b.field({ kind: 'static', text: 'not registered' });
    b.heading('B');
    b.field(num);

    const { registry } = b.result();
    expect([...registry.keys()]).toEqual(['a.t', 'b.n']);
    expect(registry.get('a.t')).toBe(toggle);
    expect(registry.get('b.n')).toBe(num);
  });

  it('throws when two input specs in the same group share a key', () => {
    const b = new DefinitionBuilderHost(fakeRenderers());
    b.heading('A');
    b.field({ kind: 'toggle', key: 'dup', label: 'One', value: true, onChange: () => {} });
    expect(() =>
      b.field({ kind: 'text', key: 'dup', label: 'Two', value: '', onChange: () => {} }),
    ).toThrow(/duplicate.*dup/i);
  });
});

describe('guardWrite', () => {
  const num = (extra: Record<string, unknown> = {}) => ({
    kind: 'number' as const, key: 'n', label: 'N', value: 0, onChange: () => {}, ...extra,
  });

  it('number: rejects NaN', () => {
    expect(guardWrite(num(), 'abc')).toEqual({ accept: false });
    expect(guardWrite(num(), Number.NaN)).toEqual({ accept: false });
  });

  it('number: rejects below min and above max, accepts the bounds', () => {
    const spec = num({ min: 1, max: 60 });
    expect(guardWrite(spec, 0)).toEqual({ accept: false });
    expect(guardWrite(spec, 61)).toEqual({ accept: false });
    expect(guardWrite(spec, 1)).toEqual({ accept: true, value: 1 });
    expect(guardWrite(spec, 60)).toEqual({ accept: true, value: 60 });
  });

  it('number: rejects a validate failure', () => {
    const spec = num({ validate: (n: number) => (n % 2 ? 'odd' : null) });
    expect(guardWrite(spec, 3)).toEqual({ accept: false });
    expect(guardWrite(spec, 4)).toEqual({ accept: true, value: 4 });
  });

  it('number: coerces numeric strings', () => {
    expect(guardWrite(num(), '42')).toEqual({ accept: true, value: 42 });
  });

  it('textarea: rejects values that fail validate, coerces to string otherwise', () => {
    const spec = {
      kind: 'textarea' as const, key: 'a', label: 'A', value: '', onChange: () => {},
      validate: (v: string) => (v.includes('[') ? 'bad glob' : null),
    };
    expect(guardWrite(spec, 'a[')).toEqual({ accept: false });
    expect(guardWrite(spec, 'ok/**')).toEqual({ accept: true, value: 'ok/**' });
  });

  it('text: rejects values that fail validate (parity with today), passes valid ones', () => {
    const spec = {
      kind: 'text' as const, key: 't', label: 'T', value: '', onChange: () => {},
      validate: (v: string) => (v === 'bad' ? 'no' : null),
    };
    expect(guardWrite(spec, 'bad')).toEqual({ accept: false });
    expect(guardWrite(spec, 'good')).toEqual({ accept: true, value: 'good' });
  });

  it('text without validate, toggle, dropdown and slider pass through', () => {
    const base = { key: 'k', label: 'L', onChange: () => {} };
    expect(guardWrite({ ...base, kind: 'text', value: '' }, 'x')).toEqual({ accept: true, value: 'x' });
    expect(guardWrite({ ...base, kind: 'toggle', value: false }, true)).toEqual({ accept: true, value: true });
    expect(guardWrite({ ...base, kind: 'dropdown', value: 'a', options: [] }, 'b')).toEqual({ accept: true, value: 'b' });
    expect(guardWrite({ ...base, kind: 'slider', value: 1, min: 0, max: 9, step: 1 }, 5)).toEqual({ accept: true, value: 5 });
  });
});
