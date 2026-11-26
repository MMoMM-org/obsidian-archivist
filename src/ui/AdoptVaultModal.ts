// AdoptVaultModal — confirmation dialog for the vault-id adoption flow.
//
// Shown when the plugin loads and finds:
//   - local data.json has no vault_id, AND
//   - the configured Dropbox folder already has a vault_meta.json.
//
// Two outcomes:
//   - Adopt → call onAdopt(remote.vault_id), which writes the remote ID
//     into data.json and unblocks backup writes.
//   - Cancel → no-op; the modal closes. The same modal will reappear on
//     the next plugin load until the user either adopts or changes the
//     vault_prefix to a fresh folder.
//
// The pure render function follows the same ModalHandle pattern as
// ConfirmRestoreModal so tests can exercise it without Obsidian.

import { Modal, type App } from 'obsidian';
import { makeContentElHandle, type ModalHandle } from './ConfirmRestoreModal';
import { S } from './strings';
import { captureFocus } from './focus';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AdoptVaultModalOpts {
  /** Vault name recorded in the remote vault_meta — purely diagnostic. */
  remoteVaultName: string;
  /** UUID recorded in the remote vault_meta. */
  remoteVaultId: string;
  /** Called when the user clicks Adopt. */
  onAdopt: () => void;
  /** Called when the user dismisses the modal (Cancel button or Escape). */
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Pure rendering — exercised directly by tests
// ---------------------------------------------------------------------------

/**
 * Render all content + wire keyboard and button callbacks into handle.
 *
 * Cancel is the default button (Enter is inert for adoption — adoption
 * is a one-way claim and shouldn't fire on stray keystrokes). Escape
 * fires onCancel and closes.
 */
export function renderAdoptVaultContent(
  handle: ModalHandle,
  opts: AdoptVaultModalOpts,
): void {
  const { remoteVaultName, remoteVaultId, onAdopt, onCancel } = opts;

  handle.setTitle(S.ADOPT_VAULT_TITLE);
  // M16: lead + two outcome paragraphs so the Adopt/Cancel decision
  // boundaries are visible at a glance instead of buried in one block.
  handle.setBody(S.ADOPT_VAULT_BODY(remoteVaultName, remoteVaultId));
  handle.addLine(S.ADOPT_VAULT_BODY_ADOPT);
  handle.addLine(S.ADOPT_VAULT_BODY_CANCEL);
  handle.addLine(S.ADOPT_VAULT_HINT);

  const dismiss = (action: () => void): void => {
    action();
    handle.close();
  };

  // Cancel is default (Enter does NOT fire Adopt) — adoption is a
  // one-way claim, treat it as a destructive action for input safety.
  handle.addButton(S.ADOPT_VAULT_CANCEL, true, () => dismiss(onCancel));
  handle.addButton(S.ADOPT_VAULT_ADOPT, false, () => dismiss(onAdopt));

  handle.onKeydown((key: string) => {
    if (key === 'Escape') dismiss(onCancel);
    // Enter intentionally unhandled — see ConfirmRestoreModal for the
    // same pattern.
  });
}

// ---------------------------------------------------------------------------
// AdoptVaultModal — Obsidian Modal subclass
// ---------------------------------------------------------------------------

export class AdoptVaultModal extends Modal {
  private triggerEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly opts: AdoptVaultModalOpts,
  ) {
    super(app);
  }

  onOpen(): void {
    this.triggerEl = captureFocus(activeDocument);
    const handle = makeContentElHandle(this.contentEl, this.modalEl, () => {
      this.triggerEl?.focus();
      this.close();
    });
    renderAdoptVaultContent(handle, this.opts);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
