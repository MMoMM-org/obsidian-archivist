// BackupBrowserView — ItemView implementing the 3-column Backup Browser (T9.1).
//
// Layout: [Snapshots column] | [Files column] | [Preview + Restore column]
//
// Design principles:
//   - All DOM operations via createEl — no innerHTML (CON-7, ADR-13).
//   - Pure render functions (renderSnapshotsColumn, renderFilesColumn,
//     renderPreviewColumn, groupSnapshotsByDate, buildFileTree) are exported
//     so tests can exercise them without an Obsidian runtime.
//   - DI via BackupBrowserDeps: RestoreService, ManifestCache, RestoreOperations,
//     NoticeCenter, advisory, and vault-presence check are all injectable.
//   - Error isolation: CHAIN_BROKEN from materializeVaultStateAt is caught and
//     rendered inline; the view does not crash or leave a broken DOM.
//   - Keyboard nav: column wrappers have tabindex="0"; row items use
//     tabindex="-1" with aria-selected so AT can track selection.

import { ItemView, type WorkspaceLeaf, type App } from 'obsidian';
import type { SnapshotIndexEntry } from '../model/SnapshotIndex';
import type { FileEntry } from '../model/Manifest';
import { ChainError } from '../model/Errors';
import { renderPreview, maybeShowPreviewAdvisory } from './PreviewPane';
import type { PreviewAdvisoryNoticeCenter, AppWithPluginRegistry } from './PreviewPane';
import { S } from './strings';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ManifestCacheSubset {
  listSnapshotsNewestFirst(): Promise<SnapshotIndexEntry[]>;
}

export interface RestoreServiceSubset {
  materializeVaultStateAt(snapshotId: string): Promise<Record<string, FileEntry>>;
  fetchContent(snapshotId: string, path: string): Promise<Uint8Array>;
}

export interface RestoreOperationsSubset {
  restoreInPlace(path: string, snapshotId: string): Promise<unknown>;
  restoreAsCopy(path: string, snapshotId: string): Promise<unknown>;
}

export interface NoticeCenterSubset extends PreviewAdvisoryNoticeCenter {
  onBannersChange(cb: () => void): () => void;
}

export interface BackupBrowserDeps {
  restoreService: RestoreServiceSubset;
  manifestCache: ManifestCacheSubset;
  restoreOperations: RestoreOperationsSubset;
  noticeCenter: NoticeCenterSubset;
  advisory: {
    isDismissed: () => boolean;
    saveDismissed: () => Promise<void>;
  };
  /** Returns true when the given vault-relative path exists in the live vault. */
  vaultHasPath: (path: string) => boolean;
  /** Inject app for tests (ItemView sets this.app from the leaf in production). */
  app?: App;
  /** Injectable clock for date grouping tests. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// FileTreeNode — result of buildFileTree
// ---------------------------------------------------------------------------

export interface FileTreeNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  children: FileTreeNode[];
}

// ---------------------------------------------------------------------------
// groupSnapshotsByDate — pure, exported for tests
// ---------------------------------------------------------------------------

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Group a flat list of snapshots into date buckets.
 * Returns a Map keyed by group label (S.BROWSER_GROUP_*), in display order.
 * Snapshots within each group are in the order they appear in `snapshots`.
 */
export function groupSnapshotsByDate(
  snapshots: SnapshotIndexEntry[],
  now: Date,
): Map<string, SnapshotIndexEntry[]> {
  const result = new Map<string, SnapshotIndexEntry[]>();

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const yesterdayStart = new Date(todayStart.getTime() - ONE_DAY_MS);
  const weekStart = new Date(todayStart.getTime() - 6 * ONE_DAY_MS);
  const monthStart = new Date(todayStart.getTime() - 29 * ONE_DAY_MS);

  for (const snap of snapshots) {
    const snapDate = new Date(snap.created_at);
    const group = classifySnapshotDate(snapDate, todayStart, yesterdayStart, weekStart, monthStart);
    if (!result.has(group)) result.set(group, []);
    result.get(group)!.push(snap);
  }

  return result;
}

function classifySnapshotDate(
  snapDate: Date,
  todayStart: Date,
  yesterdayStart: Date,
  weekStart: Date,
  monthStart: Date,
): string {
  if (snapDate >= todayStart) return S.BROWSER_GROUP_TODAY;
  if (snapDate >= yesterdayStart) return S.BROWSER_GROUP_YESTERDAY;
  if (snapDate >= weekStart) return S.BROWSER_GROUP_THIS_WEEK;
  if (snapDate >= monthStart) return S.BROWSER_GROUP_THIS_MONTH;
  return S.BROWSER_GROUP_OLDER;
}

// ---------------------------------------------------------------------------
// buildFileTree — pure, exported for tests
// ---------------------------------------------------------------------------

/**
 * Convert a flat vault-state map (path → FileEntry) into a nested tree.
 * Folders sort before files at each level. Nodes use the original full path
 * for leaf nodes so callers can pass it to fetchContent.
 */
export function buildFileTree(state: Record<string, FileEntry>): FileTreeNode {
  const root: FileTreeNode = { name: '', fullPath: '', isDir: true, children: [] };

  for (const path of Object.keys(state)) {
    const parts = path.split('/');
    insertIntoTree(root, parts, path);
  }

  sortTree(root);
  return root;
}

function insertIntoTree(node: FileTreeNode, parts: string[], fullPath: string): void {
  if (parts.length === 1) {
    node.children.push({ name: parts[0], fullPath, isDir: false, children: [] });
    return;
  }
  const [head, ...tail] = parts;
  let dir = node.children.find((c) => c.name === head && c.isDir);
  if (!dir) {
    dir = { name: head, fullPath: '', isDir: true, children: [] };
    node.children.push(dir);
  }
  insertIntoTree(dir, tail, fullPath);
}

function sortTree(node: FileTreeNode): void {
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    if (child.isDir) sortTree(child);
  }
}

