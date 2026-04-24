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
// Testability: the ModalHost interface wraps all DOM + lifecycle operations so
// that unit tests drive a recording host without touching real Obsidian APIs.
// Production code wires a real Obsidian Modal via ObsidianModalHost (see
// createObsidianModalHost()).

import { S } from './strings';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConfirmRestoreModalParams {
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
  onConfirm: () => void;
  onCancel: () => void;
}

/** Opaque handle returned by ModalHost.open(); drives the dialog contents. */
export interface ModalHandle {
  setTitle(title: string): void;
  setBody(body: string): void;
  /** Add a supplemental line below the body (used for dir listing). */
  addLine(line: string): void;
  addButton(label: string, isDefault: boolean, onClick: () => void): void;
  close(): void;
  returnFocusToTrigger(): void;
  /** Subscribe to raw keydown events on the modal element. */
  onKeydown(handler: (key: string) => void): void;
}

/**
 * ModalHost — DOM/lifecycle boundary for testability.
 *
 * Production: wire with `createObsidianModalHost(app)` which returns a
 * host that opens a real Obsidian Modal.
 * Tests: pass a recording host that captures all calls.
 */
export interface ModalHost {
  open(): ModalHandle;
}

// ---------------------------------------------------------------------------
// ConfirmRestoreModal
// ---------------------------------------------------------------------------

export class ConfirmRestoreModal {
  constructor(
    private readonly params: ConfirmRestoreModalParams,
    private readonly host: ModalHost,
  ) {}

  /** Open the modal and wire all content + keyboard logic. */
  present(): void {
    const { filePath, timestamp, size, missingDirs, onConfirm, onCancel } = this.params;
    const createsDir = missingDirs.length > 0;

    const handle = this.host.open();

    // ---- Title & body -------------------------------------------------------

    if (createsDir) {
      handle.setTitle(S.CONFIRM_RESTORE_CREATES_DIR_TITLE);
      handle.setBody(
        S.CONFIRM_RESTORE_CREATES_DIR_BODY(
          filePath,
          timestamp,
          size,
          missingDirs.join(', '),
        ),
      );
      for (const dir of missingDirs) {
        handle.addLine(dir);
      }
    } else {
      handle.setTitle(S.CONFIRM_RESTORE_IN_PLACE_TITLE);
      handle.setBody(S.CONFIRM_RESTORE_IN_PLACE_BODY(filePath, timestamp, size));
    }

    // ---- Buttons ------------------------------------------------------------

    const cancelLabel = createsDir
      ? S.CONFIRM_RESTORE_CREATES_DIR_CANCEL
      : S.CONFIRM_RESTORE_IN_PLACE_CANCEL;
    const okLabel = createsDir
      ? S.CONFIRM_RESTORE_CREATES_DIR_OK
      : S.CONFIRM_RESTORE_IN_PLACE_OK;

    const dismiss = (action: () => void): void => {
      action();
      handle.returnFocusToTrigger();
      handle.close();
    };

    // Cancel is default (isDefault = true) — Enter activates the default button
    // in most dialog systems; by making Cancel the default, Enter is inert for
    // the destructive Replace action.
    handle.addButton(cancelLabel, true, () => dismiss(onCancel));
    handle.addButton(okLabel, false, () => dismiss(onConfirm));

    // ---- Keyboard -----------------------------------------------------------

    handle.onKeydown((key: string) => {
      if (key === 'Escape') dismiss(onCancel);
      // Enter: intentionally unhandled — default button (Cancel) handles it
      // only if the host's native focus/Enter dispatch reaches it, which
      // production Obsidian Modal does via the browser's button-focus model.
      // Tests assert Enter does NOT call onConfirm.
    });
  }
}

// ---------------------------------------------------------------------------
// Production wiring helper
// ---------------------------------------------------------------------------
// Separated from the class so the class stays dependency-injection–friendly
// and doesn't hard-import Obsidian at test time.

// import { Modal, type App } from 'obsidian';
//
// export function createObsidianModalHost(app: App): ModalHost {
//   return {
//     open(): ModalHandle {
//       const modal = new (class extends Modal {
//         onOpen(): void {}
//         onClose(): void {}
//       })(app);
//       modal.open();
//       // wire handle to modal.contentEl ...
//       ...
//     },
//   };
// }
//
// The full production wiring is deferred to T9.5 integration, when the
// surrounding BackupBrowserView / FileHistoryModal call sites are implemented.
