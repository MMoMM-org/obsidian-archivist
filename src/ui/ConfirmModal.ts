// ConfirmModal — the generic yes/no dialog behind SettingsContext.confirm (#109).
//
// Settings sections ask for confirmation before destructive actions (e.g.
// "Disconnect Dropbox") through ctx.confirm(). This file provides the real
// dialog for that seam; before #109 it was a stub that always said yes.
//
// Safety contract (same as ConfirmRestoreModal):
//   - Cancel is the default button; Enter does not confirm.
//   - Escape, Cancel and closing the modal any other way resolve false.
//   - The result is delivered exactly once.
//
// Testability: renderConfirmContent() and createConfirmSession() are pure and
// tested with a recording ModalHandle; the Modal subclass is thin glue.

import { Modal, type App } from 'obsidian';
import { makeContentElHandle, type ModalHandle } from './ConfirmRestoreModal';

export interface ConfirmOpts {
  title: string;
  body: string;
  okLabel: string;
  cancelLabel: string;
}

/** Render the dialog into handle; onResult fires on OK, Cancel or Escape. */
export function renderConfirmContent(
  handle: ModalHandle,
  opts: ConfirmOpts,
  onResult: (ok: boolean) => void,
): void {
  const answer = (ok: boolean): void => {
    onResult(ok);
    handle.close();
  };

  handle.setTitle(opts.title);
  handle.setBody(opts.body);
  handle.addButton(opts.cancelLabel, true, () => answer(false));
  handle.addButton(opts.okLabel, false, () => answer(true));
  handle.onKeydown((key) => {
    if (key === 'Escape') answer(false);
  });
}

/** A promise that settles with the first answer; later answers are ignored. */
export function createConfirmSession(): {
  promise: Promise<boolean>;
  settle: (ok: boolean) => void;
} {
  let resolve!: (ok: boolean) => void;
  let settled = false;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return {
    promise,
    settle: (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    },
  };
}

class ConfirmModal extends Modal {
  private triggerEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly opts: ConfirmOpts,
    private readonly settle: (ok: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const el = activeDocument.activeElement;
    this.triggerEl = el?.instanceOf(HTMLElement) ? el : null;
    const handle = makeContentElHandle(this.contentEl, this.modalEl, () => {
      this.triggerEl?.focus();
      this.close();
    });
    renderConfirmContent(handle, this.opts, this.settle);
  }

  onClose(): void {
    this.contentEl.empty();
    // Closed via the X button or a click outside: treat as Cancel.
    this.settle(false);
  }
}

/** Open a confirmation dialog; resolves true only on an explicit OK. */
export function openConfirm(app: App, opts: ConfirmOpts): Promise<boolean> {
  const session = createConfirmSession();
  new ConfirmModal(app, opts, session.settle).open();
  return session.promise;
}