// ---------------------------------------------------------------------------
// renderSnapshotsColumn — pure render function
// ---------------------------------------------------------------------------

function renderSnapshotsColumn(
  container: HTMLElement,
  snapshots: SnapshotIndexEntry[],
  selectedId: string | null,
  onSelect: (snap: SnapshotIndexEntry) => void,
  now: Date,
): void {
  container.empty();

  if (snapshots.length === 0) {
    const emptyTitle = container.createEl('p', {
      cls: 'archivist-browser-empty-title',
    });
    emptyTitle.textContent = S.BROWSER_EMPTY_STATE_TITLE;
    return;
  }

  const groups = groupSnapshotsByDate(snapshots, now);

  for (const [groupLabel, groupSnaps] of groups.entries()) {
    container.createEl('h4', { text: groupLabel, cls: 'archivist-snapshot-group' });
    for (const snap of groupSnaps) {
      renderSnapshotRow(container, snap, selectedId, onSelect);
    }
  }
}

function renderSnapshotRow(
  container: HTMLElement,
  snap: SnapshotIndexEntry,
  selectedId: string | null,
  onSelect: (snap: SnapshotIndexEntry) => void,
): void {
  const row = container.createEl('div', { cls: 'archivist-snapshot-row' });
  row.setAttribute('tabindex', '-1');
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', snap.id === selectedId ? 'true' : 'false');

  const dateStr = new Date(snap.created_at).toLocaleString();
  row.createEl('span', { text: dateStr, cls: 'archivist-snapshot-date' });
  row.createEl('span', { text: snap.type, cls: 'archivist-snapshot-type' });

  row.addEventListener('click', () => onSelect(snap));
  row.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(snap);
    }
  });
}

// ---------------------------------------------------------------------------
// renderFilesColumn — pure render function
// ---------------------------------------------------------------------------

function renderFilesColumn(
  container: HTMLElement,
  tree: FileTreeNode,
  selectedPath: string | null,
  onSelect: (path: string) => void,
): void {
  container.empty();
  renderFileTreeNode(container, tree, selectedPath, onSelect);
}

