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
  settingsRef: { settings: PluginSettings };
} {
  const settingsRef: { settings: PluginSettings } = {
    settings: opts.settings ?? DEFAULT_SETTINGS,
  };
  const updates: Array<Partial<PluginSettings>> = [];
  let confirmCalls = 0;

  const ctx: SettingsContext = {
    getSettings: () => settingsRef.settings,
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
    settingsRef,
    get confirmCalls() {
      return confirmCalls;
    },
  } as {
    ctx: SettingsContext;
    updates: Array<Partial<PluginSettings>>;
    confirmCalls: number;
    settingsRef: { settings: PluginSettings };
  };
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

  it('onChange to a NEW valid prefix persists immediately (no confirm)', async () => {
    // The previous implementation wrapped the save in an async confirm chain;
    // ctx.confirm in production is a stub (async () => true) so the modal
    // never actually appeared, the latency just added a stale-closure race
    // that caused the field to revert to '' after typing. Save now runs
    // synchronously (no confirm step in this section).
    const host = new RecordingSectionHost();
    const settings = {
      ...DEFAULT_SETTINGS,
      advanced: { ...DEFAULT_SETTINGS.advanced, vault_prefix: 'old-prefix' },
    };
    const harness = makeCtx({ settings });
    renderAdvanced(host, harness.ctx);

    host.findField('text', S.SETTINGS_VAULT_PREFIX)!.onChange('new-prefix');
    await new Promise((r) => setTimeout(r, 0));

    expect(harness.confirmCalls).toBe(0);
    expect(harness.updates[0].advanced?.vault_prefix).toBe('new-prefix');
  });

  it('onChange uses the CURRENT advanced state (fresh ctx.getSettings), not the render-time closure', async () => {
    // Regression: previously the patch carried render-time values for every
    // OTHER advanced field, so a concurrent save from a different section
    // could be silently overwritten. The new implementation reads
    // ctx.getSettings() at change-time so concurrent edits compose correctly.
    const host = new RecordingSectionHost();
    const initial = {
      ...DEFAULT_SETTINGS,
      advanced: {
        ...DEFAULT_SETTINGS.advanced,
        vault_prefix: '',
        diagnostic_logging: false,
      },
    };
    const harness = makeCtx({ settings: initial });
    renderAdvanced(host, harness.ctx);

    // Simulate another section flipping diagnostic_logging on AFTER renderAdvanced
    // captured its closure but BEFORE the user types into the prefix field.
    harness.settingsRef.settings = {
      ...initial,
      advanced: { ...initial.advanced, diagnostic_logging: true },
    };

    host.findField('text', S.SETTINGS_VAULT_PREFIX)!.onChange('new-prefix');
    await new Promise((r) => setTimeout(r, 0));

    // The save merged the FRESH advanced state (with diagnostic_logging=true)
    // and overlaid only vault_prefix.
    expect(harness.updates[0].advanced).toEqual(
      expect.objectContaining({
        vault_prefix: 'new-prefix',
        diagnostic_logging: true,
      }),
    );
  });

  it('onChange to the SAME value is a no-op (no update)', async () => {
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
