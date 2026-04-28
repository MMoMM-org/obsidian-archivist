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

import { ItemView, prepareFuzzySearch, setIcon, type WorkspaceLeaf, type App } from 'obsidian';
import type { SnapshotIndexEntry, SnapshotTier } from '../model/SnapshotIndex';
import type { FileEntry } from '../model/Manifest';
import { ChainError } from '../model/Errors';
import { renderPreview, maybeShowPreviewAdvisory } from './PreviewPane';
import type { PreviewAdvisoryNoticeCenter, AppWithPluginRegistry } from './PreviewPane';
import type { PersistentBanner } from './NoticeCenter';
import { ConfirmRestoreModal } from './ConfirmRestoreModal';
import { computeMissingDirs, formatBytes } from './FileHistoryModal';
import { mapRestoreErrorToToast } from './restoreErrorToast';
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
  restoreDirectory(
    dirPrefix: string,
    snapshotId: string,
    mode: 'in_place' | 'as_copy',
  ): Promise<{ ok: number; failed: Array<{ path: string; error: string }> }>;
}

export interface NoticeCenterSubset extends PreviewAdvisoryNoticeCenter {
  onBannersChange(cb: () => void): () => void;
  /** Returns the current list of persistent banners (Fix 7 — storage-warning). */
  getPersistentBanners?(): PersistentBanner[];
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
  /** Toast / notice surface — used to report directory-restore results. */
  notify?: (message: string) => void;
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

/**
 * Group a flat list of snapshots into date buckets.
 * Returns a Map keyed by group label (S.BROWSER_GROUP_*), in display order.
 * Snapshots within each group are in the order they appear in `snapshots`.
 *
 * Date arithmetic uses setDate() so DST transitions (23h / 25h days) are
 * handled correctly (Fix 2 / ROB-001).
 */
export function groupSnapshotsByDate(
  snapshots: SnapshotIndexEntry[],
  now: Date,
): Map<string, SnapshotIndexEntry[]> {
  const result = new Map<string, SnapshotIndexEntry[]>();

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 6);
  const monthStart = new Date(todayStart);
  monthStart.setDate(monthStart.getDate() - 29);

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

/**
 * Format a snapshot's created_at for the Snapshots column row.
 *
 * Locale-aware date + 24-hour time, no AM/PM, second-precision dropped —
 * `Apr 25, 2026 14:34` (en-US) / `25. Apr. 2026, 14:34` (de-DE). The default
 * `Date.toLocaleString()` was producing the long en-US form with seconds and
 * AM/PM, which felt out of place next to the compact `[full]` / `[daily]` tags.
 */
function formatSnapshotDate(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

/**
 * Render the preview-column header for a selected file.
 *
 * Replaces the generic "Preview" h3 with the file's basename so the user
 * has a clear anchor for what they're looking at, plus the full
 * vault-relative path as a muted subtitle (helps disambiguate when two
 * files share a basename in different folders).
 */
function renderPreviewHeader(container: HTMLElement, path: string): void {
  const slash = path.lastIndexOf('/');
  const basename = slash >= 0 ? path.slice(slash + 1) : path;
  container.createEl('h3', { text: basename, cls: 'archivist-preview-filename' });
  if (slash >= 0) {
    container.createEl('p', { text: path, cls: 'archivist-preview-path' });
  }
}

/** Map a retention tier to its display label, or null when tier is unknown. */
function snapTierLabel(tier: SnapshotTier | null | undefined): string | null {
  if (tier === 'daily') return S.BROWSER_TIER_DAILY;
  if (tier === 'monthly') return S.BROWSER_TIER_MONTHLY;
  if (tier === 'never_prune') return S.BROWSER_TIER_NEVER_PRUNE;
  return null;
}

// ---------------------------------------------------------------------------
// buildFileTree — pure, exported for tests
// ---------------------------------------------------------------------------

/**
 * Convert a flat vault-state map (path → FileEntry) into a nested tree.
 * Folders sort before files at each level. Leaf nodes carry the original
 * vault path so callers can pass it to fetchContent. Directory nodes carry
 * their own joined prefix path (e.g. `notes/sub`) so callers can pass it to
 * `restoreDirectory`.
 */
export function buildFileTree(state: Record<string, FileEntry>): FileTreeNode {
  const root: FileTreeNode = { name: '', fullPath: '', isDir: true, children: [] };

  for (const path of Object.keys(state)) {
    // Normalize backslashes and collapse duplicate slashes before splitting
    // so Windows-style paths and double-slash artifacts are handled correctly.
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) continue;
    insertIntoTree(root, parts, path, []);
  }

  sortTree(root);
  return root;
}

function insertIntoTree(
  node: FileTreeNode,
  parts: string[],
  fullPath: string,
  ancestors: string[],
): void {
  if (parts.length === 1) {
    node.children.push({ name: parts[0], fullPath, isDir: false, children: [] });
    return;
  }
  const [head, ...tail] = parts;
  let dir = node.children.find((c) => c.name === head && c.isDir);
  if (!dir) {
    const dirAncestors = [...ancestors, head];
    dir = {
      name: head,
      fullPath: dirAncestors.join('/'),
      isDir: true,
      children: [],
    };
    node.children.push(dir);
  }
  insertIntoTree(dir, tail, fullPath, [...ancestors, head]);
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
// filterFileTree — pure, exported for tests
// ---------------------------------------------------------------------------

/**
 * Matcher fn — same shape as Obsidian's `prepareFuzzySearch(query)` return:
 * given a candidate string, returns a `{ score }` if it matches, else `null`.
 * Tests inject a substring matcher; production passes `prepareFuzzySearch(q)`.
 */
export type FileTreeMatcher = (text: string) => { score: number } | null;

/**
 * Prune `tree` to the subtree visible under `match`. Returns a new tree —
 * the input is not mutated.
 *
 * Semantics (mirrors how Marcus described the desired behaviour):
 *
 *   - File matches  → file is kept; its ancestor folders are kept so the
 *                     hierarchy stays visible (`/Atlas/Notes/Hizyx.md`).
 *   - Folder matches → ALL descendants of that folder are kept, even ones
 *                     whose own path doesn't match — so typing `900 Support`
 *                     surfaces the whole folder ready to browse + restore.
 *   - No match anywhere on a branch → branch is dropped.
 *
 * `match === null` means "no filter" — returns the original tree (not a
 * clone, since the caller treats it as read-only either way).
 */
export function filterFileTree(
  tree: FileTreeNode,
  match: FileTreeMatcher | null,
): FileTreeNode {
  if (match === null) return tree;
  const root: FileTreeNode = { name: '', fullPath: '', isDir: true, children: [] };
  for (const child of tree.children) {
    const kept = pruneNode(child, match);
    if (kept) root.children.push(kept);
  }
  return root;
}

function pruneNode(node: FileTreeNode, match: FileTreeMatcher): FileTreeNode | null {
  if (!node.isDir) {
    return match(node.fullPath) ? cloneNode(node) : null;
  }
  // Folder: a self-match keeps the entire subtree intact so the user can
  // browse + bulk-restore the folder they just searched for. Without this
  // short-circuit, a folder match would only keep child files that ALSO
  // happen to match — which surprises the user expecting a folder view.
  if (match(node.fullPath)) {
    return cloneNode(node);
  }
  const children: FileTreeNode[] = [];
  for (const child of node.children) {
    const kept = pruneNode(child, match);
    if (kept) children.push(kept);
  }
  if (children.length === 0) return null;
  return { name: node.name, fullPath: node.fullPath, isDir: true, children };
}

function cloneNode(node: FileTreeNode): FileTreeNode {
  return {
    name: node.name,
    fullPath: node.fullPath,
    isDir: node.isDir,
    children: node.children.map(cloneNode),
  };
}

// ---------------------------------------------------------------------------
// renderSnapshotsColumn — pure render function
// ---------------------------------------------------------------------------

// Empty-state body placeholder — shown while scheduler is not yet wired.
const EMPTY_STATE_WHEN_PLACEHOLDER = 'when backups are configured';

function renderSnapshotsColumn(
  container: HTMLElement,
  snapshots: SnapshotIndexEntry[],
  selectedId: string | null,
  onSelect: (snap: SnapshotIndexEntry) => void,
  now: Date,
): void {
  container.empty();

  if (snapshots.length === 0) {
    // Fix 6: render both empty-state title AND body (SPEC).
    container.createEl('p', {
      text: S.BROWSER_EMPTY_STATE_TITLE,
      cls: 'archivist-browser-empty-title',
    });
    container.createEl('p', {
      text: S.BROWSER_EMPTY_STATE_BODY(EMPTY_STATE_WHEN_PLACEHOLDER),
      cls: 'archivist-browser-empty-body',
    });
    return;
  }

  const groups = groupSnapshotsByDate(snapshots, now);
  const allRows: HTMLElement[] = [];

  for (const [groupLabel, groupSnaps] of groups.entries()) {
    container.createEl('h4', { text: groupLabel, cls: 'archivist-snapshot-group' });
    for (const snap of groupSnaps) {
      const row = renderSnapshotRow(container, snap, selectedId, onSelect);
      allRows.push(row);
    }
  }

  // Fix 5: wire ArrowUp/ArrowDown navigation across all rows in the column.
  wireArrowNav(allRows, (row, snap) => {
    onSelect(snap);
    row.focus();
  }, snapshots);
}

function renderSnapshotRow(
  container: HTMLElement,
  snap: SnapshotIndexEntry,
  selectedId: string | null,
  onSelect: (snap: SnapshotIndexEntry) => void,
): HTMLElement {
  const row = container.createDiv({ cls: 'archivist-snapshot-row' });
  row.setAttribute('tabindex', '-1');
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', snap.id === selectedId ? 'true' : 'false');

  const dateStr = formatSnapshotDate(new Date(snap.created_at));
  row.createSpan({ text: dateStr, cls: 'archivist-snapshot-date' });
  // Type tag wraps in brackets for visual symmetry with the tier tag and to
  // keep a clean separation from the date — `[full]` / `[inc]` instead of a
  // bare `full` running into the date with no whitespace between spans.
  row.createSpan({ text: `[${snap.type}]`, cls: 'archivist-snapshot-type' });
  const tierLabel = snapTierLabel(snap.tier);
  if (tierLabel) {
    row.createSpan({ text: tierLabel, cls: 'archivist-snapshot-tier' });
  }

  row.addEventListener('click', () => onSelect(snap));
  row.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(snap);
    }
  });
  return row;
}

