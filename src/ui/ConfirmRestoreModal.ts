// ConfirmRestoreModal — destructive-action guard for restore operations (T9.3).
//
// Safety contract:
//   - Cancel is the default button (Enter key is inert — it does NOT trigger Replace).
//   - Escape fires onCancel and closes.
//   - Tab-to-Replace-then-Space or a mouse click is the only way to confirm.
//   - Either outcome (confirm or cancel) closes the modal and returns focus to trigger.
//
// All user-visible copy comes from S (src/ui/strings.ts).
//
// Testability: renderConfirmRestoreContent() is a pure function that writes to
// a ModalHandle interface. Tests inject a recording ModalHandle without touching
// real Obsidian APIs. Production wires a ModalHandle over this.contentEl inside
// onOpen().

import { Modal, type App } from 'obsidian';
import { S } from './strings';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConfirmRestoreOpts {
  /** Vault-relative path of the file to be restored. */
  filePath: string;
  /** Human-readable snapshot timestamp (e.g. "2025-01-15 14:30"). */
  timestamp: string;
  /** Human-readable file size (e.g. "12 KB"). */
  size: string;
  /**
   * Folders that do not exist and will be created.
   * Empty array → standard in-place copy.
   * Non-empty → shows `CONFIRM_RESTORE_CREATES_DIR` variant.
   */
  missingDirs: string[];
  /**
   * Optional override for the body sentence. When set the modal uses the
   * standard in-place title and renders this string verbatim, regardless of
   * `missingDirs`. Used by callers (dir-restore) that need a custom body
   * but should not be forced through the creates-dir branch when no
   * directories are actually missing.
   */
  customBody?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * ModalHandle — rendering contract used by renderConfirmRestoreContent().
 *
 * Production: built over this.contentEl inside onOpen().
 * Tests: a recording implementation captures all calls for assertion.
 */
export interface ModalHandle {
  setTitle(title: string): void;
  setBody(body: string): void;
  /** Add a supplemental line below the body (used for dir listing). */
  addLine(line: string): void;
  addButton(label: string, isDefault: boolean, onClick: () => void): void;
  close(): void;
  /** Subscribe to raw keydown events on the modal element. */
  onKeydown(handler: (key: string) => void): void;
}

// ---------------------------------------------------------------------------
// Pure rendering function — testable without Obsidian
// ---------------------------------------------------------------------------

/**
 * Render all content + wire keyboard and button callbacks into handle.
 * Called from onOpen() in production and directly from tests.
 */
export function renderConfirmRestoreContent(
  handle: ModalHandle,
  opts: ConfirmRestoreOpts,
): void {
  const { filePath, timestamp, size, missingDirs, customBody, onConfirm, onCancel } = opts;
  const createsDir = missingDirs.length > 0;

  // ---- Title & body ---------------------------------------------------------
  //
  // `customBody` lets non-file callers (dir-restore) supply their own body
  // sentence without being forced through the creates-dir branch when no
  // directories actually need creating. When set, we keep the standard
  // in-place title and render the override verbatim. Missing-dir lines are
  // still appended after, so a dir-restore that DOES need to create
  // ancestors gets both the custom body AND the affected dirs listed.

  if (customBody !== undefined) {
    handle.setTitle(S.CONFIRM_RESTORE_IN_PLACE_TITLE);
    handle.setBody(customBody);
    for (const dir of missingDirs) {
      handle.addLine(dir);
    }
  } else if (createsDir) {
    handle.setTitle(S.CONFIRM_RESTORE_CREATES_DIR_TITLE);
    handle.setBody(
      S.CONFIRM_RESTORE_CREATES_DIR_BODY(filePath, timestamp, size, missingDirs.join(', ')),
    );
    for (const dir of missingDirs) {
      handle.addLine(dir);
    }
  } else {
    handle.setTitle(S.CONFIRM_RESTORE_IN_PLACE_TITLE);
    handle.setBody(S.CONFIRM_RESTORE_IN_PLACE_BODY(filePath, timestamp, size));
  }

  // ---- Buttons --------------------------------------------------------------

  const cancelLabel = createsDir
    ? S.CONFIRM_RESTORE_CREATES_DIR_CANCEL
    : S.CONFIRM_RESTORE_IN_PLACE_CANCEL;
  const okLabel = createsDir
    ? S.CONFIRM_RESTORE_CREATES_DIR_OK
    : S.CONFIRM_RESTORE_IN_PLACE_OK;

  const dismiss = (action: () => void): void => {
    action();
    handle.close();
  };

  // Cancel is default (isDefault = true) — Enter activates the default button
  // in most dialog systems; by making Cancel the default, Enter is inert for
  // the destructive Replace action.
  handle.addButton(cancelLabel, true, () => dismiss(onCancel));
  handle.addButton(okLabel, false, () => dismiss(onConfirm));

  // ---- Keyboard -------------------------------------------------------------

  handle.onKeydown((key: string) => {
    if (key === 'Escape') dismiss(onCancel);
    // Enter: intentionally unhandled — default button (Cancel) handles it
    // only if the host's native focus/Enter dispatch reaches it, which
    // production Obsidian Modal does via the browser's button-focus model.
    // Tests assert Enter does NOT call onConfirm.
  });
}

// ---------------------------------------------------------------------------
// ConfirmRestoreModal — extends Obsidian Modal
// ---------------------------------------------------------------------------

export class ConfirmRestoreModal extends Modal {
  /** Element focused before open(); restored on dismiss. */
  private triggerEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly opts: ConfirmRestoreOpts,
  ) {
    super(app);
  }

  onOpen(): void {
    const el = activeDocument.activeElement;
    this.triggerEl = el instanceof HTMLElement ? el : null;
    const handle = makeContentElHandle(this.contentEl, this.modalEl, () => {
      this.triggerEl?.focus();
      this.close();
    });
    renderConfirmRestoreContent(handle, this.opts);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Production ModalHandle adapter over Obsidian's contentEl
// ---------------------------------------------------------------------------

function makeContentElHandle(
  contentEl: HTMLElement,
  modalEl: HTMLElement,
  dismiss: () => void,
): ModalHandle {
  let titleEl: HTMLElement | null = null;
  let bodyEl: HTMLElement | null = null;
  const controller = new AbortController();

  return {
    setTitle(title: string): void {
      if (!titleEl) {
        titleEl = contentEl.createEl('h2');
      }
      titleEl.textContent = title;
    },

    setBody(body: string): void {
      if (!bodyEl) {
        bodyEl = contentEl.createEl('p');
      }
      bodyEl.textContent = body;
    },

    addLine(line: string): void {
      contentEl.createEl('p', { text: line });
    },

    addButton(label: string, isDefault: boolean, onClick: () => void): void {
      const btn = contentEl.createEl('button', { text: label });
      if (isDefault) btn.setAttribute('autofocus', '');
      btn.addEventListener('click', onClick);
    },

    close(): void {
      controller.abort();
      dismiss();
    },

    onKeydown(handler: (key: string) => void): void {
      modalEl.addEventListener(
        'keydown',
        (e: KeyboardEvent) => handler(e.key),
        { signal: controller.signal },
      );
    },
  };
}
