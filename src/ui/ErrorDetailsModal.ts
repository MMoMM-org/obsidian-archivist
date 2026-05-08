// ErrorDetailsModal — surfaced when the user clicks the status-bar icon in
// the ERROR or AUTH_LOST state. Shows the last recorded backup failure with
// enough detail (code, message, stack, timestamp, kind) to act on, plus a
// shortcut to the plugin settings tab.
//
// Why a modal instead of routing to settings: status-bar icon is the single
// always-visible alert affordance. Users who collapse the ribbon column
// still need a one-click path from "I see the warning triangle" to "I know
// what's wrong" without scrolling through the settings tab.
//
// Render function is pure over a ModalHandle — same pattern as
// AdoptVaultModal — so tests can exercise it without spinning up Obsidian.

import { Modal, type App } from 'obsidian';
import type { ModalHandle } from './ConfirmRestoreModal';
import { S } from './strings';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ErrorDetailsRecord {
  /** Classification used by NoticeCenter (NETWORK / DEVICE_CONFLICT / ...). */
  code: string;
  /** Raw error message captured from the thrown error. */
  message: string;
  /** Stack trace if the original error was an Error instance. */
  stack: string | null;
  /** Epoch-ms when the failure was recorded. */
  at: number;
  /** Whether the failed run was an incremental or a full backup. */
  kind: 'inc' | 'full';
}

export interface ErrorDetailsModalOpts {
  /** Last failure, or null when nothing is currently recorded. */
  lastError: ErrorDetailsRecord | null;
  /** Optional supplier so tests can stub formatting; default below. */
  formatTimestamp?: (epochMs: number) => string;
  /** Called when the user clicks "Open Archivist settings". */
  onOpenSettings: () => void;
  /** Called when the user clicks "Copy report" — return value drives the toast. */
  onCopy: (report: string) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultFormatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleString();
}

export function buildErrorReport(record: ErrorDetailsRecord): string {
  const ts = new Date(record.at).toISOString();
  const lines = [
    `[archivist] backup failed`,
    `time: ${ts}`,
    `kind: ${record.kind}`,
    `code: ${record.code}`,
    `message: ${record.message}`,
  ];
  if (record.stack) {
    lines.push('', 'stack:', record.stack);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Pure rendering — exercised directly by tests
// ---------------------------------------------------------------------------

export function renderErrorDetailsContent(
  handle: ModalHandle,
  opts: ErrorDetailsModalOpts,
): void {
  const { lastError, onOpenSettings, onCopy } = opts;
  const formatTimestamp = opts.formatTimestamp ?? defaultFormatTimestamp;

  handle.setTitle(S.ERROR_DETAILS_TITLE);

  if (!lastError) {
    handle.setBody(S.ERROR_DETAILS_NO_ERROR);
    handle.addButton(S.ERROR_DETAILS_OPEN_SETTINGS, false, () => {
      onOpenSettings();
      handle.close();
    });
    handle.addButton(S.ERROR_DETAILS_CLOSE, true, () => handle.close());
    handle.onKeydown((key) => {
      if (key === 'Escape') handle.close();
    });
    return;
  }

  // Body summarises the failure in plain language; the labelled lines below
  // give the structured context (kind / code / time) that the user typically
  // copy-pastes into a bug report.
  handle.setBody(`${S.ERROR_DETAILS_HEADING_WHAT}: ${lastError.message}`);
  handle.addLine(`${S.ERROR_DETAILS_LABEL_KIND}: ${lastError.kind}`);
  handle.addLine(`${S.ERROR_DETAILS_LABEL_CODE}: ${lastError.code}`);
  handle.addLine(`${S.ERROR_DETAILS_LABEL_TIME}: ${formatTimestamp(lastError.at)}`);
  handle.addLine(S.ERROR_DETAILS_HINT);

  handle.addButton(S.ERROR_DETAILS_COPY, false, () => {
    void onCopy(buildErrorReport(lastError));
  });
  handle.addButton(S.ERROR_DETAILS_OPEN_SETTINGS, false, () => {
    onOpenSettings();
    handle.close();
  });
  handle.addButton(S.ERROR_DETAILS_CLOSE, true, () => handle.close());

  handle.onKeydown((key) => {
    if (key === 'Escape') handle.close();
  });
}

// ---------------------------------------------------------------------------
// ErrorDetailsModal — Obsidian Modal subclass
// ---------------------------------------------------------------------------

export class ErrorDetailsModal extends Modal {
  private triggerEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly opts: ErrorDetailsModalOpts,
  ) {
    super(app);
  }

  onOpen(): void {
    const el = activeDocument.activeElement;
    this.triggerEl = el instanceof HTMLElement ? el : null;
    const handle = this.makeHandle();
    renderErrorDetailsContent(handle, this.opts);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private makeHandle(): ModalHandle {
    let titleEl: HTMLElement | null = null;
    let bodyEl: HTMLElement | null = null;
    const controller = new AbortController();
    const closeFn = (): void => {
      this.triggerEl?.focus();
      this.close();
    };
    return {
      setTitle: (title) => {
        if (!titleEl) titleEl = this.contentEl.createEl('h2');
        titleEl.textContent = title;
      },
      setBody: (body) => {
        if (!bodyEl) bodyEl = this.contentEl.createEl('p');
        bodyEl.textContent = body;
      },
      addLine: (line) => {
        this.contentEl.createEl('p', { text: line });
      },
      addButton: (label, isDefault, onClick) => {
        const btn = this.contentEl.createEl('button', { text: label });
        if (isDefault) btn.setAttribute('autofocus', '');
        btn.addEventListener('click', onClick);
      },
      close: () => {
        controller.abort();
        closeFn();
      },
      onKeydown: (handler) => {
        this.modalEl.addEventListener(
          'keydown',
          (e: KeyboardEvent) => handler(e.key),
          { signal: controller.signal },
        );
      },
    };
  }
}
