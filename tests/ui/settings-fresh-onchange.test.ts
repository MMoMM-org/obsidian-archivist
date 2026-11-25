// #110 — consecutive edits within one render must all persist.
//
// updateSettings replaces whole settings groups (shallow top-level merge).
// Handlers that spread the group snapshot captured at render time therefore
// revert every earlier edit of the same group made before the next re-render
// (e.g. toggle A, then toggle B → A flips back). This sweep renders each
// section ONCE, edits every settings-backed field in sequence, then re-renders
// and checks that each field shows the value written to it.

import { describe, expect, it } from 'vitest';
import { renderBackupSchedule } from '../../src/ui/settings/sections/BackupSchedule';
import { renderRetention } from '../../src/ui/settings/sections/Retention';
import { renderNotifications } from '../../src/ui/settings/sections/Notifications';
import { renderAdvanced } from '../../src/ui/settings/sections/Advanced';
import type { SectionHost, FieldSpec } from '../../src/ui/settings/SectionHost';
import type { SettingsContext } from '../../src/ui/settings/context';
import { RecordingSectionHost } from '../fixtures/recording-section-host';
import { DEFAULT_SETTINGS, type PluginSettings } from '../../src/model/Settings';

type Render = (host: SectionHost, ctx: SettingsContext) => void;

function makeLiveCtx(): SettingsContext {
  let settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
  return {
    getSettings: () => settings,
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
    },
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
    dropbox: {
      getAccountEmail: async () => null,
      disconnect: async () => {},
      getUsedBytes: async () => 0,
    },
    oauth: { isConnected: async () => false, beginAuth: async () => {} },
    getRetentionProfile: () => ({ vault_bytes: 0, avg_edits_per_day: 0 }),
    estimateRetention: () => ({ snapshots: 0, gb: 0 }),
    copyToClipboard: async () => {},
    confirm: async () => true,
  };
}

const TEXT_CANDIDATES = ['06:30', 'fresh-prefix'];

/** A valid value that differs from the field's current one, in its rendered form. */
function changedValue(spec: FieldSpec): unknown {
  switch (spec.kind) {
    case 'toggle':
      return !spec.value;
    case 'number':
    case 'slider': {
      const min = spec.min ?? 0;
      return spec.value === min ? min + 1 : min;
    }
    case 'dropdown':
      return spec.options.find((o) => o.value !== spec.value)!.value;
    case 'text': {
      const v = TEXT_CANDIDATES.find((c) => c !== spec.value && (spec.validate?.(c) ?? null) === null);
      if (v === undefined) throw new Error(`no valid text candidate for ${spec.key}`);
      return v;
    }
    case 'textarea':
      return 'fresh/**';
    default:
      return undefined;
  }
}

function settingsFields(host: RecordingSectionHost): Array<Extract<FieldSpec, { key: string }>> {
  return host
    .fieldEntries()
    .map((e) => e.spec)
    .filter((s): s is Extract<FieldSpec, { key: string }> =>
      'key' in s && typeof s.key === 'string' && !s.key.startsWith('ui.'),
    );
}

describe.each<[string, Render]>([
  ['BackupSchedule', renderBackupSchedule],
  ['Retention', renderRetention],
  ['Notifications', renderNotifications],
  ['Advanced', renderAdvanced],
])('%s — consecutive edits within one render', (_name, render) => {
  it('every edited field keeps its value', async () => {
    const ctx = makeLiveCtx();
    const host = new RecordingSectionHost();
    render(host, ctx);

    const fields = settingsFields(host);
    expect(fields.length).toBeGreaterThan(1);

    const written = new Map<string, unknown>();
    for (const spec of fields) {
      const v = changedValue(spec);
      written.set(spec.key, v);
      await (spec.onChange as (value: unknown) => unknown)(v);
    }

    const after = new RecordingSectionHost();
    render(after, ctx);
    const actual = new Map(settingsFields(after).map((s) => [s.key, s.value as unknown]));
    expect(actual).toEqual(written);
  });
});
