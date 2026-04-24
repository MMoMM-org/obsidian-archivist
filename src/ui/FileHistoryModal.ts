// FileHistoryModal — per-file version list with pagination and rename markers (T9.2).
//
// Design:
//   - renderHistoryContent() is a pure function over a HistoryHandle interface.
//     Tests inject a RecordingHistoryHandle; production builds a DOM adapter.
//   - formatVersionRow() and buildLiveNowRow() are standalone pure functions, also
//     exported for direct unit testing.
//   - The live-now row (current vault state) is prepended when the file exists.
//   - Pagination: 50 rows per page; [Show 50 more] advances visibleCount.
//   - Keyboard: Escape → onClose; Enter is intentionally inert (no destructive default).
//   - Focus capture/restore: onOpen() saves activeElement; onClose() restores it.
//
// All user-visible strings come from S (src/ui/strings.ts).

import { Modal, type App } from 'obsidian';
import { S } from './strings';
import type { VersionEntry } from '../services/RestoreService';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FormattedRow {
  timestamp: string;
  size: string;
  tierTag: string | null;
  renamedFromMarker: string | null;
  isNowRow: boolean;
  /** Synthetic snapshot_id — empty string for the live-now row. */
  snapshot_id: string;
  path: string;
  /** Raw size in bytes (used for restore confirmation). */
  rawSize: number;
  /** ISO created_at (used for restore confirmation). */
  created_at: string;
}

/** VaultInfo — current live-file metadata for the [now] row. */
export interface VaultInfo {
  /** Does the file currently exist in the vault? */
  exists: boolean;
  /** File size in bytes. */
  size: number;
  /** mtime as epoch ms. */
  mtime: number;
}

/**
 * HistoryHandle — the rendering contract used by renderHistoryContent().
 *
 * Production: a DOM-backed implementation wrapping contentEl.
 * Tests: a recording implementation that captures calls for assertion.
 */
export interface HistoryHandle {
  setTitle(title: string): void;
  showEmpty(msg: string): void;
  showSingleVersionMsg(msg: string): void;
  clearRows(): void;
  addRow(row: {
    timestamp: string;
    size: string;
    tierTag: string | null;
    renamedFrom: string | null;
    isNowRow: boolean;
    onPreview?: () => void;
    onRestore?: () => void;
  }): void;
  showShowMoreButton(onClick: () => void): void;
  hideShowMoreButton(): void;
  clearPreview(): void;
  showError(msg: string): void;
  close(): void;
  onKeydown(handler: (key: string) => void): void;
}

export interface HistoryRenderState {
  visibleCount: number;
  previewEntry: FormattedRow | null;
}

export interface HistoryRenderOpts {
  currentPath: string;
  entries: VersionEntry[];
  restoreService: {
    fetchContent(snapshotId: string, path: string): Promise<Uint8Array>;
  };
  restoreOperations: {
    restoreInPlace(path: string, snapshotId: string): Promise<unknown>;
  };
  vaultInfo: VaultInfo;
  /** Injectable clock — returns epoch ms. Defaults to Date.now() in production. */
  now?: () => number;
  /** Called when the user clicks Restore on a history row. */
  onConfirmRestore?: (entry: VersionEntry) => void;
  /** Called when Escape is pressed or the handle is closed. */
  onClose?: () => void;
  /**
   * Called when the user clicks [Show 50 more].
   * Receives the updated state; caller re-renders.
   */
  onShowMore?: (updatedState: HistoryRenderState) => void;
}

// ---------------------------------------------------------------------------
// Page size constant
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// formatVersionRow — pure, exported for unit tests
// ---------------------------------------------------------------------------

/** Format a VersionEntry into displayable strings. */
export function formatVersionRow(
  entry: VersionEntry,
  _prevEntry: VersionEntry | null,
  _nowMs: number,
): FormattedRow {
  const timestamp = new Date(entry.created_at).toLocaleString();
  const size = formatBytes(entry.size);
  const tierTag: string | null = null; // Tier not available on VersionEntry in V1
  const renamedFromMarker = buildRenamedFromMarker(entry);

  return {
    timestamp,
    size,
    tierTag,
    renamedFromMarker,
    isNowRow: false,
    snapshot_id: entry.snapshot_id,
    path: entry.path,
    rawSize: entry.size,
    created_at: entry.created_at,
  };
}

