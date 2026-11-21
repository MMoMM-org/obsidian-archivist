// Fixture self-test for the Obsidian 1.13+ declarative settings surface in the
// mock (spec 002, T1.2). Later phases assert on definitions, update() calls,
// destructive button styling and debounced refreshes through these stubs, so
// the stubs themselves must behave like Obsidian 1.14.4 does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  App,
  ButtonComponent,
  PluginSettingTab,
  Setting,
  SettingTab,
  _reconcileRenderRow,
  _setMockApiVersion,
  debounce,
  requireApiVersion,
  type MockEl,
} from './obsidian-mock';
import { RecordingSectionHost } from './recording-section-host';
import type { FieldSpec, ToggleFieldSpec } from '../../src/ui/settings/SectionHost';

class DefinitionsTab extends PluginSettingTab {
  definitionCalls = 0;
  definitions: unknown[] = [{ type: 'control', name: 'First' }];

  getSettingDefinitions(): unknown[] {
    this.definitionCalls += 1;
    return this.definitions;
  }
}

function makeTab(settings: Record<string, unknown> = {}): DefinitionsTab {
  const plugin = { settings, saveData: vi.fn(async () => {}) };
  return new DefinitionsTab(new App(), plugin);
}

describe('mock SettingTab (1.13+ surface)', () => {
  it('PluginSettingTab extends SettingTab', () => {
    expect(makeTab()).toBeInstanceOf(SettingTab);
  });

  it('starts with empty settingItems and default getSettingDefinitions', () => {
    const tab = new PluginSettingTab(new App(), { settings: {} });
    expect(tab.settingItems).toEqual([]);
    expect(tab.getSettingDefinitions()).toEqual([]);
  });

  it('update() records each call and stores the result of getSettingDefinitions()', () => {
    const tab = makeTab();

    tab.update();
    tab.definitions = [{ type: 'control', name: 'Second' }];
    tab.update();

    expect(tab._updateCalls).toBe(2);
    expect(tab.definitionCalls).toBe(2);
    expect(tab.settingItems).toEqual([{ type: 'control', name: 'Second' }]);
  });

  it('refreshDomState() records each call without re-running getSettingDefinitions()', () => {
    const tab = makeTab();

    tab.refreshDomState();
    tab.refreshDomState();

    expect(tab._refreshDomStateCalls).toBe(2);
    expect(tab.definitionCalls).toBe(0);
  });

  it('getControlValue reads plugin.settings by dotted key', () => {
    const tab = makeTab({ schedule: { full_backup_time: '03:00' }, enabled: true });

    expect(tab.getControlValue('schedule.full_backup_time')).toBe('03:00');
    expect(tab.getControlValue('enabled')).toBe(true);
    expect(tab.getControlValue('schedule.missing.deeper')).toBeUndefined();
  });

  it('setControlValue writes plugin.settings by dotted key, records the call and persists', async () => {
    const settings: Record<string, unknown> = { schedule: { full_backup_time: '03:00' } };
    const plugin = { settings, saveData: vi.fn(async () => {}) };
    const tab = new DefinitionsTab(new App(), plugin);

    await tab.setControlValue('schedule.full_backup_time', '04:30');
    await tab.setControlValue('retention.daily', 7);

    expect(settings).toEqual({ schedule: { full_backup_time: '04:30' }, retention: { daily: 7 } });
    expect(tab._setControlValueCalls).toEqual([
      ['schedule.full_backup_time', '04:30'],
      ['retention.daily', 7],
    ]);
    expect(plugin.saveData).toHaveBeenCalledTimes(2);
    expect(plugin.saveData).toHaveBeenLastCalledWith(settings);
  });

  it('base SettingTab setControlValue writes its own config by dotted key and records the call', () => {
    const tab = new SettingTab(new App());

    tab.setControlValue('a.b', 1);

    expect(tab.getControlValue('a.b')).toBe(1);
    expect(tab._setControlValueCalls).toEqual([['a.b', 1]]);
  });

  it('keeps the legacy display()/hide() and containerEl stubs', () => {
    const tab = makeTab();
    expect(() => tab.display()).not.toThrow();
    expect(() => tab.hide()).not.toThrow();
    expect(() => tab.containerEl.empty()).not.toThrow();
  });
});

describe('mock ButtonComponent', () => {
  it('setDestructive() records the destructive state and chains', () => {
    const button = new ButtonComponent({});

    const returned = button.setDestructive();

    expect(returned).toBe(button);
    expect(button._destructive).toBe(true);
  });

  it('removeDestructive() clears the destructive state', () => {
    const button = new ButtonComponent({}).setDestructive();

    button.removeDestructive();

    expect(button._destructive).toBe(false);
  });

  it('composes setDestructive().setCta() for a destructive primary action', () => {
    const button = new ButtonComponent({}).setDestructive().setCta();

    expect(button._destructive).toBe(true);
    expect(button._cta).toBe(true);
  });

  it('starts non-destructive', () => {
    expect(new ButtonComponent({})._destructive).toBe(false);
  });
});

