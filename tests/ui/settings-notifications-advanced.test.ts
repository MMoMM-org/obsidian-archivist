// T7.9 — Notifications + Advanced sections.

import { describe, expect, it } from 'vitest';
import { renderNotifications } from '../../src/ui/settings/sections/Notifications';
import { renderAdvanced } from '../../src/ui/settings/sections/Advanced';
import { RecordingSectionHost } from '../fixtures/recording-section-host';
import type { SettingsContext } from '../../src/ui/settings/context';
import { DEFAULT_SETTINGS, type PluginSettings } from '../../src/model/Settings';
import { S } from '../../src/ui/strings';

interface StubOpts {
  settings?: PluginSettings;
  confirmResult?: boolean;
}

function makeCtx(opts: StubOpts = {}): {
  ctx: SettingsContext;
  updates: Array<Partial<PluginSettings>>;
  confirmCalls: number;
} {
  const settings = opts.settings ?? DEFAULT_SETTINGS;
  const updates: Array<Partial<PluginSettings>> = [];
  let confirmCalls = 0;

  const ctx: SettingsContext = {
    getSettings: () => settings,
    updateSettings: async (patch) => {
      updates.push(patch);
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
    oauth: {
      isConnected: async () => false,
      beginAuth: async () => {},
    },
    getRetentionProfile: () => ({ vault_bytes: 0, avg_edits_per_day: 0 }),
    estimateRetention: () => ({ snapshots: 0, gb: 0 }),
    copyToClipboard: async () => {},
    confirm: async () => {
      confirmCalls += 1;
      return opts.confirmResult ?? true;
    },
  };

  return {
    ctx,
    updates,
    get confirmCalls() {
      return confirmCalls;
    },
  } as { ctx: SettingsContext; updates: Array<Partial<PluginSettings>>; confirmCalls: number };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

describe('renderNotifications', () => {
  it('registers heading + 4 toggles in the documented order', () => {
    const host = new RecordingSectionHost();
    renderNotifications(host, makeCtx().ctx);

    expect(host.headings()).toEqual([S.SETTINGS_SECTION_NOTIFICATIONS]);
    const labels = host.fields().map((f) => 'label' in f ? f.label : '');
    expect(labels).toEqual([
      S.SETTINGS_PREFLIGHT_NOTICE,
      S.SETTINGS_TOAST_AFTER_INC,
      S.SETTINGS_TOAST_AFTER_FULL,
      S.SETTINGS_TOAST_ON_ERROR,
    ]);
  });

  it('reflects default toggle values from DEFAULT_SETTINGS', () => {
    const host = new RecordingSectionHost();
    renderNotifications(host, makeCtx().ctx);
    expect(host.findField('toggle', S.SETTINGS_PREFLIGHT_NOTICE)?.value).toBe(true);
    expect(host.findField('toggle', S.SETTINGS_TOAST_AFTER_INC)?.value).toBe(false);
    expect(host.findField('toggle', S.SETTINGS_TOAST_AFTER_FULL)?.value).toBe(true);
    expect(host.findField('toggle', S.SETTINGS_TOAST_ON_ERROR)?.value).toBe(true);
  });

  it('persists notifications.toast_after_inc on toggle change', () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx();
    renderNotifications(host, harness.ctx);
    host.findField('toggle', S.SETTINGS_TOAST_AFTER_INC)!.onChange(true);
    expect(harness.updates[0].notifications?.toast_after_inc).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Advanced — field presence
// ---------------------------------------------------------------------------

describe('renderAdvanced — fields present', () => {
  it('registers heading + all documented fields', () => {
    const host = new RecordingSectionHost();
    renderAdvanced(host, makeCtx().ctx);

    expect(host.headings()).toEqual([S.SETTINGS_SECTION_ADVANCED]);
    const labels = host.fields().map((f) => 'label' in f ? f.label : '');
    expect(labels).toEqual([
      S.SETTINGS_EXCLUSION_GLOBS,
      S.SETTINGS_RECONCILE_SCAN,
      S.SETTINGS_DRY_RUN,
      S.SETTINGS_DIAGNOSTIC_LOGGING,
      S.SETTINGS_VAULT_PREFIX,
      S.SETTINGS_UPLOAD_PARALLELISM,
      S.SETTINGS_CHUNK_SIZE,
    ]);
  });

  it('upload-parallelism slider bounds 1–8, chunk-size slider bounds 4–64', () => {
    const host = new RecordingSectionHost();
    renderAdvanced(host, makeCtx().ctx);
    const par = host.findField('slider', S.SETTINGS_UPLOAD_PARALLELISM);
    expect(par).toMatchObject({ min: 1, max: 8, step: 1 });
    const chunk = host.findField('slider', S.SETTINGS_CHUNK_SIZE);
    expect(chunk).toMatchObject({ min: 4, max: 64, step: 1 });
  });
});

// ---------------------------------------------------------------------------
// Advanced — exclusion-glob validation
// ---------------------------------------------------------------------------

describe('renderAdvanced — exclusion globs', () => {
  it('onChange splits by line, trims, drops empties, persists array', () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx();
    renderAdvanced(host, harness.ctx);
    const field = host.findField('textarea', S.SETTINGS_EXCLUSION_GLOBS);
    field!.onChange('.trash/**\n\n  *.tmp  \n');
    expect(harness.updates[0].advanced?.exclusion_globs).toEqual(['.trash/**', '*.tmp']);
  });

  it('validate accepts valid lines', () => {
    const host = new RecordingSectionHost();
    renderAdvanced(host, makeCtx().ctx);
    const field = host.findField('textarea', S.SETTINGS_EXCLUSION_GLOBS);
    expect(field?.validate?.('.trash/**\n*.tmp')).toBeNull();
  });

  it('validate rejects patterns starting with a leading slash', () => {
    const host = new RecordingSectionHost();
    renderAdvanced(host, makeCtx().ctx);
    const field = host.findField('textarea', S.SETTINGS_EXCLUSION_GLOBS);
    const result = field?.validate?.('/abs/path/**');
    expect(result).not.toBeNull();
    expect(result).toContain('relative');
  });
});

// ---------------------------------------------------------------------------
// Advanced — vault-prefix confirm flow
// ---------------------------------------------------------------------------

describe('renderAdvanced — vault prefix', () => {
  it('validate accepts patterns matching /^[a-z0-9][a-z0-9_-]{1,63}$/', () => {
    const host = new RecordingSectionHost();
    renderAdvanced(host, makeCtx().ctx);
    const field = host.findField('text', S.SETTINGS_VAULT_PREFIX);
    expect(field?.validate?.('my-vault')).toBeNull();
    expect(field?.validate?.('1_vault_2026')).toBeNull();
  });

  it('validate rejects uppercase / leading-hyphen / single-char', () => {
    const host = new RecordingSectionHost();
    renderAdvanced(host, makeCtx().ctx);
    const field = host.findField('text', S.SETTINGS_VAULT_PREFIX);
    expect(field?.validate?.('MyVault')).not.toBeNull();
    expect(field?.validate?.('-vault')).not.toBeNull();
    expect(field?.validate?.('a')).not.toBeNull();
  });

  it('onChange to a NEW valid prefix invokes ctx.confirm before persisting', async () => {
    const host = new RecordingSectionHost();
    const settings = {
      ...DEFAULT_SETTINGS,
      advanced: { ...DEFAULT_SETTINGS.advanced, vault_prefix: 'old-prefix' },
    };
    const harness = makeCtx({ settings, confirmResult: true });
    renderAdvanced(host, harness.ctx);

    host.findField('text', S.SETTINGS_VAULT_PREFIX)!.onChange('new-prefix');
    // The onChange triggers an async confirm → updateSettings chain. Yield.
    await new Promise((r) => setTimeout(r, 0));

    expect(harness.confirmCalls).toBe(1);
    expect(harness.updates[0].advanced?.vault_prefix).toBe('new-prefix');
  });

  it('confirm=false cancels the change; updateSettings is NOT called', async () => {
    const host = new RecordingSectionHost();
    const settings = {
      ...DEFAULT_SETTINGS,
      advanced: { ...DEFAULT_SETTINGS.advanced, vault_prefix: 'old' },
    };
    const harness = makeCtx({ settings, confirmResult: false });
    renderAdvanced(host, harness.ctx);

    host.findField('text', S.SETTINGS_VAULT_PREFIX)!.onChange('new-one');
    await new Promise((r) => setTimeout(r, 0));

    expect(harness.confirmCalls).toBe(1);
    expect(harness.updates).toHaveLength(0);
  });

  it('onChange to the SAME value is a no-op (no confirm, no update)', async () => {
    const host = new RecordingSectionHost();
    const settings = {
      ...DEFAULT_SETTINGS,
      advanced: { ...DEFAULT_SETTINGS.advanced, vault_prefix: 'same' },
    };
    const harness = makeCtx({ settings });
    renderAdvanced(host, harness.ctx);
    host.findField('text', S.SETTINGS_VAULT_PREFIX)!.onChange('same');
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.confirmCalls).toBe(0);
    expect(harness.updates).toHaveLength(0);
  });

  it('onChange to an INVALID value is a no-op (no confirm, no update)', async () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx();
    renderAdvanced(host, harness.ctx);
    host.findField('text', S.SETTINGS_VAULT_PREFIX)!.onChange('UPPERCASE-bad');
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.confirmCalls).toBe(0);
    expect(harness.updates).toHaveLength(0);
  });
});