/**
 * Wire ArrowUp/ArrowDown keydown handlers on a list of row elements.
 * ArrowDown moves to the next row; ArrowUp moves to the previous row.
 * The first/last row is a no-op in the respective direction (no wrap).
 * Selection follows focus — onActivate is called for the target row.
 */
function wireArrowNav<T>(
  rows: HTMLElement[],
  onActivate: (row: HTMLElement, item: T) => void,
  items: T[],
): void {
  rows.forEach((row, i) => {
    row.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (i + 1 < rows.length) {
          onActivate(rows[i + 1], items[i + 1]);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (i > 0) {
          onActivate(rows[i - 1], items[i - 1]);
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// renderFilesColumn — pure render function
// ---------------------------------------------------------------------------

interface FilesColumnHandlers {
  onSelectFile: (path: string) => void;
  onSelectDir: (prefix: string) => void;
}

/** Discriminated entry tracking a row's logical kind for arrow-key nav. */
type NavEntry =
  | { kind: 'file'; path: string }
  | { kind: 'dir'; prefix: string };

function renderFilesColumn(
  container: HTMLElement,
  tree: FileTreeNode,
  selectedPath: string | null,
  selectedDir: string | null,
  handlers: FilesColumnHandlers,
): void {
  container.empty();
  // Single ordered list of focusable rows + the entry that each represents.
  // Mixing dir headers and file rows in one nav list lets keyboard users
  // reach folders too — wireArrowNav previously skipped dir headers
  // because only file rows were collected.
  const navRows: HTMLElement[] = [];
  const navEntries: NavEntry[] = [];
  renderFileTreeNode(container, tree, selectedPath, selectedDir, handlers, navRows, navEntries);

  wireArrowNav(navRows, (row, entry) => {
    if (entry.kind === 'file') handlers.onSelectFile(entry.path);
    else handlers.onSelectDir(entry.prefix);
    row.focus();
  }, navEntries);
}

function renderFileTreeNode(
  container: HTMLElement,
  node: FileTreeNode,
  selectedPath: string | null,
  selectedDir: string | null,
  handlers: FilesColumnHandlers,
  navRows: HTMLElement[],
  navEntries: NavEntry[],
): void {
  for (const child of node.children) {
    if (child.isDir) {
      const dirEl = container.createDiv({ cls: 'archivist-file-dir' });
      const dirHeader = dirEl.createDiv({ cls: 'archivist-dir-header' });
      dirHeader.setAttribute('tabindex', '-1');
      dirHeader.setAttribute('role', 'option');
      dirHeader.setAttribute(
        'aria-selected',
        child.fullPath === selectedDir ? 'true' : 'false',
      );
      // Lucide folder icon — visual cue separating directories from files
      // without relying on extension-text-only inspection.
      const dirIconEl = dirHeader.createSpan({ cls: 'archivist-dir-icon' });
      setIcon(dirIconEl, 'folder');
      dirHeader.createSpan({ text: child.name, cls: 'archivist-dir-name' });
      // Click on the header itself selects the directory; clicks on the
      // children container fall through to file rows below.
      dirHeader.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.onSelectDir(child.fullPath);
      });
      dirHeader.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handlers.onSelectDir(child.fullPath);
          // Focus the row so the user has visual + AT feedback that the
          // activation took. Symmetric with wireArrowNav's onActivate.
          dirHeader.focus();
        }
      });
      navRows.push(dirHeader);
      navEntries.push({ kind: 'dir', prefix: child.fullPath });
      const childContainer = dirEl.createDiv({ cls: 'archivist-dir-children' });
      renderFileTreeNode(
        childContainer,
        child,
        selectedPath,
        selectedDir,
        handlers,
        navRows,
        navEntries,
      );
    } else {
      const fileEl = container.createDiv({ cls: 'archivist-file-row' });
      fileEl.setAttribute('tabindex', '-1');
      fileEl.setAttribute('role', 'option');
      fileEl.setAttribute('aria-selected', child.fullPath === selectedPath ? 'true' : 'false');

      // Lucide file icon — same intent as the folder icon: signal to the
      // user that THIS row represents a file (clickable for preview), not
      // a directory header.
      const fileIconEl = fileEl.createSpan({ cls: 'archivist-file-icon' });
      setIcon(fileIconEl, 'file-text');
      fileEl.createSpan({ text: child.name, cls: 'archivist-file-name' });
      fileEl.addEventListener('click', () => handlers.onSelectFile(child.fullPath));
      fileEl.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handlers.onSelectFile(child.fullPath);
        }
      });
      navRows.push(fileEl);
      navEntries.push({ kind: 'file', path: child.fullPath });
    }
  }
}