function renderFileTreeNode(
  container: HTMLElement,
  node: FileTreeNode,
  selectedPath: string | null,
  onSelect: (path: string) => void,
): void {
  for (const child of node.children) {
    if (child.isDir) {
      const dirEl = container.createEl('div', { cls: 'archivist-file-dir' });
      dirEl.createEl('span', { text: child.name, cls: 'archivist-dir-name' });
      const childContainer = dirEl.createEl('div', { cls: 'archivist-dir-children' });
      renderFileTreeNode(childContainer, child, selectedPath, onSelect);
    } else {
      const fileEl = container.createEl('div', { cls: 'archivist-file-row' });
      fileEl.setAttribute('tabindex', '-1');
      fileEl.setAttribute('role', 'option');
      fileEl.setAttribute('aria-selected', child.fullPath === selectedPath ? 'true' : 'false');

      fileEl.createEl('span', { text: child.name, cls: 'archivist-file-name' });
      fileEl.addEventListener('click', () => onSelect(child.fullPath));
      fileEl.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(child.fullPath);
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// renderPreviewColumn — orchestrates PreviewPane + restore buttons
// ---------------------------------------------------------------------------

async function renderPreviewColumn(
  container: HTMLElement,
  app: App,
  component: BackupBrowserView,
  content: Uint8Array,
  path: string,
  _isDeleted: boolean,
  snapshotId: string,
  onRestoreInPlace: (path: string, snapshotId: string) => void,
  onRestoreAsCopy: (path: string, snapshotId: string) => void,
): Promise<void> {
  container.empty();

  const previewArea = container.createEl('div', { cls: 'archivist-preview-content' });
  await renderPreview(app, previewArea as unknown as Parameters<typeof renderPreview>[1], content, path, component);

  const actionsEl = container.createEl('div', { cls: 'archivist-preview-actions' });
  const inPlaceBtn = actionsEl.createEl('button', {
    text: S.BROWSER_RESTORE_IN_PLACE,
    cls: 'archivist-restore-in-place',
  });
  inPlaceBtn.addEventListener('click', () => onRestoreInPlace(path, snapshotId));

  const copyBtn = actionsEl.createEl('button', {
    text: S.BROWSER_RESTORE_TO_LOCATION,
    cls: 'archivist-restore-as-copy',
  });
  copyBtn.addEventListener('click', () => onRestoreAsCopy(path, snapshotId));
}

// ---------------------------------------------------------------------------
// BackupBrowserView — the ItemView
// ---------------------------------------------------------------------------

const VIEW_TYPE = 'archivist-backup-browser';

export class BackupBrowserView extends ItemView {
  private readonly deps: BackupBrowserDeps;

  // Columns
  private snapshotsListEl!: HTMLElement;
  private filesListEl!: HTMLElement;
  private previewColEl!: HTMLElement;

  // State
  private snapshots: SnapshotIndexEntry[] = [];
  private selectedSnapshot: SnapshotIndexEntry | null = null;
  private selectedPath: string | null = null;
  private fileState: Record<string, FileEntry> = {};

  // Cleanup hook for NoticeCenter subscription
  private unsubBanners: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, deps: BackupBrowserDeps) {
    super(leaf);
    this.deps = deps;
    // Allow tests to override app via deps
    if (deps.app) this.app = deps.app;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return S.BROWSER_TAB_TITLE;
  }

  getIcon(): string {
    return 'archive-restore';
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('archivist-browser');

    // Storage warning banner subscription (top slot)
    this.unsubBanners = this.deps.noticeCenter.onBannersChange(() => {
      // Banner updates handled externally (T9.5 wires to settings banner region)
    });

    // 3-column shell
    const columnsEl = contentEl.createEl('div', { cls: 'archivist-browser-columns' });

    // -- Snapshots column --
    const snapshotsColEl = columnsEl.createEl('div', { cls: 'archivist-snapshots' });
    snapshotsColEl.createEl('h3', { text: S.BROWSER_COL_SNAPSHOTS });
    this.snapshotsListEl = snapshotsColEl.createEl('div', {
      cls: 'archivist-snapshots-list',
      attr: { tabindex: '0', role: 'listbox' },
    });

    // -- Files column --
    const filesColEl = columnsEl.createEl('div', { cls: 'archivist-files' });
    filesColEl.createEl('h3', { text: S.BROWSER_COL_FILES });
    this.filesListEl = filesColEl.createEl('div', {
      cls: 'archivist-files-list',
      attr: { tabindex: '0', role: 'listbox' },
    });

    // -- Preview column --
    this.previewColEl = columnsEl.createEl('div', {
      cls: 'archivist-preview',
      attr: { tabindex: '0' },
    });
    this.previewColEl.createEl('h3', { text: S.BROWSER_COL_PREVIEW });

    // Show advisory for co-installed eval plugins (SEC-H3)
    maybeShowPreviewAdvisory(
      this.app as unknown as AppWithPluginRegistry,
      this.deps.noticeCenter,
      this.deps.advisory.isDismissed,
      this.deps.advisory.saveDismissed,
    );

    // Load snapshots (show loading state immediately)
    this.snapshotsListEl.createEl('p', { text: S.BROWSER_LOADING, cls: 'archivist-loading' });

    const snapshots = await this.deps.manifestCache.listSnapshotsNewestFirst();
    this.snapshots = snapshots;

    const now = this.deps.now ? this.deps.now() : new Date();
    renderSnapshotsColumn(
      this.snapshotsListEl,
      snapshots,
      this.selectedSnapshot?.id ?? null,
      (snap) => { void this._selectSnapshot(snap); },
      now,
    );
  }

  async onClose(): Promise<void> {
    this.unsubBanners?.();
    this.unsubBanners = null;
    this.contentEl.empty();
  }

  // ---------------------------------------------------------------------------
  // Selection handlers — exposed for tests as _select*
  // ---------------------------------------------------------------------------

  async _selectSnapshot(snap: SnapshotIndexEntry): Promise<void> {
    this.selectedSnapshot = snap;
    this.selectedPath = null;

    // Show loading in the files column while we materialize
    this.filesListEl.empty();
    this.filesListEl.createEl('p', { text: S.BROWSER_LOADING, cls: 'archivist-loading' });

    let state: Record<string, FileEntry>;
    try {
      state = await this.deps.restoreService.materializeVaultStateAt(snap.id);
    } catch (err) {
      this.filesListEl.empty();
      if (err instanceof ChainError && err.code === 'CHAIN_BROKEN') {
        this.filesListEl.createEl('p', {
          text: S.BROWSER_ERROR_CHAIN_BROKEN,
          cls: 'archivist-error',
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.filesListEl.createEl('p', { text: msg, cls: 'archivist-error' });
      }
      return;
    }

    this.fileState = state;
    const tree = buildFileTree(state);
    renderFilesColumn(
      this.filesListEl,
      tree,
      this.selectedPath,
      (path) => { void this._selectFile(path); },
    );
  }

  async _selectFile(path: string): Promise<void> {
    this.selectedPath = path;
    if (!this.selectedSnapshot) return;

    // Show loading in preview
    this.previewColEl.empty();
    this.previewColEl.createEl('h3', { text: S.BROWSER_COL_PREVIEW });
    this.previewColEl.createEl('p', { text: S.BROWSER_LOADING, cls: 'archivist-loading' });

    const content = await this.deps.restoreService.fetchContent(this.selectedSnapshot.id, path);
    const isDeleted = !this.deps.vaultHasPath(path);

    this.previewColEl.empty();
    this.previewColEl.createEl('h3', { text: S.BROWSER_COL_PREVIEW });

    await renderPreviewColumn(
      this.previewColEl,
      this.app,
      this,
      content,
      path,
      isDeleted,
      this.selectedSnapshot.id,
      (p, snapId) => { void this._triggerRestoreInPlaceFor(p, snapId); },
      (p, snapId) => { void this._triggerRestoreAsCopyFor(p, snapId); },
    );
  }

  async _triggerRestoreInPlace(): Promise<void> {
    if (!this.selectedPath || !this.selectedSnapshot) return;
    await this._triggerRestoreInPlaceFor(this.selectedPath, this.selectedSnapshot.id);
  }

  private async _triggerRestoreInPlaceFor(path: string, snapshotId: string): Promise<void> {
    await this.deps.restoreOperations.restoreInPlace(path, snapshotId);
  }

  private async _triggerRestoreAsCopyFor(path: string, snapshotId: string): Promise<void> {
    await this.deps.restoreOperations.restoreAsCopy(path, snapshotId);
  }
}