function buildRenamedFromMarker(entry: VersionEntry): string | null {
  if (!entry.priorPath || !entry.renamedAt) return null;
  const isoDate = entry.renamedAt.slice(0, 10); // YYYY-MM-DD
  return S.FILE_HISTORY_RENAMED_FROM(entry.priorPath, isoDate);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// buildLiveNowRow — pure, exported for unit tests
// ---------------------------------------------------------------------------

/** Synthetic now-row shape used for display only — no snapshot_id. */
export interface LiveNowRow {
  isNowRow: true;
  path: string;
  size: number;
  mtime: number;
  timestamp: string;
  tierTag: string;
}

/** Returns null when the file does not exist in the vault. */
export function buildLiveNowRow(
  vaultInfo: VaultInfo,
  currentPath: string,
  _nowMs: number,
): LiveNowRow | null {
  if (!vaultInfo.exists) return null;
  return {
    isNowRow: true,
    path: currentPath,
    size: vaultInfo.size,
    mtime: vaultInfo.mtime,
    timestamp: new Date(vaultInfo.mtime).toLocaleString(),
    tierTag: S.FILE_HISTORY_NOW_MARKER,
  };
}

// ---------------------------------------------------------------------------
// renderHistoryContent — pure render function
// ---------------------------------------------------------------------------

/**
 * Pure render function — writes all content into handle.
 * Called from onOpen() in production and directly from tests.
 */
export function renderHistoryContent(
  handle: HistoryHandle,
  opts: HistoryRenderOpts,
  state: HistoryRenderState,
): void {
  const nowMs = opts.now ? opts.now() : Date.now();
  const filename = opts.currentPath.split('/').pop() ?? opts.currentPath;
  handle.setTitle(`${S.FILE_HISTORY_TITLE} — ${filename}`);

  // Wire Escape key
  handle.onKeydown((key: string) => {
    if (key === 'Escape') opts.onClose?.();
  });

  // Build the live-now row (null if file deleted)
  const liveNowRow = buildLiveNowRow(opts.vaultInfo, opts.currentPath, nowMs);

  const entries = opts.entries;

  // ---- Empty case -----------------------------------------------------------
  if (entries.length === 0) {
    handle.showEmpty(S.FILE_HISTORY_EMPTY);
    return;
  }

  // ---- Single version -------------------------------------------------------
  if (entries.length === 1) {
    handle.showSingleVersionMsg(S.FILE_HISTORY_ONLY_ONE_VERSION);
  }

  // ---- Render rows ----------------------------------------------------------
  handle.clearRows();

  // Total renderable items: live-now (if present) + history entries
  const allItems: Array<{ isNow: boolean; entry?: VersionEntry }> = [];
  if (liveNowRow) allItems.push({ isNow: true });
  for (const e of entries) allItems.push({ isNow: false, entry: e });

  const visible = allItems.slice(0, state.visibleCount);

  for (const item of visible) {
    if (item.isNow && liveNowRow) {
      handle.addRow({
        timestamp: liveNowRow.timestamp,
        size: formatBytes(liveNowRow.size),
        tierTag: liveNowRow.tierTag,
        renamedFrom: null,
        isNowRow: true,
        // Live-now row has no preview or restore actions
        onPreview: undefined,
        onRestore: undefined,
      });
    } else if (item.entry) {
      const entry = item.entry;
      const formatted = formatVersionRow(entry, null, nowMs);
      handle.addRow({
        timestamp: formatted.timestamp,
        size: formatted.size,
        tierTag: formatted.tierTag,
        renamedFrom: formatted.renamedFromMarker,
        isNowRow: false,
        onPreview: () => {
          void opts.restoreService.fetchContent(entry.snapshot_id, entry.path);
        },
        onRestore: () => opts.onConfirmRestore?.(entry),
      });
    }
  }

  // ---- Pagination -----------------------------------------------------------
  if (allItems.length > state.visibleCount) {
    handle.showShowMoreButton(() => {
      const updatedState: HistoryRenderState = {
        ...state,
        visibleCount: state.visibleCount + PAGE_SIZE,
      };
      opts.onShowMore?.(updatedState);
    });
  } else {
    handle.hideShowMoreButton();
  }
}

// ---------------------------------------------------------------------------
// FileHistoryModal opts
// ---------------------------------------------------------------------------

export interface FileHistoryModalOpts {
  currentPath: string;
  entries: VersionEntry[];
  restoreService: HistoryRenderOpts['restoreService'];
  restoreOperations: HistoryRenderOpts['restoreOperations'];
  vaultInfo: VaultInfo;
  now?: () => number;
  /** Called when the user confirms a restore — opens ConfirmRestoreModal. */
  onConfirmRestore: (entry: VersionEntry) => void;
}

// ---------------------------------------------------------------------------
// FileHistoryModal — extends Obsidian Modal
// ---------------------------------------------------------------------------

export class FileHistoryModal extends Modal {
  private triggerEl: HTMLElement | null = null;
  private state: HistoryRenderState = { visibleCount: 50, previewEntry: null };
  private listEl!: HTMLElement;
  private readonly opts: FileHistoryModalOpts;
  private readonly abortController = new AbortController();

  constructor(app: App, opts: FileHistoryModalOpts) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const el = activeDocument.activeElement;
    this.triggerEl = el instanceof HTMLElement ? el : null;

    this.contentEl.empty();
    this.listEl = this.contentEl.createEl('div', { cls: 'archivist-file-history-list' });

    const handle = makeContentElHandle(
      this.contentEl,
      this.listEl,
      this.modalEl,
      this.abortController.signal,
      () => this.close(),
    );

    this._render(handle);
  }

  onClose(): void {
    this.abortController.abort();
    this.contentEl.empty();
    this.triggerEl?.focus();
  }

  private _render(handle: HistoryHandle): void {
    const renderOpts: HistoryRenderOpts = {
      ...this.opts,
      onClose: () => this.close(),
      onConfirmRestore: this.opts.onConfirmRestore,
      onShowMore: (updatedState: HistoryRenderState) => {
        this.state = updatedState;
        handle.clearRows();
        handle.hideShowMoreButton();
        // Re-render in the same handle context
        renderHistoryContent(handle, renderOpts, this.state);
      },
    };
    renderHistoryContent(handle, renderOpts, this.state);
  }
}

