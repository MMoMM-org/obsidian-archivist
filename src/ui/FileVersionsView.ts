// FileVersionsView — per-file version browser as a 3-column ItemView.
//
// Sister surface to BackupBrowserView. Where the Backup Browser pivots on
// snapshots and lists files within them, this view pivots on a single file
// and lists every snapshot that holds a version of it.
//
// Layout: [File info] | [Versions list] | [Preview + Restore]
//
// Stale-async pattern (mirrors BackupBrowserView Fix 1 + Fix 3):
//   - `_closed` flag flips true on onClose; every continuation bails
//     before touching DOM after a close.
//   - Selection captured BEFORE every await; if the user clicks another
//     version mid-fetch, the in-flight handler bails on resume.
//
// The view loads its own snapshot chain via Promise.allSettled so a single
// missing/corrupt manifest does not prevent any other version from
// rendering — a deliberate ROB tolerance, paralleling RestoreService's
// rename-collision skip-and-warn behaviour.

import { ItemView, MarkdownRenderChild, type WorkspaceLeaf, type App } from 'obsidian';
import type { SnapshotManifest } from '../model/Manifest';
import type { SnapshotIndexEntry, SnapshotTier } from '../model/SnapshotIndex';
import type { VersionEntry } from '../services/RestoreService';
import { ChainError } from '../model/Errors';
import {
  renderPreview,
  type PreviewContainerEl,
  type PreviewAdvisoryNoticeCenter,
} from './PreviewPane';
import { ConfirmRestoreModal } from './ConfirmRestoreModal';
import { computeMissingDirs, formatBytes } from './FileHistoryModal';
import { mapRestoreErrorToToast } from './restoreErrorToast';
import { S } from './strings';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * View-type constant. **Frozen** — Obsidian persists this string in
 * `workspace.json` the first time a user opens the view; renaming it will
 * silently drop the saved leaf on next load. Any rename requires an
 * `onload` migration that converts stale leaf states.
 */
export const FILE_VERSIONS_VIEW_TYPE = 'archivist-file-versions';

export interface FileVersionsViewState {
  path: string;
}

export interface FileVersionsRestoreServiceSubset {
  fetchContent(snapshotId: string, path: string): Promise<Uint8Array>;
  listVersionsForPath(currentPath: string, manifests: SnapshotManifest[]): VersionEntry[];
}

export interface FileVersionsManifestCacheSubset {
  listSnapshotsNewestFirst(): Promise<SnapshotIndexEntry[]>;
  loadManifest(id: string): Promise<SnapshotManifest>;
}

export interface FileVersionsRestoreOpsSubset {
  restoreInPlace(path: string, snapshotId: string): Promise<unknown>;
  restoreAsCopy(path: string, snapshotId: string): Promise<unknown>;
}