describe('mock Setting', () => {
  it('exposes settingEl, infoEl, nameEl, descEl and controlEl elements', () => {
    const setting = new Setting({});

    for (const el of [setting.settingEl, setting.infoEl, setting.nameEl, setting.descEl, setting.controlEl]) {
      expect(typeof (el as MockEl).createEl).toBe('function');
    }
  });

  it('setName and setDesc write the name and description text', () => {
    const setting = new Setting({}).setName('Internal').setDesc('Details');

    expect((setting.nameEl as MockEl).textContent).toBe('Internal');
    expect((setting.descEl as MockEl).textContent).toBe('Details');
  });

  it('setClass adds a class to settingEl and chains', () => {
    const setting = new Setting({});

    expect(setting.setClass('a').setClass('b')).toBe(setting);
    expect((setting.settingEl as MockEl).className).toBe('setting-item a b');
  });

  it('addButton hands a ButtonComponent to the callback and records it in order', () => {
    const setting = new Setting({});

    setting.addButton((b) => (b as ButtonComponent).setButtonText('One'));
    setting.addButton((b) => (b as ButtonComponent).setButtonText('Two').setDestructive());

    expect(setting._buttons.map((b) => b._text)).toEqual(['One', 'Two']);
    expect(setting._buttons[1]).toBeInstanceOf(ButtonComponent);
    expect(setting._buttons[1]._destructive).toBe(true);
  });

  it('createEl records an href option as the href attribute', () => {
    const nameEl = new Setting({}).nameEl as MockEl;

    const a = nameEl.createEl('a', { text: 'Docs', href: 'https://example.org' });

    expect(a.attrs.href).toBe('https://example.org');
  });

  it('appends settingEl to a MockEl container', () => {
    const container = new Setting({}).controlEl as MockEl;
    const before = container.children.length;

    const setting = new Setting(container);

    expect(container.children.length).toBe(before + 1);
    expect(container.children[before]).toBe(setting.settingEl);
  });

  it('clear() empties controlEl and drops recorded buttons but keeps infoEl content', () => {
    const setting = new Setting({}).setName('Row');
    setting.addButton(() => {});
    (setting.infoEl as MockEl).createDiv({ cls: 'extra' });

    setting.clear();

    expect((setting.controlEl as MockEl).children).toHaveLength(0);
    expect(setting._buttons).toHaveLength(0);
    expect((setting.infoEl as MockEl).querySelectorAll('.extra')).toHaveLength(1);
    expect((setting.nameEl as MockEl).textContent).toBe('Row');
  });
});

// Mirrors the 1.14/1.15 runtime: a keyed render row that survives update()
// keeps its Setting; Obsidian runs the previous cleanup, clear()s the Setting,
// resets name/desc and calls render again on the same Setting.
describe('mock _reconcileRenderRow', () => {
  it('runs the previous cleanup, clears, resets name and desc, then re-renders on the same Setting', () => {
    const setting = new Setting({});
    const calls: string[] = [];
    const def = {
      name: 'row',
      desc: 'about',
      render: (s: Setting) => {
        calls.push(`render:${(s.nameEl as MockEl).textContent}`);
        s.addButton(() => {});
        return () => calls.push('cleanup');
      },
    };

    _reconcileRenderRow(setting, def);
    (setting.nameEl as MockEl).setText('changed by render');
    _reconcileRenderRow(setting, def);

    expect(calls).toEqual(['render:row', 'cleanup', 'render:row']);
    expect(setting._buttons).toHaveLength(1);
    expect((setting.descEl as MockEl).textContent).toBe('about');
  });

  it('resets desc to empty when the definition has none', () => {
    const setting = new Setting({}).setDesc('stale');

    _reconcileRenderRow(setting, { name: 'row', render: () => {} });

    expect((setting.descEl as MockEl).textContent).toBe('');
  });
});

describe('mock element tree', () => {
  it('remove() detaches the element from its parent', () => {
    const parent = new Setting({}).infoEl as MockEl;
    const child = parent.createDiv({ cls: 'gone' });

    child.remove();

    expect(parent.querySelectorAll('.gone')).toHaveLength(0);
  });

  it('setText replaces child elements, like HTMLElement.setText', () => {
    const el = new Setting({}).nameEl as MockEl;
    el.createDiv({ cls: 'child' });

    el.setText('plain');

    expect(el.children).toHaveLength(0);
    expect(el.textContent).toBe('plain');
  });

  it('addClass and removeClass accept several classes', () => {
    const el = new Setting({}).settingEl as MockEl;

    el.addClass('a', 'b', 'c');
    el.removeClass('a', 'c');

    expect(el.className).toBe('setting-item b');
  });
});

describe('mock requireApiVersion', () => {
  afterEach(() => _setMockApiVersion('1.14.4'));

  it('defaults to 1.14.4 and accepts equal or older versions only', () => {
    expect(requireApiVersion('1.14.4')).toBe(true);
    expect(requireApiVersion('1.13.0')).toBe(true);
    expect(requireApiVersion('1.15.0')).toBe(false);
  });

  it('compares numerically against the version set by _setMockApiVersion', () => {
    _setMockApiVersion('1.11.4');

    expect(requireApiVersion('1.13.0')).toBe(false);
    expect(requireApiVersion('1.9.10')).toBe(true);
  });
});

