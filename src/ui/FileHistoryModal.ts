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
//   - Preview: renderPreview() from PreviewPane handles binary/text split.
//   - Restore: ConfirmRestoreModal is opened directly — no callback indirection.
//   - Focus trap: Tab/Shift+Tab wrap within focusable elements.
//
// All user-visible strings come from S (src/ui/strings.ts).

import { Modal, MarkdownRenderChild, type App } from 'obsidian';
import { S } from './strings';
import type { VersionEntry } from '../services/RestoreService';
import type { SnapshotTier } from '../model/SnapshotIndex';
import { renderPreview, type PreviewContainerEl } from './PreviewPane';
import { ConfirmRestoreModal } from './ConfirmRestoreModal';

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
  showError(msg: string): void;
  close(): void;
  /** Called once per open — not per render. */
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
  /**
   * Called when the user clicks Restore on a history row.
   * Receives entry, timestamp string, size string, and computed missingDirs.
   */
  onRestore?: (
    entry: VersionEntry,
    timestamp: string,
    size: string,
    missingDirs: string[],
  ) => void;
  /** Called when Escape is pressed or the handle is closed. */
  onClose?: () => void;
  /**
   * Called when the user clicks [Show 50 more].
   * Receives the updated state; caller re-renders.
   */
  onShowMore?: (updatedState: HistoryRenderState) => void;
  /**
   * Called when the user clicks Preview on a history row.
   * Receives the fetched content bytes and path.
   */
  onPreviewContent?: (content: Uint8Array, path: string) => void;
  /**
   * Optional tier lookup — returns the tier for a given snapshot_id.
   * When omitted, tier tags are not rendered.
   */
  getTier?: (snapshotId: string) => SnapshotTier | null;
  /**
   * Returns true when the given vault-relative directory path exists in the
   * live vault. Used to compute missingDirs for ConfirmRestoreModal.
   * Defaults to always-true when omitted.
   */
  vaultHasPath?: (path: string) => boolean;
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
  getTier?: (snapshotId: string) => SnapshotTier | null,
): FormattedRow {
  const timestamp = new Date(entry.created_at).toLocaleString();
  const size = formatBytes(entry.size);
  const tier = getTier ? getTier(entry.snapshot_id) : null;
  const tierTag = tier ? tierLabel(tier) : null;
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

function tierLabel(tier: SnapshotTier): string {
  if (tier === 'daily') return S.FILE_HISTORY_TIER_DAILY;
  if (tier === 'monthly') return S.FILE_HISTORY_TIER_MONTHLY;
  if (tier === 'never_prune') return S.FILE_HISTORY_TIER_NEVER_PRUNE;
  return '';
}

function buildRenamedFromMarker(entry: VersionEntry): string | null {
  if (!entry.priorPath || !entry.renamedAt) return null;
  const isoDate = entry.renamedAt.slice(0, 10); // YYYY-MM-DD
  return S.FILE_HISTORY_RENAMED_FROM(entry.priorPath, isoDate);
}

export function formatBytes(bytes: number): string {
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
// computeMissingDirs — pure helper
// ---------------------------------------------------------------------------

/**
 * Compute the ancestor directories of a file path that do not exist in the
 * live vault. Returns an empty array when all dirs exist.
 *
 * @param path         - vault-relative file path (e.g. "a/b/c.md")
 * @param vaultHasPath - returns true when the path exists in the vault
 */
export function computeMissingDirs(
  path: string,
  vaultHasPath: (p: string) => boolean,
): string[] {
  const parts = path.split('/');
  const missing: string[] = [];
  // Iterate over ancestor dirs only (not the filename itself).
  // parts.length - 1 == last element is the filename.
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (!vaultHasPath(dir)) missing.push(dir);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// renderHistoryContent — pure render function
// ---------------------------------------------------------------------------

/**
 * Pure render function — writes all content into handle.
 * Called from _render() in production and directly from tests.
 *
 * NOTE: onKeydown wiring is intentionally NOT done here.
 * Call handle.onKeydown() once-per-open, not once-per-render, to prevent
 * listener accumulation on show-more re-renders.
 */
export function renderHistoryContent(
  handle: HistoryHandle,
  opts: HistoryRenderOpts,
  state: HistoryRenderState,
): void {
  const nowMs = opts.now ? opts.now() : Date.now();
  const filename = opts.currentPath.split('/').pop() ?? opts.currentPath;
  handle.setTitle(`${S.FILE_HISTORY_TITLE} — ${filename}`);

  // Build the live-now row (null if file deleted)
  const liveNowRow = buildLiveNowRow(opts.vaultInfo, opts.currentPath);

  const entries = opts.entries;
  const vaultHasPath = opts.vaultHasPath ?? (() => true);

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
      const formatted = formatVersionRow(entry, null, nowMs, opts.getTier);
      handle.addRow({
        timestamp: formatted.timestamp,
        size: formatted.size,
        tierTag: formatted.tierTag,
        renamedFrom: formatted.renamedFromMarker,
        isNowRow: false,
        onPreview: () => {
          void opts.restoreService
            .fetchContent(entry.snapshot_id, entry.path)
            .then((bytes) => {
              opts.onPreviewContent?.(bytes, entry.path);
            });
        },
        onRestore: () => {
          const missingDirs = computeMissingDirs(entry.currentPath, vaultHasPath);
          opts.onRestore?.(entry, formatted.timestamp, formatted.size, missingDirs);
        },
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
  getTier?: (snapshotId: string) => SnapshotTier | null;
  /** Returns true when the given vault-relative path exists (injected for tests). */
  vaultHasPath?: (path: string) => boolean;
}

// ---------------------------------------------------------------------------
// FileHistoryModal — extends Obsidian Modal
// ---------------------------------------------------------------------------

export class FileHistoryModal extends Modal {
  private triggerEl: HTMLElement | null = null;
  private state: HistoryRenderState = { visibleCount: 50, previewEntry: null };
  private listEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private readonly opts: FileHistoryModalOpts;
  private readonly abortController = new AbortController();
  /** Capture counter — increments on every preview click, used to discard stale results. */
  private previewGen = 0;

  constructor(app: App, opts: FileHistoryModalOpts) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const el = activeDocument.activeElement;
    this.triggerEl = el instanceof HTMLElement ? el : null;

    this.contentEl.empty();
    this.listEl = this.contentEl.createDiv({ cls: 'archivist-file-history-list' });
    this.previewEl = this.contentEl.createDiv({ cls: 'archivist-file-history-preview' });

    const handle = makeContentElHandle(
      this.contentEl,
      this.listEl,
      this.modalEl,
      this.abortController.signal,
      () => this.close(),
    );

    // Wire keyboard once per open — NOT inside renderHistoryContent.
    handle.onKeydown((key: string) => {
      if (key === 'Escape') this.close();
    });

    // Wire focus trap once per open.
    this._wireFocusTrap();

    this._render(handle);

    // Autofocus: Close button if present, else first Preview button.
    // This ensures Enter does not accidentally trigger Restore.
    this._autofocus();
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
      onPreviewContent: (bytes: Uint8Array, path: string) => {
        const gen = this.previewGen;
        if (gen !== this.previewGen) return; // stale — superseded
        this.previewEl.empty();
        // MarkdownRenderChild is the correct Obsidian Component for non-View/Plugin
        // contexts. Modal does not extend Component, so we create a child component
        // scoped to the preview element.
        const renderChild = new MarkdownRenderChild(this.previewEl);
        renderPreview(this.app, this.previewEl as unknown as PreviewContainerEl, bytes, path, renderChild)
          .then(() => {
            if (gen !== this.previewGen) {
              this.previewEl.empty(); // stale cleanup
              renderChild.unload();
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            renderChild.unload();
            this.previewEl.empty();
            this.previewEl.createEl('p', {
              text: `Preview failed: ${msg}`,
              cls: 'archivist-fh-error',
            });
          });
      },
      onRestore: (
        entry: VersionEntry,
        timestamp: string,
        size: string,
        missingDirs: string[],
      ) => {
        new ConfirmRestoreModal(this.app, {
          filePath: entry.currentPath,
          timestamp,
          size,
          missingDirs,
          onConfirm: () => {
            void this.opts.restoreOperations
              .restoreInPlace(entry.currentPath, entry.snapshot_id)
              .then(() => {
                this.close();
              })
              .catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.previewEl.empty();
                this.previewEl.createEl('p', {
                  text: `Restore failed: ${msg}`,
                  cls: 'archivist-fh-error',
                });
              });
          },
          onCancel: () => {},
        }).open();
      },
      onShowMore: (updatedState: HistoryRenderState) => {
        this.state = updatedState;
        handle.clearRows();
        handle.hideShowMoreButton();
        // Re-render content rows in same handle — keydown already wired above.
        renderHistoryContent(handle, renderOpts, this.state);
      },
    };

    // Increment preview generation — any in-flight preview from before this
    // render cycle is now stale.
    this.previewGen++;

    renderHistoryContent(handle, renderOpts, this.state);
  }

  private _wireFocusTrap(): void {
    const { signal } = this.abortController;
    this.modalEl.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key !== 'Tab') return;
        const focusable = Array.from(
          this.modalEl.querySelectorAll<HTMLElement>(
            'button, a[href], input, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute('disabled'));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = activeDocument.activeElement;
        if (e.shiftKey) {
          if (active === first || !focusable.includes(active as HTMLElement)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !focusable.includes(active as HTMLElement)) {
            e.preventDefault();
            first.focus();
          }
        }
      },
      { signal },
    );
  }

  private _autofocus(): void {
    // Prefer the Close button (non-destructive anchor); fall back to first
    // Preview button. This prevents Enter from accidentally firing Restore.
    const closeBtn = this.modalEl.querySelector<HTMLElement>('.archivist-fh-close-btn');
    if (closeBtn) {
      closeBtn.focus();
      return;
    }
    const previewBtn = this.modalEl.querySelector<HTMLElement>('.archivist-fh-preview-btn');
    if (previewBtn) {
      previewBtn.focus();
    }
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

  // Show-more: create button once, update callback via mutable ref (ROB-001).
  let showMoreCurrentOnClick: (() => void) | null = null;
  const showMoreBtn = contentEl.createEl('button', {
    text: S.FILE_HISTORY_SHOW_MORE,
    cls: 'archivist-fh-show-more',
  });
  showMoreBtn.setAttribute('hidden', '');
  showMoreBtn.addEventListener('click', () => showMoreCurrentOnClick?.(), { signal });

  // Close button
  const closeBtn = contentEl.createEl('button', {
    text: 'Close',
    cls: 'archivist-fh-close-btn',
  });
  closeBtn.addEventListener('click', () => onClose(), { signal });

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
      const rowEl = listEl.createDiv({ cls: 'archivist-file-history-row' });

      const metaEl = rowEl.createSpan({ cls: 'archivist-fh-meta' });
      metaEl.textContent = `${row.timestamp} · ${row.size}`;

      if (row.tierTag) {
        rowEl.createSpan({
          text: row.tierTag,
          cls: 'archivist-fh-tier',
        });
      }

      if (row.renamedFrom) {
        rowEl.createSpan({
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
      showMoreCurrentOnClick = onClick;
      showMoreBtn.removeAttribute('hidden');
    },

    hideShowMoreButton(): void {
      showMoreCurrentOnClick = null;
      showMoreBtn.setAttribute('hidden', '');
    },

    showError(msg: string): void {
      contentEl.createEl('p', { text: msg, cls: 'archivist-fh-error' });
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
