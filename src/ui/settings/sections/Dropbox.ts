// Dropbox section (T7.10 — PRD F7 / SDD ADR-7, ADR-9).
//
// Two visual states driven by ctx.dropboxAccountEmail:
//
//   DISCONNECTED (email === null):
//     - Empty-state title + body explaining app-scoped folder scope
//     - [Connect Dropbox] button → ctx.oauth.beginAuth()
//     - Plaintext-token disclosure
//
//   CONNECTED (email is a string):
//     - "Connected as <email>" readonly row
//     - [Re-authenticate] button → ctx.oauth.beginAuth() (new flow)
//     - [Disconnect] button → ctx.confirm(...) → ctx.dropbox.disconnect()
//     - Plaintext-token disclosure
//
// The Disconnect confirm modal wording is S.OAUTH_DISCONNECT_CONFIRM_BODY —
// it makes explicit that local credentials are removed but existing backup
// data in Dropbox is NOT deleted in V1.

import type { SectionHost } from '../SectionHost';
import type { SettingsContext } from '../context';
import { S } from '../../strings';

export function renderDropbox(host: SectionHost, ctx: SettingsContext): void {
  host.heading(S.SETTINGS_SECTION_DROPBOX);

  const email = ctx.dropboxAccountEmail;
  if (email === null) {
    renderDisconnected(host, ctx);
  } else {
    renderConnected(host, ctx, email);
  }

  // Token-storage disclosure rendered in BOTH states (users need to see it
  // before connecting AND confirm it while connected).
  host.field({ kind: 'static', text: S.OAUTH_TOKEN_DISCLOSURE });
}

function renderDisconnected(host: SectionHost, ctx: SettingsContext): void {
  host.field({ kind: 'static', text: S.OAUTH_EMPTY_STATE_TITLE });
  host.field({ kind: 'static', text: S.OAUTH_EMPTY_STATE_BODY });
  // No `cta: true` here: themes that override --interactive-accent or
  // --text-on-accent (e.g. white-button themes) can render mod-cta buttons
  // unreadable. The standard button uses --text-normal on --interactive-normal,
  // a pair that themes preserve more reliably.
  host.field({
    kind: 'button',
    label: S.OAUTH_CONNECT_BUTTON,
    onClick: () => {
      void ctx.oauth.beginAuth();
    },
  });
}

function renderConnected(host: SectionHost, ctx: SettingsContext, email: string): void {
  host.field({
    kind: 'readonly',
    label: 'Account',
    value: S.OAUTH_CONNECTED_AS(email),
  });

  host.field({
    kind: 'button',
    label: S.OAUTH_REAUTHENTICATE_BUTTON,
    onClick: () => {
      void ctx.oauth.beginAuth();
    },
  });

  host.field({
    kind: 'button',
    label: S.OAUTH_DISCONNECT_BUTTON,
    onClick: () => {
      void (async (): Promise<void> => {
        const ok = await ctx.confirm({
          title: S.OAUTH_DISCONNECT_CONFIRM_TITLE,
          body: S.OAUTH_DISCONNECT_CONFIRM_BODY,
          okLabel: S.OAUTH_DISCONNECT_CONFIRM_OK,
          cancelLabel: S.OAUTH_DISCONNECT_CONFIRM_CANCEL,
        });
        if (!ok) return;
        await ctx.dropbox.disconnect();
      })();
    },
  });
}