export interface FileVersionsViewDeps {
  restoreService: FileVersionsRestoreServiceSubset;
  manifestCache: FileVersionsManifestCacheSubset;
  restoreOperations: FileVersionsRestoreOpsSubset;
  noticeCenter: PreviewAdvisoryNoticeCenter;
  /** Returns true when the given vault-relative path exists in the live vault. */
  vaultHasPath: (path: string) => boolean;
  /** Toast surface for restore success / error messages. */
  notify?: (message: string) => void;
  /** Inject app for tests; ItemView sets it from the leaf in production. */
  app?: App;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Tier label for a snapshot row. Mirrors the labels used in BackupBrowserView
 * so the two views read the same to the user.
 */
export function fvTierLabel(tier: SnapshotTier | null | undefined): string | null {
  if (tier === 'daily') return S.BROWSER_TIER_DAILY;
  if (tier === 'monthly') return S.BROWSER_TIER_MONTHLY;
  if (tier === 'never_prune') return S.BROWSER_TIER_NEVER_PRUNE;
  return null;
}

/**
 * Format the timestamp shown in a version row. Locale-aware compact form,
 * 24-hour time — matches BackupBrowserView's `formatSnapshotDate`.
 */
export function fvFormatTimestamp(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

// ---------------------------------------------------------------------------
// FileVersionsView
// ---------------------------------------------------------------------------

export class FileVersionsView extends ItemView {
  private readonly deps: FileVersionsViewDeps;

  private currentPath: string | null = null;
  private versions: VersionEntry[] = [];
  /** snapshot_id → tier (from SnapshotIndexEntry) for tier-tag rendering. */
  private tierByID: Map<string, SnapshotTier | null> = new Map();
  private selectedSnapshotId: string | null = null;
  /**
   * The Component scoping the currently-rendered preview. We unload it
   * before rendering a new preview so each render does not leak a
   * MarkdownRenderChild — `previewColEl.empty()` removes DOM nodes but the
   * View still holds Component refs in its child list otherwise.
   */
  private _activeRenderChild: MarkdownRenderChild | null = null;

  // Column shells
  private fileColEl!: HTMLElement;
  private snapshotsListEl!: HTMLElement;
  private previewColEl!: HTMLElement;

  private _closed = false;

  constructor(leaf: WorkspaceLeaf, deps: FileVersionsViewDeps) {
    super(leaf);
    this.deps = deps;
    if (deps.app) this.app = deps.app;
  }

  getViewType(): string {
    return FILE_VERSIONS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.currentPath
      ? `${S.FILE_VERSIONS_TAB_TITLE} — ${basename(this.currentPath)}`
      : S.FILE_VERSIONS_TAB_TITLE;
  }

  getIcon(): string {
    return 'history';
  }

  async setState(state: FileVersionsViewState, _result: unknown): Promise<void> {
    if (state && typeof state.path === 'string' && state.path !== this.currentPath) {
      this.currentPath = state.path;
      // Re-render and reload versions for the new path. Safe to call before
      // onOpen runs; _renderShell guards against missing DOM.
      if (this.fileColEl) {
        await this._renderForCurrentPath();
      }
    }
  }

  getState(): Record<string, unknown> {
    return { path: this.currentPath ?? '' };
  }

  async onOpen(): Promise<void> {
    this._closed = false;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('archivist-fv');

    const columns = contentEl.createDiv({ cls: 'archivist-fv-columns' });

    this.fileColEl = columns.createDiv({ cls: 'archivist-fv-file' });
    this.fileColEl.createEl('h3', { text: S.FILE_VERSIONS_COL_FILE });

    const snapshotsCol = columns.createDiv({ cls: 'archivist-fv-snapshots' });
    snapshotsCol.createEl('h3', {
      text: S.FILE_VERSIONS_COL_SNAPSHOTS,
      attr: { id: 'archivist-fv-snapshots-label' },
    });
    this.snapshotsListEl = snapshotsCol.createDiv({
      cls: 'archivist-fv-snapshots-list',
      attr: {
        tabindex: '0',
        role: 'listbox',
        'aria-labelledby': 'archivist-fv-snapshots-label',
      },
    });
    // Roving-tabindex bridge: when the user tabs INTO the listbox container
    // and presses Arrow keys, focus the first (or last on ArrowUp) row.
    // Without this, the user lands on the container with no path to the
    // rows themselves — keyboard-trap.
    this.snapshotsListEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const rows = Array.from(
        this.snapshotsListEl.querySelectorAll<HTMLElement>('.archivist-fv-snapshot-row'),
      );
      if (rows.length === 0) return;
      // If focus is already on a row inside the list, let the row's own
      // handler take over.
      if (rows.includes(activeDocument.activeElement as HTMLElement)) return;
      e.preventDefault();
      const target = e.key === 'ArrowDown' ? rows[0] : rows[rows.length - 1];
      target.focus();
    });

    this.previewColEl = columns.createDiv({
      cls: 'archivist-fv-preview',
      attr: { tabindex: '0' },
    });
    // Note: per-version timestamp is rendered as a `role=status` element
    // below this static heading, NOT as a replacement for the heading.
    // Heading-nav users (NVDA/JAWS H key) keep a stable structural anchor;
    // the live region announces each selection without overloading the
    // heading semantics.
    this.previewColEl.createEl('h3', { text: S.FILE_VERSIONS_COL_PREVIEW });

    if (this.currentPath) {
      await this._renderForCurrentPath();
    }
  }