// ---------------------------------------------------------------------------
// DOM HistoryHandle adapter
// ---------------------------------------------------------------------------

function makeContentElHandle(
  contentEl: HTMLElement,
  listEl: HTMLElement,
  modalEl: HTMLElement,
  signal: AbortSignal,
  onClose: () => void,
): HistoryHandle {
  let titleEl: HTMLElement | null = null;
  let singleVersionEl: HTMLElement | null = null;
  let emptyEl: HTMLElement | null = null;
  let showMoreBtn: HTMLElement | null = null;
  const previewArea = contentEl.createEl('div', { cls: 'archivist-file-history-preview' });

  return {
    setTitle(title: string): void {
      if (!titleEl) titleEl = contentEl.createEl('h2', { cls: 'archivist-file-history-title' });
      titleEl.textContent = title;
    },

    showEmpty(msg: string): void {
      if (!emptyEl) emptyEl = listEl.createEl('p', { cls: 'archivist-file-history-empty' });
      emptyEl.textContent = msg;
    },

    showSingleVersionMsg(msg: string): void {
      if (!singleVersionEl) {
        singleVersionEl = listEl.createEl('p', { cls: 'archivist-file-history-one-version' });
      }
      singleVersionEl.textContent = msg;
    },

    clearRows(): void {
      listEl.empty();
      singleVersionEl = null;
      emptyEl = null;
    },

    addRow(row): void {
      const rowEl = listEl.createEl('div', { cls: 'archivist-file-history-row' });

      const metaEl = rowEl.createEl('span', { cls: 'archivist-fh-meta' });
      metaEl.textContent = `${row.timestamp} · ${row.size}`;

      if (row.tierTag) {
        rowEl.createEl('span', {
          text: row.tierTag,
          cls: 'archivist-fh-tier',
        });
      }

      if (row.renamedFrom) {
        rowEl.createEl('span', {
          text: row.renamedFrom,
          cls: 'archivist-fh-renamed',
        });
      }

      if (!row.isNowRow) {
        if (row.onPreview) {
          const previewBtn = rowEl.createEl('button', {
            text: S.FILE_HISTORY_PREVIEW_BUTTON,
            cls: 'archivist-fh-preview-btn',
          });
          previewBtn.addEventListener('click', () => row.onPreview?.(), { signal });
        }

        if (row.onRestore) {
          const restoreBtn = rowEl.createEl('button', {
            text: S.FILE_HISTORY_RESTORE_BUTTON,
            cls: 'archivist-fh-restore-btn',
          });
          // Restore is NOT the Enter-key default — tabindex="-1" on the button
          // means only explicit Tab-focus + Space or click activates it.
          restoreBtn.setAttribute('tabindex', '-1');
          restoreBtn.addEventListener('click', () => row.onRestore?.(), { signal });
        }
      }
    },

    showShowMoreButton(onClick: () => void): void {
      if (!showMoreBtn) {
        showMoreBtn = contentEl.createEl('button', {
          text: S.FILE_HISTORY_SHOW_MORE,
          cls: 'archivist-fh-show-more',
        });
      }
      showMoreBtn.addEventListener('click', onClick, { signal });
    },

    hideShowMoreButton(): void {
      showMoreBtn?.remove();
      showMoreBtn = null;
    },

    clearPreview(): void {
      previewArea.empty();
    },

    showError(msg: string): void {
      previewArea.createEl('p', { text: msg, cls: 'archivist-fh-error' });
    },

    close(): void {
      onClose();
    },

    onKeydown(handler: (key: string) => void): void {
      modalEl.addEventListener(
        'keydown',
        (e: KeyboardEvent) => handler(e.key),
        { signal },
      );
    },
  };
}
