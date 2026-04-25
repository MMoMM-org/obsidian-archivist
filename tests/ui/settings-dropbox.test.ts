// T7.10 — Dropbox section: OAuth UI + Disconnect flow.

import { describe, expect, it } from 'vitest';
import { renderDropbox } from '../../src/ui/settings/sections/Dropbox';
import { RecordingSectionHost } from '../fixtures/recording-section-host';
import type { SettingsContext } from '../../src/ui/settings/context';
import { DEFAULT_SETTINGS } from '../../src/model/Settings';
import { S } from '../../src/ui/strings';

interface StubOpts {
  email?: string | null;
  confirmResult?: boolean;
}

function makeCtx(opts: StubOpts = {}): {
  ctx: SettingsContext;
  beginAuthCalls: number;
  disconnectCalls: number;
  confirmCalls: number;
} {
  let beginAuthCalls = 0;
  let disconnectCalls = 0;
  let confirmCalls = 0;

  const ctx: SettingsContext = {
    getSettings: () => DEFAULT_SETTINGS,
    updateSettings: async () => {},
    deviceId: 'd0',
    deviceDesignated: true,
    dropboxAccountEmail: opts.email ?? null,
    dropboxUsedBytes: 0,
    device: {
      getDeviceId: async () => 'd0',
      isDesignated: async () => true,
      takeOwnership: async () => {},
      releaseOwnership: async () => {},
    },
    dropbox: {
      getAccountEmail: async () => opts.email ?? null,
      disconnect: async () => {
        disconnectCalls += 1;
      },
      getUsedBytes: async () => 0,
    },
    oauth: {
      isConnected: async () => opts.email !== null,
      beginAuth: async () => {
        beginAuthCalls += 1;
      },
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
    get beginAuthCalls() {
      return beginAuthCalls;
    },
    get disconnectCalls() {
      return disconnectCalls;
    },
    get confirmCalls() {
      return confirmCalls;
    },
  } as {
    ctx: SettingsContext;
    beginAuthCalls: number;
    disconnectCalls: number;
    confirmCalls: number;
  };
}

// ---------------------------------------------------------------------------
// Disconnected state
// ---------------------------------------------------------------------------

describe('renderDropbox — disconnected', () => {
  it('shows empty-state title + body + Connect button', () => {
    const host = new RecordingSectionHost();
    renderDropbox(host, makeCtx({ email: null }).ctx);

    const staticTexts = host
      .fields()
      .filter((f) => f.kind === 'static')
      .map((f) => (f as { text: string }).text);
    expect(staticTexts).toContain(S.OAUTH_EMPTY_STATE_TITLE);
    expect(staticTexts).toContain(S.OAUTH_EMPTY_STATE_BODY);

    const buttons = host.fields().filter((f) => f.kind === 'button');
    expect(buttons).toHaveLength(1);
    expect((buttons[0] as { label: string }).label).toBe(S.OAUTH_CONNECT_BUTTON);
  });

  it('Connect button invokes ctx.oauth.beginAuth', () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx({ email: null });
    renderDropbox(host, harness.ctx);
    const btn = host.fields().find((f) => f.kind === 'button' && f.label === S.OAUTH_CONNECT_BUTTON);
    expect(btn).toBeDefined();
    (btn as { onClick: () => void }).onClick();
    expect(harness.beginAuthCalls).toBe(1);
  });

  it('Connect button is rendered as a regular button, not CTA', () => {
    // Themes that override --interactive-accent or --text-on-accent can render
    // mod-cta buttons unreadable (e.g. white text on a white button bg). The
    // standard button uses --text-normal on --interactive-normal — a pair that
    // themes preserve more reliably. Tradeoff: less visual prominence, but the
    // label is always readable.
    const host = new RecordingSectionHost();
    renderDropbox(host, makeCtx({ email: null }).ctx);
    const btn = host.fields().find((f) => f.kind === 'button' && f.label === S.OAUTH_CONNECT_BUTTON);
    expect((btn as { cta?: boolean }).cta).toBeFalsy();
  });

  it('renders plaintext-token disclosure in disconnected state', () => {
    const host = new RecordingSectionHost();
    renderDropbox(host, makeCtx({ email: null }).ctx);
    const staticTexts = host
      .fields()
      .filter((f) => f.kind === 'static')
      .map((f) => (f as { text: string }).text);
    expect(staticTexts).toContain(S.OAUTH_TOKEN_DISCLOSURE);
  });
});

// ---------------------------------------------------------------------------
// Connected state
// ---------------------------------------------------------------------------

describe('renderDropbox — connected', () => {
  it('shows "Connected as <email>" readonly row', () => {
    const host = new RecordingSectionHost();
    renderDropbox(host, makeCtx({ email: 'marcus@example.com' }).ctx);
    const ro = host.findField('readonly', 'Account');
    expect(ro?.value).toBe(S.OAUTH_CONNECTED_AS('marcus@example.com'));
  });

  it('renders Re-authenticate + Disconnect buttons', () => {
    const host = new RecordingSectionHost();
    renderDropbox(host, makeCtx({ email: 'x@y.z' }).ctx);
    const labels = host
      .fields()
      .filter((f) => f.kind === 'button')
      .map((f) => (f as { label: string }).label);
    expect(labels).toEqual([S.OAUTH_REAUTHENTICATE_BUTTON, S.OAUTH_DISCONNECT_BUTTON]);
  });

  it('Re-authenticate invokes beginAuth', () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx({ email: 'x@y.z' });
    renderDropbox(host, harness.ctx);
    const btn = host.fields().find((f) => f.kind === 'button' && f.label === S.OAUTH_REAUTHENTICATE_BUTTON);
    (btn as { onClick: () => void }).onClick();
    expect(harness.beginAuthCalls).toBe(1);
  });

  it('Disconnect opens confirm dialog; OK → calls dropbox.disconnect', async () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx({ email: 'x@y.z', confirmResult: true });
    renderDropbox(host, harness.ctx);
    const btn = host.fields().find((f) => f.kind === 'button' && f.label === S.OAUTH_DISCONNECT_BUTTON);
    (btn as { onClick: () => void }).onClick();
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.confirmCalls).toBe(1);
    expect(harness.disconnectCalls).toBe(1);
  });

  it('Disconnect confirm=false cancels — disconnect NOT called', async () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx({ email: 'x@y.z', confirmResult: false });
    renderDropbox(host, harness.ctx);
    const btn = host.fields().find((f) => f.kind === 'button' && f.label === S.OAUTH_DISCONNECT_BUTTON);
    (btn as { onClick: () => void }).onClick();
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.confirmCalls).toBe(1);
    expect(harness.disconnectCalls).toBe(0);
  });

  it('renders plaintext-token disclosure in connected state too', () => {
    const host = new RecordingSectionHost();
    renderDropbox(host, makeCtx({ email: 'x@y.z' }).ctx);
    const staticTexts = host
      .fields()
      .filter((f) => f.kind === 'static')
      .map((f) => (f as { text: string }).text);
    expect(staticTexts).toContain(S.OAUTH_TOKEN_DISCLOSURE);
  });
});