describe('mock debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resetTimer=false fires once, ms after the FIRST call, coalescing calls in the window', () => {
    const cb = vi.fn();
    const debounced = debounce(cb, 150, false);

    debounced('a');
    vi.advanceTimersByTime(100);
    debounced('b');
    vi.advanceTimersByTime(49);
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('resetTimer=false starts a new window after the burst has fired', () => {
    const cb = vi.fn();
    const debounced = debounce(cb, 150, false);

    debounced();
    vi.advanceTimersByTime(150);
    debounced();
    vi.advanceTimersByTime(150);

    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('resetTimer=true pushes the timer out on every call and fires ms after the LAST call', () => {
    const cb = vi.fn();
    const debounced = debounce(cb, 150, true);

    debounced();
    vi.advanceTimersByTime(100);
    debounced();
    vi.advanceTimersByTime(149);
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('passes the most recent arguments to the callback', () => {
    const cb = vi.fn();
    const debounced = debounce(cb, 150, false);

    debounced('first');
    debounced('latest');
    vi.advanceTimersByTime(150);

    expect(cb).toHaveBeenCalledWith('latest');
  });

  it('cancel() drops the pending call and chains', () => {
    const cb = vi.fn();
    const debounced = debounce(cb, 150, false);

    debounced();
    const returned = debounced.cancel();
    vi.advanceTimersByTime(1000);

    expect(returned).toBe(debounced);
    expect(cb).not.toHaveBeenCalled();
  });

  it('a call after cancel() schedules a fresh timer and fires with the new arguments', () => {
    const cb = vi.fn();
    const debounced = debounce(cb, 150, false);

    debounced('a');
    debounced.cancel();
    debounced('b');
    vi.advanceTimersByTime(151);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('b');
  });

  it('run() fires a pending call immediately and returns its value, once', () => {
    const cb = vi.fn(() => 42);
    const debounced = debounce(cb, 150, false);

    debounced();
    expect(debounced.run()).toBe(42);
    vi.advanceTimersByTime(1000);

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('run() returns undefined and does nothing when no call is pending', () => {
    const cb = vi.fn(() => 42);
    const debounced = debounce(cb, 150, false);

    expect(debounced.run()).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
  });

  it('calling the debouncer returns the debouncer itself', () => {
    const debounced = debounce(vi.fn(), 150, false);
    expect(debounced()).toBe(debounced);
  });
});

describe('RecordingSectionHost declarative metadata', () => {
  type ToggleMeta = Partial<Pick<ToggleFieldSpec, 'key' | 'visible' | 'aliases'>>;

  function toggle(label: string, extra: ToggleMeta = {}): ToggleFieldSpec {
    return { kind: 'toggle', key: 'ui.test', label, value: false, onChange: () => {}, ...extra };
  }

  it('captures key, visible and aliases for each recorded field', () => {
    const host = new RecordingSectionHost();
    const visible = (): boolean => true;

    host.field(toggle('Enabled', { key: 'schedule.enabled', visible, aliases: ['on', 'off'] }));

    const [entry] = host.fieldEntries();
    expect(entry.key).toBe('schedule.enabled');
    expect(entry.visible).toBe(visible);
    expect(entry.aliases).toEqual(['on', 'off']);
  });

  it('leaves key, visible and aliases undefined when the spec has none', () => {
    const host = new RecordingSectionHost();

    // Models a non-input or legacy spec that carries no key.
    const keyless = { kind: 'toggle', label: 'Plain', value: false, onChange: () => {} };

    host.field(keyless as unknown as FieldSpec);

    const [entry] = host.fieldEntries();
    expect(entry.key).toBeUndefined();
    expect(entry.visible).toBeUndefined();
    expect(entry.aliases).toBeUndefined();
  });

  it('findField skips a spec whose visible() returns false', () => {
    const host = new RecordingSectionHost();

    host.field(toggle('Window start', { visible: () => false }));

    expect(host.findField('toggle', 'Window start')).toBeUndefined();
  });

  it('findField returns a hidden spec when includeHidden is true', () => {
    const host = new RecordingSectionHost();
    const spec = toggle('Window start', { visible: () => false });

    host.field(spec);

    expect(host.findField('toggle', 'Window start', { includeHidden: true })).toBe(spec);
  });

  it('findField returns specs whose visible() returns true or that have no visible predicate', () => {
    const host = new RecordingSectionHost();
    const shown = toggle('Shown', { visible: () => true });
    const plain = toggle('Plain');

    host.field(shown);
    host.field(plain);

    expect(host.findField('toggle', 'Shown')).toBe(shown);
    expect(host.findField('toggle', 'Plain')).toBe(plain);
  });

  it('evaluates visible() at lookup time, not at record time', () => {
    const host = new RecordingSectionHost();
    let on = false;
    const spec = toggle('Window start', { visible: () => on });

    host.field(spec);
    expect(host.findField('toggle', 'Window start')).toBeUndefined();

    on = true;
    expect(host.findField('toggle', 'Window start')).toBe(spec);
  });
});