  async onClose(): Promise<void> {
    this._closed = true;
    this._unloadActiveRenderChild();
    this.contentEl.empty();
  }

  // -------------------------------------------------------------------------
  // Rendering — pieces the columns from current state
  // -------------------------------------------------------------------------

  private async _renderForCurrentPath(): Promise<void> {
    const path = this.currentPath;
    if (!path) return;

    this._renderFileInfo(path);

    this.snapshotsListEl.empty();
    this.snapshotsListEl.createEl('p', {
      text: S.BROWSER_LOADING,
      cls: 'archivist-loading',
    });

    let snapshots: SnapshotIndexEntry[];
    try {
      snapshots = await this.deps.manifestCache.listSnapshotsNewestFirst();
    } catch (err) {
      if (this._closed) return;
      this._renderSnapshotsError(err);
      return;
    }
    if (this._closed || this.currentPath !== path) return;

    this.tierByID = new Map(snapshots.map((s) => [s.id, s.tier ?? null] as const));

    // Promise.allSettled — one missing or corrupt manifest must NOT take
    // down the whole view. Successfully-loaded manifests still produce
    // version entries; failures are silently dropped (the user sees the
    // remaining versions, which is a strictly better experience than an
    // empty error state).
    const settled = await Promise.allSettled(
      snapshots.map((s) => this.deps.manifestCache.loadManifest(s.id)),
    );
    if (this._closed || this.currentPath !== path) return;
    const manifests: SnapshotManifest[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') manifests.push(result.value);
    }

    let entries: VersionEntry[] = [];
    try {
      entries = this.deps.restoreService.listVersionsForPath(path, manifests);
    } catch (err) {
      if (this._closed || this.currentPath !== path) return;
      this._renderSnapshotsError(err);
      return;
    }
    if (this._closed || this.currentPath !== path) return;

    this.versions = entries;
    this._renderVersionsList();

    // Auto-select the newest version so the user lands on a usable state
    // instead of an empty preview pane. Skip when no versions exist —
    // _renderVersionsList already shows the empty placeholder there.
    if (entries.length > 0) {
      void this._selectVersion(entries[0]);
    } else {
      this._renderPreviewEmpty();
    }
  }

  private _renderFileInfo(path: string): void {
    // Keep the header h3 (col title), append/replace info block underneath.
    this.fileColEl.empty();
    this.fileColEl.createEl('h3', { text: S.FILE_VERSIONS_COL_FILE });
    const slash = path.lastIndexOf('/');
    const base = slash >= 0 ? path.slice(slash + 1) : path;
    this.fileColEl.createEl('p', { text: base, cls: 'archivist-fv-file-basename' });
    if (slash >= 0) {
      this.fileColEl.createEl('p', { text: path, cls: 'archivist-fv-file-path' });
    }
    if (this.deps.vaultHasPath(path)) {
      this.fileColEl.createEl('p', {
        text: S.FILE_VERSIONS_LIVE_LABEL,
        cls: 'archivist-fv-file-live',
      });
    } else {
      this.fileColEl.createEl('p', {
        text: S.FILE_VERSIONS_LIVE_MISSING,
        cls: 'archivist-fv-file-live',
      });
    }
  }