// ---------------------------------------------------------------------------
// Directory preview helpers — pure, exported for tests
// ---------------------------------------------------------------------------

/**
 * Collect every vault path under a directory prefix from a flat snapshot
 * state map. Mirrors the filter used by `RestoreOperations.restoreDirectory`
 * so the count shown in the confirm dialog matches what will actually be
 * restored. Returns paths sorted alphabetically for stable display.
 */
export function collectDirMatches(
  state: Record<string, FileEntry>,
  rawPrefix: string,
): string[] {
  const normalized = rawPrefix.replace(/\/+$/, '');
  if (normalized === '') return [];
  const prefixWithSlash = normalized + '/';
  return Object.keys(state)
    .filter((p) => p === normalized || p.startsWith(prefixWithSlash))
    .sort();
}

/**
 * Render the preview-column header for a selected directory: name + file
 * count tag. Mirrors `renderPreviewHeader` shape so the header strip looks
 * consistent between file- and dir-selection.
 */
function renderDirPreviewHeader(
  container: HTMLElement,
  prefix: string,
  fileCount: number,
): void {
  const slash = prefix.lastIndexOf('/');
  const basename = slash >= 0 ? prefix.slice(slash + 1) : prefix;
  container.createEl('h3', {
    text: `${basename} — ${S.BROWSER_DIR_FILE_COUNT(fileCount)}`,
    cls: 'archivist-preview-filename',
  });
  if (slash >= 0) {
    container.createEl('p', { text: prefix, cls: 'archivist-preview-path' });
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
  isDeleted: boolean,
  snapshotId: string,
  onRestoreInPlace: (path: string, snapshotId: string) => void,
  onRestoreAsCopy: (path: string, snapshotId: string) => void,
): Promise<void> {
  // The caller (_selectFile) is responsible for clearing the column and
  // rendering its filename / path header BEFORE invoking this function.
  // We must NOT empty() here — that's what wiped the just-rendered header
  // the moment the await fetch resolved (`d210195` symptom: filename
  // briefly visible, gone once content loaded).

  // Fix 8: show a "deleted" marker in the preview header when the file is
  // absent from the live vault (SPEC minor). Restore actions remain enabled.
  if (isDeleted) {
    container.createEl('p', {
      text: '[deleted in live vault]',
      cls: 'archivist-preview-deleted-marker',
    });
  }

  const previewArea = container.createDiv({ cls: 'archivist-preview-content' });
  await renderPreview(app, previewArea as unknown as Parameters<typeof renderPreview>[1], content, path, component);

  const slash = path.lastIndexOf('/');
  const basename = slash >= 0 ? path.slice(slash + 1) : path;
  const actionsEl = container.createDiv({ cls: 'archivist-preview-actions' });
  const inPlaceBtn = actionsEl.createEl('button', {
    text: S.BROWSER_RESTORE_IN_PLACE,
    cls: 'archivist-restore-in-place',
  });
  inPlaceBtn.setAttribute('aria-label', `Restore ${basename} in place`);
  inPlaceBtn.addEventListener('click', () => onRestoreInPlace(path, snapshotId));

  const copyBtn = actionsEl.createEl('button', {
    text: S.BROWSER_RESTORE_TO_LOCATION,
    cls: 'archivist-restore-as-copy',
  });
  copyBtn.setAttribute('aria-label', `Restore ${basename} to a new location`);
  copyBtn.addEventListener('click', () => onRestoreAsCopy(path, snapshotId));
}

// ---------------------------------------------------------------------------
// BackupBrowserView — the ItemView
// ---------------------------------------------------------------------------

/**
 * View-type constant. **Frozen** — Obsidian persists this string in
 * `workspace.json` the first time a user opens the view; renaming it will
 * silently drop the saved leaf on next load. Any rename requires an
 * `onload` migration that converts stale leaf states.
 */
export const BACKUP_BROWSER_VIEW_TYPE = 'archivist-backup-browser';

export class BackupBrowserView extends ItemView {
  private readonly deps: BackupBrowserDeps;

  // Columns
  private snapshotsListEl!: HTMLElement;
  private filesListEl!: HTMLElement;
  private filesColHeaderEl!: HTMLElement;
  private previewColEl!: HTMLElement;

  // Banner region (Fix 7 — storage-warning banner rendering)
  private bannerRegionEl!: HTMLElement;

  // State
  private snapshots: SnapshotIndexEntry[] = [];
  private selectedSnapshot: SnapshotIndexEntry | null = null;
  private selectedPath: string | null = null;
  private selectedDir: string | null = null;
  private fileState: Record<string, FileEntry> = {};
  // Files-column search state. Persists across snapshot changes — searching
  // for the same file across snapshots is the obvious use case, and clearing
  // the query on every snapshot click would frustrate that workflow.
  private searchQuery: string = '';
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Fix 3: closed flag — continuations bail if view was closed during an await.
  private _closed = false;
  // Gates the dir-restore confirm flow client-side so a second click while
  // the loop is still running cannot launch a parallel batch.
  private _dirRestoreInFlight = false;

  // Cleanup hook for NoticeCenter subscription
  private unsubBanners: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, deps: BackupBrowserDeps) {
    super(leaf);
    this.deps = deps;
    // Allow tests to override app via deps
    if (deps.app) this.app = deps.app;
  }

  getViewType(): string {
    return BACKUP_BROWSER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return S.BROWSER_TAB_TITLE;
  }

  getIcon(): string {
    return 'archive-restore';
  }

  async onOpen(): Promise<void> {
    // Fix 3: reset closed flag so continuations from a previous open() do not
    // bleed into this fresh open cycle.
    this._closed = false;

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('archivist-browser');

    // Fix 7: banner region at the top of the content area.
    this.bannerRegionEl = contentEl.createDiv({ cls: 'archivist-browser-banners' });

    // Storage warning banner subscription — re-renders banner region on change.
    this.unsubBanners = this.deps.noticeCenter.onBannersChange(() => {
      this._renderBanners();
    });

    // 3-column shell
    const columnsEl = contentEl.createDiv({ cls: 'archivist-browser-columns' });

    // -- Snapshots column --
    const snapshotsColEl = columnsEl.createDiv({ cls: 'archivist-snapshots' });
    snapshotsColEl.createEl('h3', { text: S.BROWSER_COL_SNAPSHOTS });
    this.snapshotsListEl = snapshotsColEl.createDiv({
      cls: 'archivist-snapshots-list',
      attr: { tabindex: '0', role: 'listbox' },
    });

    // -- Files column --
    const filesColEl = columnsEl.createDiv({ cls: 'archivist-files' });
    this.filesColHeaderEl = filesColEl.createEl('h3', { text: S.BROWSER_COL_FILES });
    this._renderFilesSearchBar(filesColEl);
    this.filesListEl = filesColEl.createDiv({
      cls: 'archivist-files-list',
      attr: { tabindex: '0', role: 'listbox' },
    });

    // -- Preview column --
    this.previewColEl = columnsEl.createDiv({
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
    // Fix 3: signal all in-flight continuations to bail out.
    this._closed = true;
    this.unsubBanners?.();
    this.unsubBanners = null;
    if (this.searchDebounceTimer !== null) {
      activeWindow.clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    this.contentEl.empty();
  }

  // Fix 7: re-render the banner region from the current persistent banners.
  private _renderBanners(): void {
    if (this._closed || !this.bannerRegionEl) return;
    this.bannerRegionEl.empty();
    const banners = this.deps.noticeCenter.getPersistentBanners?.() ?? [];
    for (const banner of banners) {
      const bannerEl = this.bannerRegionEl.createDiv({
        cls: 'archivist-banner',
      });
      bannerEl.createSpan({ text: banner.message, cls: 'archivist-banner-message' });
      if (banner.onDismiss) {
        const dismissBtn = bannerEl.createEl('button', {
          text: banner.dismissLabel ?? '×',
          cls: 'archivist-banner-dismiss',
        });
        dismissBtn.addEventListener('click', () => {
          void banner.onDismiss?.();
          this._renderBanners();
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Selection handlers — exposed for tests as _select*
  // ---------------------------------------------------------------------------

  async _selectSnapshot(snap: SnapshotIndexEntry): Promise<void> {
    // Fix 1: capture target snapshot BEFORE the first await.
    // If the user clicks another snapshot before materializeVaultStateAt
    // resolves, this.selectedSnapshot will have moved on — bail out.
    const capturedSnap = snap;
    this.selectedSnapshot = snap;
    this.selectedPath = null;
    this.selectedDir = null;

    // Re-render the snapshots column so aria-selected (and the highlighted
    // row styling that hangs off it) reflects the new selection. Without
    // this, the previously-rendered rows keep their stale aria-selected
    // attribute and only an internal field on the view changed.
    if (this.snapshots) {
      const now = this.deps.now ? this.deps.now() : new Date();
      renderSnapshotsColumn(
        this.snapshotsListEl,
        this.snapshots,
        snap.id,
        (s) => { void this._selectSnapshot(s); },
        now,
      );
    }

    // Files column header reflects which snapshot's vault state we're
    // showing. "Files at snapshot" was generic; "Files at YYYY-MM-DD HH:MM"
    // ties the user's mental model to the snapshot they just clicked.
    if (this.filesColHeaderEl) {
      this.filesColHeaderEl.setText(
        `Files at ${formatSnapshotDate(new Date(snap.created_at))}`,
      );
    }

    // Show loading in the files column while we materialize
    this.filesListEl.empty();
    this.filesListEl.createEl('p', { text: S.BROWSER_LOADING, cls: 'archivist-loading' });

    let state: Record<string, FileEntry>;
    try {
      state = await this.deps.restoreService.materializeVaultStateAt(snap.id);
    } catch (err) {
      // Fix 1: selection may have changed during the await — bail.
      if (this._closed || this.selectedSnapshot !== capturedSnap) return;
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

    // Fix 1 + Fix 3: bail if superseded or closed.
    if (this._closed || this.selectedSnapshot !== capturedSnap) return;

    this.fileState = state;
    const tree = buildFileTree(state);
    this._renderFilesColumn(tree);
  }

  private _renderFilesColumn(tree: FileTreeNode): void {
    const query = this.searchQuery.trim();
    if (query === '') {
      renderFilesColumn(
        this.filesListEl,
        tree,
        this.selectedPath,
        this.selectedDir,
        {
          onSelectFile: (path) => { void this._selectFile(path); },
          onSelectDir: (prefix) => { void this._selectDir(prefix); },
        },
      );
      return;
    }

    // prepareFuzzySearch is documented as performance-sensitive past a few
    // thousand calls; with 6k+ files we are at the edge but the 150 ms
    // debounce keeps re-renders to one per typing pause.
    const fuzzy = prepareFuzzySearch(query);
    const matcher: FileTreeMatcher = (text) => fuzzy(text);
    const pruned = filterFileTree(tree, matcher);

    if (pruned.children.length === 0) {
      this.filesListEl.empty();
      this.filesListEl.createEl('p', {
        text: S.BROWSER_FILES_SEARCH_NO_MATCHES(query),
        cls: 'archivist-files-no-matches',
      });
      return;
    }

    renderFilesColumn(
      this.filesListEl,
      pruned,
      this.selectedPath,
      this.selectedDir,
      {
        onSelectFile: (path) => { void this._selectFile(path); },
        onSelectDir: (prefix) => { void this._selectDir(prefix); },
      },
    );
  }

  /**
   * Render the search input above the files list. Debounced 150 ms so that
   * pruning 6k nodes per keystroke stays out of the typing hot path.
   * Selection state is kept across query changes — a file selected before a
   * search is still selected after, even if it's not currently visible in
   * the pruned view, so clearing the query restores it.
   */
  private _renderFilesSearchBar(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: 'archivist-files-search' });
    const input = wrap.createEl('input', {
      attr: {
        type: 'search',
        placeholder: S.BROWSER_FILES_SEARCH_PLACEHOLDER,
        'aria-label': S.BROWSER_FILES_SEARCH_PLACEHOLDER,
      },
      cls: 'archivist-files-search-input',
    });
    input.value = this.searchQuery;
    input.addEventListener('input', () => {
      const next = input.value;
      if (this.searchDebounceTimer !== null) {
        activeWindow.clearTimeout(this.searchDebounceTimer);
      }
      this.searchDebounceTimer = activeWindow.setTimeout(() => {
        this.searchDebounceTimer = null;
        this._applySearchQuery(next);
      }, 150);
    });
  }

  /**
   * Set the active search query and re-render the files column.
   * Exposed via internal field so tests can drive it without simulating a
   * debounced input event.
   */
  private _applySearchQuery(query: string): void {
    if (this._closed) return;
    this.searchQuery = query;
    if (this.selectedSnapshot) {
      const tree = buildFileTree(this.fileState);
      this._renderFilesColumn(tree);
    }
  }

  async _selectDir(prefix: string): Promise<void> {
    this.selectedDir = prefix;
    this.selectedPath = null;
    const capturedSnap = this.selectedSnapshot;
    if (!capturedSnap) return;

    // Re-render the files column so the clicked dir-header picks up
    // aria-selected. Mirror of the file-row pattern in _selectFile.
    if (this.fileState) {
      const tree = buildFileTree(this.fileState);
      this._renderFilesColumn(tree);
    }

    // Compute the matching files from the already-materialized snapshot
    // state — no second materialize call needed; we have it in fileState.
    const matches = collectDirMatches(this.fileState, prefix);

    this.previewColEl.empty();
    renderDirPreviewHeader(this.previewColEl, prefix, matches.length);

    if (matches.length === 0) {
      this.previewColEl.createEl('p', {
        text: S.BROWSER_DIR_NO_FILES_AT_SNAPSHOT,
        cls: 'archivist-dir-empty',
      });
      this._renderDirActions(prefix, matches, capturedSnap.id, true);
      return;
    }

    const listEl = this.previewColEl.createDiv({ cls: 'archivist-dir-file-list' });
    for (const path of matches) {
      const entry = this.fileState[path];
      const row = listEl.createDiv({ cls: 'archivist-dir-file-row' });
      row.createSpan({ text: path, cls: 'archivist-dir-file-name' });
      row.createSpan({
        text: entry ? new Date(entry.mtime).toISOString() : '',
        cls: 'archivist-dir-file-meta',
      });
      row.createSpan({
        text: entry ? formatBytes(entry.size) : '',
        cls: 'archivist-dir-file-meta',
      });
    }

    this._renderDirActions(prefix, matches, capturedSnap.id, false);
  }

  private _renderDirActions(
    prefix: string,
    matches: string[],
    snapshotId: string,
    disabled: boolean,
  ): void {
    const actionsEl = this.previewColEl.createDiv({ cls: 'archivist-dir-actions' });
    const inPlaceBtn = actionsEl.createEl('button', {
      text: S.BROWSER_DIR_RESTORE_IN_PLACE,
    });
    inPlaceBtn.setAttribute(
      'aria-label',
      `Restore directory ${prefix} in place (${matches.length} files)`,
    );
    const asCopyBtn = actionsEl.createEl('button', {
      text: S.BROWSER_DIR_RESTORE_AS_COPY,
    });
    asCopyBtn.setAttribute(
      'aria-label',
      `Restore directory ${prefix} as side-by-side copies (${matches.length} files)`,
    );
    if (disabled) {
      inPlaceBtn.setAttribute('aria-disabled', 'true');
      inPlaceBtn.setAttribute('disabled', '');
      asCopyBtn.setAttribute('aria-disabled', 'true');
      asCopyBtn.setAttribute('disabled', '');
      return;
    }
    inPlaceBtn.addEventListener('click', () =>
      this._confirmDirectoryRestore(prefix, matches, snapshotId, 'in_place'),
    );
    asCopyBtn.addEventListener('click', () =>
      this._confirmDirectoryRestore(prefix, matches, snapshotId, 'as_copy'),
    );
  }

  private _confirmDirectoryRestore(
    prefix: string,
    matches: string[],
    snapshotId: string,
    mode: 'in_place' | 'as_copy',
  ): void {
    if (this._dirRestoreInFlight) return;

    // Union of missing parent directories across every file in the batch.
    // Only relevant for in-place; as-copy restores into the original
    // ancestors too, but mkdirParents handles that idempotently.
    const missingDirsSet = new Set<string>();
    for (const path of matches) {
      for (const dir of computeMissingDirs(path, this.deps.vaultHasPath)) {
        missingDirsSet.add(dir);
      }
    }
    const missingDirs = [...missingDirsSet].sort();

    const fileCount = S.BROWSER_DIR_FILE_COUNT(matches.length);
    const modeLabel =
      mode === 'in_place'
        ? S.CONFIRM_DIR_RESTORE_MODE_IN_PLACE
        : S.CONFIRM_DIR_RESTORE_MODE_AS_COPY;
    const timestamp = this.selectedSnapshot
      ? new Date(this.selectedSnapshot.created_at).toISOString()
      : snapshotId;
    const body = S.CONFIRM_DIR_RESTORE_BODY(prefix, timestamp, fileCount, modeLabel);

    new ConfirmRestoreModal(this.app, {
      filePath: prefix,
      timestamp,
      size: fileCount,
      missingDirs,
      customBody: body,
      onConfirm: () => {
        void this._runDirectoryRestore(prefix, snapshotId, mode);
      },
      onCancel: () => {},
    }).open();
  }

  private async _runDirectoryRestore(
    prefix: string,
    snapshotId: string,
    mode: 'in_place' | 'as_copy',
  ): Promise<void> {
    this._dirRestoreInFlight = true;
    // Disable the dir-action buttons in the Preview column for the
    // duration of the loop so a user who watches the toast/console can't
    // re-confirm the same restore mid-flight (the gate flag also catches
    // it but the buttons looked enabled, which was confusing).
    const buttons = this.previewColEl.querySelectorAll<HTMLButtonElement>(
      '.archivist-dir-actions button',
    );
    for (const btn of Array.from(buttons)) {
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('disabled', '');
    }
    try {
      const result = await this.deps.restoreOperations.restoreDirectory(
        prefix,
        snapshotId,
        mode,
      );
      const notify = this.deps.notify;
      if (result.failed.length === 0) {
        notify?.(S.TOAST_DIR_RESTORE_OK(result.ok));
      } else {
        notify?.(S.TOAST_DIR_RESTORE_PARTIAL(result.ok, result.failed.length));
        // Persistent banner: surface the first few failures so the user
        // can inspect them without re-triggering the operation. Mapped
        // through mapRestoreErrorToToast so paths/codes don't leak.
        const summary = result.failed
          .slice(0, 5)
          .map((f) => `${f.path}: ${f.error}`)
          .join('\n');
        this.deps.noticeCenter.showPersistent?.(
          'DIR_RESTORE_PARTIAL_FAILURE',
          summary,
          {},
        );
      }
    } catch (err) {
      this.deps.notify?.(mapRestoreErrorToToast(err));
    } finally {
      this._dirRestoreInFlight = false;
      for (const btn of Array.from(buttons)) {
        btn.removeAttribute('aria-disabled');
        btn.removeAttribute('disabled');
      }
    }
  }

  async _selectFile(path: string): Promise<void> {
    this.selectedPath = path;
    this.selectedDir = null;
    // Fix 1: capture snapshot BEFORE the first await.
    const capturedSnap = this.selectedSnapshot;
    if (!capturedSnap) return;

    // Re-render the files column so the clicked row picks up
    // aria-selected / the active-hover background. Same reason as in
    // _selectSnapshot: state lives on the view but the DOM only reflects
    // it at render time, so a fresh render is needed to surface the
    // selection visually.
    if (this.fileState) {
      const tree = buildFileTree(this.fileState);
      this._renderFilesColumn(tree);
    }

    // Show loading in preview — header swaps from generic "Preview" to the
    // file's basename so the user has a clear "this is what you're looking
    // at" anchor; the full vault-relative path appears as a muted subtitle.
    this.previewColEl.empty();
    renderPreviewHeader(this.previewColEl, path);
    this.previewColEl.createEl('p', { text: S.BROWSER_LOADING, cls: 'archivist-loading' });

    const content = await this.deps.restoreService.fetchContent(capturedSnap.id, path);

    // Fix 1 + Fix 3: bail if snapshot changed or view was closed during await.
    if (this._closed || this.selectedSnapshot !== capturedSnap) return;

    const isDeleted = !this.deps.vaultHasPath(path);

    this.previewColEl.empty();
    renderPreviewHeader(this.previewColEl, path);

    await renderPreviewColumn(
      this.previewColEl,
      this.app,
      this,
      content,
      path,
      isDeleted,
      capturedSnap.id,
      (p, snapId) => { void this.deps.restoreOperations.restoreInPlace(p, snapId); },
      (p, snapId) => { void this.deps.restoreOperations.restoreAsCopy(p, snapId); },
    );
  }
}
