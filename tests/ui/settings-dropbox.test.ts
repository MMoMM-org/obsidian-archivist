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
  it('shows empty-state title + body + a single Connect action on the Account row', () => {
    const host = new RecordingSectionHost();
    renderDropbox(host, makeCtx({ email: null }).ctx);

    const staticTexts = host
      .fields()
      .filter((f) => f.kind === 'static')
      .map((f) => (f as { text: string }).text);
    expect(staticTexts).toContain(S.OAUTH_EMPTY_STATE_TITLE);
    expect(staticTexts).toContain(S.OAUTH_EMPTY_STATE_BODY);

    const account = host.findField('actionRow', 'Account');
    expect(account).toBeDefined();
    expect(account?.description).toBe(S.OAUTH_NOT_CONNECTED);
    expect(account?.actions).toHaveLength(1);
    expect(account?.actions[0].label).toBe(S.OAUTH_CONNECT_BUTTON);
  });

  it('Connect action invokes ctx.oauth.beginAuth', () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx({ email: null });
    renderDropbox(host, harness.ctx);
    const account = host.findField('actionRow', 'Account');
    account?.actions[0].onClick();
    expect(harness.beginAuthCalls).toBe(1);
  });

  it('Connect action is rendered without CTA / warning styling', () => {
    // Themes that override --interactive-accent or --text-on-accent can render
    // mod-cta buttons unreadable (e.g. white text on a white button bg). The
    // standard button uses --text-normal on --interactive-normal — a pair that
    // themes preserve more reliably. Tradeoff: less visual prominence, but the
    // label is always readable.
    const host = new RecordingSectionHost();
    renderDropbox(host, makeCtx({ email: null }).ctx);
    const action = host.findField('actionRow', 'Account')?.actions[0];
    expect(action?.cta).toBeFalsy();
    expect(action?.warning).toBeFalsy();
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
  it('shows "Connected as <email>" as the Account row description', () => {
    const host = new RecordingSectionHost();
    renderDropbox(host, makeCtx({ email: 'marcus@example.com' }).ctx);
    const account = host.findField('actionRow', 'Account');
    expect(account?.description).toBe(S.OAUTH_CONNECTED_AS('marcus@example.com'));
  });

  it('Account row exposes Re-authenticate + Disconnect actions in that order', () => {
    const host = new RecordingSectionHost();
    renderDropbox(host, makeCtx({ email: 'x@y.z' }).ctx);
    const labels = host.findField('actionRow', 'Account')?.actions.map((a) => a.label);
    expect(labels).toEqual([S.OAUTH_REAUTHENTICATE_BUTTON, S.OAUTH_DISCONNECT_BUTTON]);
  });

  it('Disconnect action is flagged as warning (destructive)', () => {
    const host = new RecordingSectionHost();
    renderDropbox(host, makeCtx({ email: 'x@y.z' }).ctx);
    const actions = host.findField('actionRow', 'Account')?.actions ?? [];
    const reauth = actions.find((a) => a.label === S.OAUTH_REAUTHENTICATE_BUTTON);
    const disconnect = actions.find((a) => a.label === S.OAUTH_DISCONNECT_BUTTON);
    expect(reauth?.warning).toBeFalsy();
    expect(disconnect?.warning).toBe(true);
  });

  it('Re-authenticate invokes beginAuth', () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx({ email: 'x@y.z' });
    renderDropbox(host, harness.ctx);
    const reauth = host
      .findField('actionRow', 'Account')
      ?.actions.find((a) => a.label === S.OAUTH_REAUTHENTICATE_BUTTON);
    reauth?.onClick();
    expect(harness.beginAuthCalls).toBe(1);
  });

  it('Disconnect opens confirm dialog; OK → calls dropbox.disconnect', async () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx({ email: 'x@y.z', confirmResult: true });
    renderDropbox(host, harness.ctx);
    const disconnect = host
      .findField('actionRow', 'Account')
      ?.actions.find((a) => a.label === S.OAUTH_DISCONNECT_BUTTON);
    disconnect?.onClick();
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.confirmCalls).toBe(1);
    expect(harness.disconnectCalls).toBe(1);
  });

  it('Disconnect confirm=false cancels — disconnect NOT called', async () => {
    const host = new RecordingSectionHost();
    const harness = makeCtx({ email: 'x@y.z', confirmResult: false });
    renderDropbox(host, harness.ctx);
    const disconnect = host
      .findField('actionRow', 'Account')
      ?.actions.find((a) => a.label === S.OAUTH_DISCONNECT_BUTTON);
    disconnect?.onClick();
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
