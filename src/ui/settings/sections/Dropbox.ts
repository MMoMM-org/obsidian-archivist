// Dropbox section (T7.10 — PRD F7 / SDD ADR-7, ADR-9).
//
// Both states render a single one-line "Account" actionRow so the state
// readout (Not connected / Connected as …) and the actions (Connect /
// Re-authenticate / Disconnect) live together visually:
//
//   DISCONNECTED (email === null):
//     - Empty-state title + body paragraphs (onboarding context)
//     - Account · Not connected.            [ Connect Dropbox ]
//     - Plaintext-token disclosure + docs link
//
//   CONNECTED (email is a string):
//     - Account · Connected as <email>      [ Re-authenticate ] [ Disconnect ]
//     - Plaintext-token disclosure + docs link
//
// Disconnect uses Obsidian's `mod-warning` button styling to flag the
// destructive action without hard-coded colours; the confirm modal wording in
// S.OAUTH_DISCONNECT_CONFIRM_BODY makes explicit that local credentials are
// removed but existing backup data in Dropbox is NOT deleted in V1.

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
  host.field({
    kind: 'link',
    label: S.OAUTH_TOKEN_DISCLOSURE_LINK_LABEL,
    href: S.OAUTH_DOCS_URL,
  });
}

function renderDisconnected(host: SectionHost, ctx: SettingsContext): void {
  host.field({ kind: 'static', text: S.OAUTH_EMPTY_STATE_TITLE });
  host.field({ kind: 'static', text: S.OAUTH_EMPTY_STATE_BODY });
  // No `cta: true` on the Connect action: themes that override
  // --interactive-accent or --text-on-accent (e.g. white-button themes) can
  // render mod-cta buttons unreadable. The standard button uses --text-normal
  // on --interactive-normal — a pair themes preserve more reliably.
  host.field({
    kind: 'actionRow',
    label: 'Account',
    description: S.OAUTH_NOT_CONNECTED,
    actions: [
      {
        label: S.OAUTH_CONNECT_BUTTON,
        onClick: () => {
          void ctx.oauth.beginAuth();
        },
      },
    ],
  });
}

function renderConnected(host: SectionHost, ctx: SettingsContext, email: string): void {
  host.field({
    kind: 'actionRow',
    label: 'Account',
    description: S.OAUTH_CONNECTED_AS(email),
    actions: [
      {
        label: S.OAUTH_REAUTHENTICATE_BUTTON,
        onClick: () => {
          void ctx.oauth.beginAuth();
        },
      },
      {
        label: S.OAUTH_DISCONNECT_BUTTON,
        warning: true,
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
      },
    ],
  });
}