  private _renderVersionsList(): void {
    this.snapshotsListEl.empty();
    if (this.versions.length === 0) {
      this.snapshotsListEl.createEl('p', {
        text: S.FILE_VERSIONS_EMPTY,
        cls: 'archivist-loading',
      });
      return;
    }

    const rows: HTMLElement[] = [];
    for (const entry of this.versions) {
      const row = this._renderVersionRow(entry);
      rows.push(row);
    }
    // Local arrow-key navigation (mirrors BackupBrowserView's wireArrowNav).
    rows.forEach((row, i) => {
      row.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'ArrowDown' && i + 1 < rows.length) {
          e.preventDefault();
          rows[i + 1].focus();
          void this._selectVersion(this.versions[i + 1]);
        } else if (e.key === 'ArrowUp' && i > 0) {
          e.preventDefault();
          rows[i - 1].focus();
          void this._selectVersion(this.versions[i - 1]);
        }
      });
    });
  }

  private _renderVersionRow(entry: VersionEntry): HTMLElement {
    const row = this.snapshotsListEl.createDiv({ cls: 'archivist-fv-snapshot-row' });
    row.setAttribute('tabindex', '-1');
    row.setAttribute('role', 'option');
    row.setAttribute(
      'aria-selected',
      entry.snapshot_id === this.selectedSnapshotId ? 'true' : 'false',
    );

    const ts = fvFormatTimestamp(new Date(entry.created_at));
    row.createSpan({
      text: `${ts} · ${formatBytes(entry.size)}`,
      cls: 'archivist-fv-snapshot-meta',
    });
    const tier = fvTierLabel(this.tierByID.get(entry.snapshot_id) ?? null);
    if (tier) {
      row.createSpan({ text: tier, cls: 'archivist-fv-snapshot-tier' });
    }
    if (entry.priorPath && entry.renamedAt) {
      row.createSpan({
        text: S.FILE_HISTORY_RENAMED_FROM(entry.priorPath, entry.renamedAt.slice(0, 10)),
        cls: 'archivist-fv-snapshot-renamed',
      });
    }

    row.addEventListener('click', () => {
      void this._selectVersion(entry);
    });
    row.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void this._selectVersion(entry);
      }
    });
    return row;
  }

  // -------------------------------------------------------------------------
  // Selection + preview
  // -------------------------------------------------------------------------

  private async _selectVersion(entry: VersionEntry): Promise<void> {
    const capturedId = entry.snapshot_id;
    this.selectedSnapshotId = capturedId;
    // Re-render the list so the selected row picks up aria-selected.
    this._renderVersionsList();

    this.previewColEl.empty();
    this.previewColEl.createEl('h3', { text: S.FILE_VERSIONS_COL_PREVIEW });
    this.previewColEl.createEl('p', {
      text: fvFormatTimestamp(new Date(entry.created_at)),
      cls: 'archivist-fv-preview-timestamp',
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    this.previewColEl.createEl('p', {
      text: S.BROWSER_LOADING,
      cls: 'archivist-loading',
    });

    let bytes: Uint8Array;
    try {
      bytes = await this.deps.restoreService.fetchContent(capturedId, entry.path);
    } catch (err) {
      if (this._closed || this.selectedSnapshotId !== capturedId) return;
      this._renderPreviewError(err);
      return;
    }
    if (this._closed || this.selectedSnapshotId !== capturedId) return;

    this.previewColEl.empty();
    this.previewColEl.createEl('h3', { text: S.FILE_VERSIONS_COL_PREVIEW });
    this.previewColEl.createEl('p', {
      text: fvFormatTimestamp(new Date(entry.created_at)),
      cls: 'archivist-fv-preview-timestamp',
      attr: { role: 'status', 'aria-live': 'polite' },
    });

    // Unload the previous renderChild before adding a new one. previewColEl.
    // empty() above clears the DOM but does not detach Component children
    // from the view; without this unload, every selection click leaks a
    // MarkdownRenderChild for the lifetime of the view.
    this._unloadActiveRenderChild();
    const previewContent = this.previewColEl.createDiv({ cls: 'archivist-preview-content' });
    const renderChild = new MarkdownRenderChild(previewContent);
    this.addChild(renderChild);
    this._activeRenderChild = renderChild;
    try {
      await renderPreview(
        this.app,
        previewContent as unknown as PreviewContainerEl,
        bytes,
        entry.path,
        renderChild,
      );
    } catch (err) {
      if (this._closed || this.selectedSnapshotId !== capturedId) {
        this._unloadActiveRenderChild();
        return;
      }
      this._unloadActiveRenderChild();
      this._renderPreviewError(err);
      return;
    }
    if (this._closed || this.selectedSnapshotId !== capturedId) {
      this._unloadActiveRenderChild();
      return;
    }

    this._renderPreviewActions(entry);
  }

  private _unloadActiveRenderChild(): void {
    if (this._activeRenderChild) {
      this._activeRenderChild.unload();
      this._activeRenderChild = null;
    }
  }

  private _renderPreviewActions(entry: VersionEntry): void {
    const actions = this.previewColEl.createDiv({ cls: 'archivist-fv-preview-actions' });
    const targetPath = entry.currentPath;
    const targetBasename = basename(targetPath);
    const ts = fvFormatTimestamp(new Date(entry.created_at));
    const inPlaceBtn = actions.createEl('button', { text: S.BROWSER_RESTORE_IN_PLACE });
    inPlaceBtn.setAttribute(
      'aria-label',
      `Restore ${targetBasename} in place from snapshot ${ts}`,
    );
    const asCopyBtn = actions.createEl('button', { text: S.BROWSER_RESTORE_TO_LOCATION });
    asCopyBtn.setAttribute(
      'aria-label',
      `Restore ${targetBasename} to a new location from snapshot ${ts}`,
    );

    inPlaceBtn.addEventListener('click', () => {
      const missingDirs = computeMissingDirs(targetPath, this.deps.vaultHasPath);
      new ConfirmRestoreModal(this.app, {
        filePath: targetPath,
        timestamp: ts,
        size: formatBytes(entry.size),
        missingDirs,
        onConfirm: () => {
          void this.deps.restoreOperations
            .restoreInPlace(targetPath, entry.snapshot_id)
            .then(() => this.deps.notify?.(S.TOAST_RESTORE_DONE))
            .catch((err: unknown) => {
              this.deps.notify?.(mapRestoreErrorToToast(err));
            });
        },
        onCancel: () => {},
      }).open();
    });

    asCopyBtn.addEventListener('click', () => {
      // Symmetric with in-place: confirm before any write so a misclick
      // (or an AT-tab-and-Enter) cannot create a sibling file silently.
      // The body explains that this branch creates a copy, not an
      // overwrite, which is materially different from the in-place
      // confirm — pass via customBody so the modal title stays neutral.
      new ConfirmRestoreModal(this.app, {
        filePath: targetPath,
        timestamp: ts,
        size: formatBytes(entry.size),
        missingDirs: [],
        customBody: `A copy of "${targetPath}" from ${ts} will be created next to the live file. The live file is not modified.`,
        onConfirm: () => {
          void this.deps.restoreOperations
            .restoreAsCopy(targetPath, entry.snapshot_id)
            .then(() => this.deps.notify?.(S.TOAST_RESTORE_DONE))
            .catch((err: unknown) => {
              this.deps.notify?.(mapRestoreErrorToToast(err));
            });
        },
        onCancel: () => {},
      }).open();
    });
  }

  private _renderPreviewEmpty(): void {
    this.previewColEl.empty();
    this.previewColEl.createEl('h3', { text: S.FILE_VERSIONS_COL_PREVIEW });
    this.previewColEl.createEl('p', {
      text: S.FILE_VERSIONS_NO_SELECTION,
      cls: 'archivist-loading',
    });
  }

  private _renderPreviewError(err: unknown): void {
    this.previewColEl.empty();
    if (err instanceof ChainError && err.code === 'CHAIN_BROKEN') {
      this.previewColEl.createEl('p', {
        text: S.BROWSER_ERROR_CHAIN_BROKEN,
        cls: 'archivist-error',
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    this.previewColEl.createEl('p', { text: msg, cls: 'archivist-error' });
  }

  private _renderSnapshotsError(err: unknown): void {
    this.snapshotsListEl.empty();
    if (err instanceof ChainError && err.code === 'CHAIN_BROKEN') {
      this.snapshotsListEl.createEl('p', {
        text: S.BROWSER_ERROR_CHAIN_BROKEN,
        cls: 'archivist-error',
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    this.snapshotsListEl.createEl('p', { text: msg, cls: 'archivist-error' });
  }
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}
