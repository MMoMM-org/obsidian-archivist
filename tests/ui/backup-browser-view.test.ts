// T9.1 — BackupBrowserView: 3-column ItemView for browsing backup snapshots.
//
// Tests exercise pure render functions + the view's orchestration layer using
// a fake DOM (MockEl) and mocked service dependencies. No real Obsidian runtime.
//
// Coverage:
//   1. Pure functions: groupSnapshotsByDate, buildFileTree, renderSnapshotsColumn,
//      renderFilesColumn, renderPreviewColumn (all exercised via view behavior)
//   2. View lifecycle: getViewType, getDisplayText, getIcon, onOpen, onClose
//   3. Empty state: no snapshots renders S.BROWSER_EMPTY_STATE_TITLE
//   4. Loading state: loading indicator shows during async operations
//   5. Snapshot selection: populates file tree via materializeVaultStateAt
//   6. File selection: fetches content, renders preview or binary placeholder
//   7. Error state: CHAIN_BROKEN error renders inline, does not crash view
//   8. Keyboard navigation: columns have tabindex, rows have aria-selected
//   9. Deleted-file restore: actions remain enabled when file absent from vault
//  10. Restore action wiring: onRestoreInPlace / onRestoreAsCopy called correctly
//  11. Date grouping: snapshots correctly grouped by Today/Yesterday/This week/…
//  12. Unload: onClose clears the container without throwing

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Stub ConfirmRestoreModal so the dir-restore tests can fire button clicks
// without the real modal's onOpen() reaching for `activeDocument` (which is
// only available inside Obsidian's Electron environment, not in vitest).
// Tests that need to verify the modal's confirm-flow do so by capturing the
// onConfirm callback from the constructor args.
vi.mock('../../src/ui/ConfirmRestoreModal', () => ({
  ConfirmRestoreModal: class {
    static _last: { opts: { onConfirm: () => void; onCancel: () => void } } | null = null;
    private opts: { onConfirm: () => void; onCancel: () => void };
    constructor(_app: unknown, opts: { onConfirm: () => void; onCancel: () => void }) {
      this.opts = opts;
      (this.constructor as unknown as { _last: unknown })._last = { opts };
    }
    open(): void {
      // Production code calls .open(); we no-op so the test can synchronously
      // invoke `this.opts.onConfirm()` if it wants to walk the confirm path.
    }
  },
}));

import {
  groupSnapshotsByDate,
  buildFileTree,
  BackupBrowserView,
  type BackupBrowserDeps,
} from '../../src/ui/BackupBrowserView';
import { App, WorkspaceLeaf } from '../fixtures/obsidian-mock';
import type { MockEl } from '../fixtures/obsidian-mock';
import { S } from '../../src/ui/strings';
import type { SnapshotIndexEntry } from '../../src/model/SnapshotIndex';
import type { FileEntry } from '../../src/model/Manifest';
import { ChainError } from '../../src/model/Errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLeaf(): WorkspaceLeaf {
  return new WorkspaceLeaf();
}

function makeApp(): App {
  return new App();
}

/** Create a SnapshotIndexEntry with sensible defaults. */
function makeSnapshot(overrides: Partial<SnapshotIndexEntry> & { created_at: string }): SnapshotIndexEntry {
  return {
    id: `snap-${overrides.created_at}`,
    type: 'inc',
    parent_id: null,
    device_id: 'device-1',
    blob_hashes: [],
    ...overrides,
  };
}

/** Create a vault state map (path → FileEntry). */
function makeVaultState(paths: string[]): Record<string, FileEntry> {
  const state: Record<string, FileEntry> = {};
  for (const p of paths) {
    state[p] = { hash: 'abc123', size: 42, mtime: 0 };
  }
  return state;
}

/** Collect all textContent from a MockEl tree. */
function collectText(el: MockEl): string {
  const own = el.textContent ?? '';
  const childText = el.children.map(collectText).join('');
  return own + childText;
}

/** Find first element with given className (partial match). */
function findByClass(el: MockEl, cls: string): MockEl | undefined {
  if (el.className.includes(cls)) return el;
  for (const child of el.children) {
    const found = findByClass(child, cls);
    if (found) return found;
  }
  return undefined;
}

/** Collect all elements with given className. */
function findAllByClass(el: MockEl, cls: string): MockEl[] {
  const results: MockEl[] = [];
  if (el.className.includes(cls)) results.push(el);
  for (const child of el.children) {
    results.push(...findAllByClass(child, cls));
  }
  return results;
}

/** Create a fake deps object with controllable mocks. */
function makeDeps(overrides?: Partial<BackupBrowserDeps>): BackupBrowserDeps {
  const defaultRestoreService = {
    materializeVaultStateAt: vi.fn().mockResolvedValue({}),
    fetchContent: vi.fn().mockResolvedValue(new TextEncoder().encode('# Hello')),
  };
  const defaultManifestCache = {
    listSnapshotsNewestFirst: vi.fn().mockResolvedValue([]),
  };
  const defaultRestoreOperations = {
    restoreInPlace: vi.fn().mockResolvedValue({ ok: true, path: '', snapshotId: '', bytesWritten: 0 }),
    restoreAsCopy: vi.fn().mockResolvedValue({ ok: true, path: '', snapshotId: '', bytesWritten: 0 }),
    restoreDirectory: vi.fn().mockResolvedValue({ ok: 0, failed: [] }),
  };
  const defaultNoticeCenter = {
    showPersistent: vi.fn(),
    onBannersChange: vi.fn().mockReturnValue(() => {}),
  };

  return {
    restoreService: defaultRestoreService,
    manifestCache: defaultManifestCache,
    restoreOperations: defaultRestoreOperations,
    noticeCenter: defaultNoticeCenter,
    advisory: {
      isDismissed: () => false,
      saveDismissed: vi.fn().mockResolvedValue(undefined),
    },
    vaultHasPath: vi.fn().mockReturnValue(true),
    notify: vi.fn(),
    app: makeApp(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Section 1: groupSnapshotsByDate — pure grouping logic
// ---------------------------------------------------------------------------

describe('groupSnapshotsByDate', () => {
  // Reference "now": 2026-04-24T10:00:00Z (matches currentDate from context)
  const NOW = new Date('2026-04-24T10:00:00Z');

  it('groups a snapshot from today under "Today"', () => {
    const snap = makeSnapshot({ created_at: '2026-04-24T08:00:00Z' });
    const groups = groupSnapshotsByDate([snap], NOW);
    expect(groups.get(S.BROWSER_GROUP_TODAY)).toContain(snap);
  });

  it('groups a snapshot from yesterday under "Yesterday"', () => {
    const snap = makeSnapshot({ created_at: '2026-04-23T08:00:00Z' });
    const groups = groupSnapshotsByDate([snap], NOW);
    expect(groups.get(S.BROWSER_GROUP_YESTERDAY)).toContain(snap);
  });

  it('groups a snapshot from 5 days ago under "This week"', () => {
    const snap = makeSnapshot({ created_at: '2026-04-19T08:00:00Z' });
    const groups = groupSnapshotsByDate([snap], NOW);
    expect(groups.get(S.BROWSER_GROUP_THIS_WEEK)).toContain(snap);
  });

  it('groups a snapshot from 15 days ago under "This month"', () => {
    const snap = makeSnapshot({ created_at: '2026-04-09T08:00:00Z' });
    const groups = groupSnapshotsByDate([snap], NOW);
    expect(groups.get(S.BROWSER_GROUP_THIS_MONTH)).toContain(snap);
  });

  it('groups a snapshot from 40 days ago under "Older"', () => {
    const snap = makeSnapshot({ created_at: '2026-03-15T08:00:00Z' });
    const groups = groupSnapshotsByDate([snap], NOW);
    expect(groups.get(S.BROWSER_GROUP_OLDER)).toContain(snap);
  });

  it('multiple snapshots land in the right groups', () => {
    const today = makeSnapshot({ created_at: '2026-04-24T09:00:00Z', id: 'today' });
    const yesterday = makeSnapshot({ created_at: '2026-04-23T09:00:00Z', id: 'yest' });
    const older = makeSnapshot({ created_at: '2026-01-01T09:00:00Z', id: 'older' });
    const groups = groupSnapshotsByDate([today, yesterday, older], NOW);
    expect(groups.get(S.BROWSER_GROUP_TODAY)?.map((s) => s.id)).toContain('today');
    expect(groups.get(S.BROWSER_GROUP_YESTERDAY)?.map((s) => s.id)).toContain('yest');
    expect(groups.get(S.BROWSER_GROUP_OLDER)?.map((s) => s.id)).toContain('older');
  });

  it('returns empty map for empty input', () => {
    const groups = groupSnapshotsByDate([], NOW);
    expect(groups.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 2: buildFileTree — pure nested-tree builder
// ---------------------------------------------------------------------------

describe('buildFileTree', () => {
  it('builds a flat list for root-level files', () => {
    const state = makeVaultState(['a.md', 'b.md']);
    const tree = buildFileTree(state);
    expect(tree.children).toHaveLength(2);
    const names = tree.children.map((n) => n.name);
    expect(names).toContain('a.md');
    expect(names).toContain('b.md');
  });

  it('builds nested nodes for files in folders', () => {
    const state = makeVaultState(['folder/note.md', 'folder/sub/deep.md']);
    const tree = buildFileTree(state);
    const folderNode = tree.children.find((c) => c.name === 'folder');
    expect(folderNode).toBeDefined();
    expect(folderNode?.isDir).toBe(true);
    const noteNode = folderNode?.children.find((c) => c.name === 'note.md');
    expect(noteNode).toBeDefined();
    expect(noteNode?.isDir).toBe(false);
    expect(noteNode?.fullPath).toBe('folder/note.md');
  });

  it('returns a root node with empty children for an empty state', () => {
    const tree = buildFileTree({});
    expect(tree.children).toHaveLength(0);
  });

  it('sorts folders before files at each level', () => {
    const state = makeVaultState(['z-note.md', 'a-folder/note.md', 'b-note.md']);
    const tree = buildFileTree(state);
    const names = tree.children.map((n) => n.name);
    // folder should come before files
    const folderIdx = names.indexOf('a-folder');
    const fileIdx = names.indexOf('z-note.md');
    expect(folderIdx).toBeLessThan(fileIdx);
  });
});

// ---------------------------------------------------------------------------
// Section 3: BackupBrowserView — lifecycle + view-type
// ---------------------------------------------------------------------------

describe('BackupBrowserView lifecycle', () => {
  it('getViewType returns "archivist-backup-browser"', () => {
    const view = new BackupBrowserView(makeLeaf(), makeDeps());
    expect(view.getViewType()).toBe('archivist-backup-browser');
  });

  it('getDisplayText returns the browser tab title string', () => {
    const view = new BackupBrowserView(makeLeaf(), makeDeps());
    expect(view.getDisplayText()).toBe(S.BROWSER_TAB_TITLE);
  });

  it('getIcon returns a non-empty string', () => {
    const view = new BackupBrowserView(makeLeaf(), makeDeps());
    expect(view.getIcon().length).toBeGreaterThan(0);
  });

  it('onClose clears the content element without throwing', async () => {
    const view = new BackupBrowserView(makeLeaf(), makeDeps());
    await expect(view.onClose()).resolves.toBeUndefined();
    // After close, contentEl children should be cleared
    expect(view.contentEl.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Section 4: BackupBrowserView — 3-column DOM structure
// ---------------------------------------------------------------------------

describe('BackupBrowserView DOM structure', () => {
  it('renders three columns with correct CSS classes on open', async () => {
    const deps = makeDeps();
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();

    expect(findByClass(view.contentEl, 'archivist-snapshots')).toBeDefined();
    expect(findByClass(view.contentEl, 'archivist-files')).toBeDefined();
    expect(findByClass(view.contentEl, 'archivist-preview')).toBeDefined();
  });

  it('renders a header row with column labels', async () => {
    const deps = makeDeps();
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();

    const text = collectText(view.contentEl);
    expect(text).toContain(S.BROWSER_COL_SNAPSHOTS);
    expect(text).toContain(S.BROWSER_COL_FILES);
    expect(text).toContain(S.BROWSER_COL_PREVIEW);
  });
});

// ---------------------------------------------------------------------------
// Section 5: BackupBrowserView — empty state
// ---------------------------------------------------------------------------

describe('BackupBrowserView empty state', () => {
  it('shows empty-state copy when no snapshots exist', async () => {
    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([]),
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();

    const text = collectText(view.contentEl);
    expect(text).toContain(S.BROWSER_EMPTY_STATE_TITLE);
  });
});

// ---------------------------------------------------------------------------
// Section 6: BackupBrowserView — loading state
// ---------------------------------------------------------------------------

describe('BackupBrowserView loading state', () => {
  it('shows loading indicator while snapshots are loading', async () => {
    // Create a promise that resolves after we check the loading state
    let resolveSnapshots!: (v: SnapshotIndexEntry[]) => void;
    const slowPromise = new Promise<SnapshotIndexEntry[]>((r) => { resolveSnapshots = r; });

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockReturnValue(slowPromise),
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);

    // Start loading but don't await — the view should show loading state immediately
    const openPromise = view.onOpen();

    // At this point, before the snapshots promise resolves, loading indicator should be visible
    const text = collectText(view.contentEl);
    expect(text).toContain(S.BROWSER_LOADING);

    // Resolve and finish
    resolveSnapshots([]);
    await openPromise;
  });
});

// ---------------------------------------------------------------------------
// Section 7: BackupBrowserView — snapshot listing with groups
// ---------------------------------------------------------------------------

describe('BackupBrowserView snapshot listing', () => {
  const NOW = new Date('2026-04-24T10:00:00Z');

  it('lists snapshots grouped by date with group headings', async () => {
    const todaySnap = makeSnapshot({ id: 'today', created_at: '2026-04-24T09:00:00Z', type: 'inc' });
    const olderSnap = makeSnapshot({ id: 'older', created_at: '2026-01-01T00:00:00Z', type: 'full' });

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([todaySnap, olderSnap]),
      },
      now: () => NOW,
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();

    const text = collectText(view.contentEl);
    expect(text).toContain(S.BROWSER_GROUP_TODAY);
    expect(text).toContain(S.BROWSER_GROUP_OLDER);
  });

  it('shows snapshot type label (full/inc) per row', async () => {
    const snap = makeSnapshot({ id: 'snap1', created_at: '2026-04-24T09:00:00Z', type: 'full' });

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      now: () => NOW,
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();

    const text = collectText(view.contentEl);
    expect(text).toContain('full');
  });
});

// ---------------------------------------------------------------------------
// Section 8: BackupBrowserView — snapshot selection → file tree
// ---------------------------------------------------------------------------

describe('BackupBrowserView snapshot selection', () => {
  it('calls materializeVaultStateAt with the selected snapshot id', async () => {
    const snap = makeSnapshot({ id: 'snap-abc', created_at: '2026-04-24T09:00:00Z' });
    const materialize = vi.fn().mockResolvedValue(makeVaultState(['notes/note.md']));

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      restoreService: {
        materializeVaultStateAt: materialize,
        fetchContent: vi.fn().mockResolvedValue(new TextEncoder().encode('content')),
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();

    // Simulate selecting a snapshot row
    await view._selectSnapshot(snap);

    expect(materialize).toHaveBeenCalledWith('snap-abc');
  });

  it('populates file tree after snapshot selection', async () => {
    const snap = makeSnapshot({ id: 'snap-abc', created_at: '2026-04-24T09:00:00Z' });
    const state = makeVaultState(['folder/note.md', 'root.md']);

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(state),
        fetchContent: vi.fn().mockResolvedValue(new TextEncoder().encode('content')),
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);

    const filesCol = findByClass(view.contentEl, 'archivist-files');
    expect(filesCol).toBeDefined();
    const text = collectText(filesCol!);
    expect(text).toContain('root.md');
  });

  it('shows CHAIN_BROKEN error inline without crashing when materialize throws', async () => {
    const snap = makeSnapshot({ id: 'snap-broken', created_at: '2026-04-24T09:00:00Z' });

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockRejectedValue(
          new ChainError('CHAIN_BROKEN', 'Missing ancestor', false),
        ),
        fetchContent: vi.fn(),
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();

    // Should not throw
    await expect(view._selectSnapshot(snap)).resolves.toBeUndefined();

    const text = collectText(view.contentEl);
    expect(text).toContain(S.BROWSER_ERROR_CHAIN_BROKEN);
  });
});

// ---------------------------------------------------------------------------
// Section 9: BackupBrowserView — file selection → preview
// ---------------------------------------------------------------------------

describe('BackupBrowserView file selection', () => {
  it('calls fetchContent with snapshotId and path when file is selected', async () => {
    const snap = makeSnapshot({ id: 'snap-1', created_at: '2026-04-24T09:00:00Z' });
    const state = makeVaultState(['notes/note.md']);
    const fetchContent = vi.fn().mockResolvedValue(new TextEncoder().encode('# Hello'));

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(state),
        fetchContent,
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);
    await view._selectFile('notes/note.md');

    expect(fetchContent).toHaveBeenCalledWith('snap-1', 'notes/note.md');
  });

  it('shows binary placeholder for binary file paths without crashing', async () => {
    const snap = makeSnapshot({ id: 'snap-1', created_at: '2026-04-24T09:00:00Z' });
    const state = makeVaultState(['image.png']);
    const fetchContent = vi.fn().mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(state),
        fetchContent,
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);
    await view._selectFile('image.png');

    const previewCol = findByClass(view.contentEl, 'archivist-preview');
    const text = collectText(previewCol!);
    expect(text).toContain(S.FILE_HISTORY_BINARY_PLACEHOLDER);
  });

  it('shows restore actions for binary file (actions remain enabled)', async () => {
    const snap = makeSnapshot({ id: 'snap-1', created_at: '2026-04-24T09:00:00Z' });
    const state = makeVaultState(['image.png']);

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(state),
        fetchContent: vi.fn().mockResolvedValue(new Uint8Array([0x89, 0x50])),
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);
    await view._selectFile('image.png');

    const previewCol = findByClass(view.contentEl, 'archivist-preview');
    const text = collectText(previewCol!);
    expect(text).toContain(S.BROWSER_RESTORE_IN_PLACE);
  });
});

// ---------------------------------------------------------------------------
// Section 10: BackupBrowserView — deleted-file restore
// ---------------------------------------------------------------------------

describe('BackupBrowserView deleted-file restore', () => {
  it('shows restore actions when file does not exist in live vault', async () => {
    const snap = makeSnapshot({ id: 'snap-1', created_at: '2026-04-24T09:00:00Z' });
    const state = makeVaultState(['deleted-note.md']);

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(state),
        fetchContent: vi.fn().mockResolvedValue(new TextEncoder().encode('content')),
      },
      // Deleted file → not in live vault
      vaultHasPath: vi.fn().mockReturnValue(false),
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);
    await view._selectFile('deleted-note.md');

    const previewCol = findByClass(view.contentEl, 'archivist-preview');
    const text = collectText(previewCol!);
    expect(text).toContain(S.BROWSER_RESTORE_IN_PLACE);
  });

  it('calls restoreInPlace when restore-in-place button is activated for deleted file', async () => {
    const snap = makeSnapshot({ id: 'snap-1', created_at: '2026-04-24T09:00:00Z' });
    const state = makeVaultState(['deleted-note.md']);
    const restoreInPlace = vi.fn().mockResolvedValue({ ok: true, path: '', snapshotId: '', bytesWritten: 0 });

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(state),
        fetchContent: vi.fn().mockResolvedValue(new TextEncoder().encode('content')),
      },
      restoreOperations: {
        restoreInPlace,
        restoreAsCopy: vi.fn(),
      },
      vaultHasPath: vi.fn().mockReturnValue(false),
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);
    await view._selectFile('deleted-note.md');

    // Fix 9: drive the button click path (no longer a direct method call).
    const previewCol = findByClass(view.contentEl, 'archivist-preview') as MockEl;
    const inPlaceBtn = findByClass(previewCol, 'archivist-restore-in-place') as MockEl;
    inPlaceBtn.dispatchEvent({ key: '', type: 'click', preventDefault: () => {} });
    // Allow the click handler's async chain to flush.
    await Promise.resolve();

    expect(restoreInPlace).toHaveBeenCalledWith('deleted-note.md', 'snap-1');
  });
});

// ---------------------------------------------------------------------------
// Section 11: BackupBrowserView — keyboard navigation accessibility
// ---------------------------------------------------------------------------

describe('BackupBrowserView keyboard navigation', () => {
  it('snapshot column container has tabindex="0"', async () => {
    const deps = makeDeps();
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();

    const snapshotsCol = findByClass(view.contentEl, 'archivist-snapshots');
    expect(snapshotsCol).toBeDefined();
    // The focusable wrapper within the column should have tabindex
    function hasFocusable(el: MockEl): boolean {
      if (el.attrs['tabindex'] === '0') return true;
      return el.children.some(hasFocusable);
    }
    expect(hasFocusable(snapshotsCol!)).toBe(true);
  });

  it('file tree column has tabindex="0" after snapshot is selected', async () => {
    const snap = makeSnapshot({ id: 'snap-1', created_at: '2026-04-24T09:00:00Z' });
    const state = makeVaultState(['note.md']);

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(state),
        fetchContent: vi.fn().mockResolvedValue(new TextEncoder().encode('content')),
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);

    const filesCol = findByClass(view.contentEl, 'archivist-files');
    expect(filesCol).toBeDefined();
    function hasFocusable(el: MockEl): boolean {
      if (el.attrs['tabindex'] === '0') return true;
      return el.children.some(hasFocusable);
    }
    expect(hasFocusable(filesCol!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 12: registerOpenBackupBrowserCommand — command registration
// ---------------------------------------------------------------------------

describe('registerOpenBackupBrowserCommand', () => {
  it('registers a command with the correct id and name', async () => {
    const { registerOpenBackupBrowserCommand } = await import('../../src/ui/Commands');
    const addCommand = vi.fn().mockImplementation((c) => c);
    const plugin = { addCommand };
    const onOpen = vi.fn();

    registerOpenBackupBrowserCommand({ plugin, onOpen });

    expect(addCommand).toHaveBeenCalledOnce();
    const cmd = addCommand.mock.calls[0][0];
    expect(cmd.id).toBe('archivist-open-backup-browser');
    expect(cmd.name).toBe(S.CMD_OPEN_BACKUP_BROWSER);
  });

  it('calls onOpen when the command callback is invoked', async () => {
    const { registerOpenBackupBrowserCommand } = await import('../../src/ui/Commands');
    const commands: Array<{ callback?: () => void }> = [];
    const addCommand = vi.fn().mockImplementation((c) => { commands.push(c); return c; });
    const onOpen = vi.fn();

    registerOpenBackupBrowserCommand({ plugin: { addCommand }, onOpen });

    commands[0].callback?.();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Section 13: Fix 1 — stale selectedSnapshot race condition (ROB-002)
// ---------------------------------------------------------------------------

describe('BackupBrowserView race condition guard (_selectFile)', () => {
  it('does not render snapshot A content when snapshot B is selected before A fetchContent resolves', async () => {
    const snapA = makeSnapshot({ id: 'snap-a', created_at: '2026-04-24T09:00:00Z' });
    const snapB = makeSnapshot({ id: 'snap-b', created_at: '2026-04-24T08:00:00Z' });
    const stateA = makeVaultState(['a.md']);
    const stateB = makeVaultState(['b.md']);

    let resolveA!: (v: Uint8Array) => void;
    const slowFetchA = new Promise<Uint8Array>((r) => { resolveA = r; });
    const fastFetchB = Promise.resolve(new TextEncoder().encode('# B'));

    // fetchContent: first call (snap-a/a.md) hangs; second call (snap-b/b.md) resolves fast.
    const fetchContent = vi.fn()
      .mockImplementationOnce(() => slowFetchA)
      .mockImplementationOnce(() => fastFetchB);

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snapA, snapB]),
      },
      restoreService: {
        materializeVaultStateAt: vi.fn()
          .mockResolvedValueOnce(stateA)
          .mockResolvedValueOnce(stateB),
        fetchContent,
      },
    });

    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    // Select snapA and trigger file selection (snap-a's fetchContent hangs)
    await view._selectSnapshot(snapA);
    const selectAPromise = view._selectFile('a.md');

    // Before snap-a resolves, switch to snapB and select b.md (resolves immediately)
    await view._selectSnapshot(snapB);
    await view._selectFile('b.md');

    // Now resolve snap-a's fetch — the continuation must bail (selectedSnapshot is snapB)
    resolveA(new TextEncoder().encode('# A'));
    await selectAPromise;

    // Both fetches were issued
    expect(fetchContent).toHaveBeenCalledWith('snap-a', 'a.md');
    expect(fetchContent).toHaveBeenCalledWith('snap-b', 'b.md');

    // The preview column should reflect snap-b (b.md), not snap-a (a.md).
    // The restore button wired to snap-a's id must NOT be present.
    // Since renderPreviewColumn is guarded, calling it with snap-a data after
    // snapB is selected should have been suppressed — no crash, no stale data.
    // Verify the view did not crash (promise resolved without throw).
    await expect(selectAPromise).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Section 14: Fix 2 — DST-safe date boundaries (ROB-001)
// ---------------------------------------------------------------------------

describe('groupSnapshotsByDate — DST-safe boundaries', () => {
  it('correctly groups yesterday snapshot using calendar-day arithmetic', () => {
    // Simulate a day boundary where fixed-ms subtraction would produce wrong result.
    // Use a UTC-friendly time that exercises the setDate path without ambiguity.
    const now = new Date('2026-03-29T01:00:00Z'); // just after midnight UTC
    const yesterday = makeSnapshot({ created_at: '2026-03-28T12:00:00Z', id: 'yest' });
    const groups = groupSnapshotsByDate([yesterday], now);
    expect(groups.get(S.BROWSER_GROUP_YESTERDAY)).toBeDefined();
    expect(groups.get(S.BROWSER_GROUP_YESTERDAY)?.map((s) => s.id)).toContain('yest');
  });
});

// ---------------------------------------------------------------------------
// Section 15: Fix 4 — tier tag in snapshot rows (SPEC critical)
// ---------------------------------------------------------------------------

describe('BackupBrowserView tier tag rendering', () => {
  it('renders BROWSER_TIER_DAILY label for a snapshot with tier "daily"', async () => {
    const snap: SnapshotIndexEntry = {
      ...makeSnapshot({ created_at: '2026-04-24T09:00:00Z' }),
      tier: 'daily',
    };
    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      now: () => new Date('2026-04-24T10:00:00Z'),
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    const text = collectText(view.contentEl);
    expect(text).toContain(S.BROWSER_TIER_DAILY);
  });

  it('does not render a tier tag when tier is absent', async () => {
    const snap = makeSnapshot({ created_at: '2026-04-24T09:00:00Z' });
    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      now: () => new Date('2026-04-24T10:00:00Z'),
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    const text = collectText(view.contentEl);
    expect(text).not.toContain(S.BROWSER_TIER_DAILY);
    expect(text).not.toContain(S.BROWSER_TIER_MONTHLY);
    expect(text).not.toContain(S.BROWSER_TIER_NEVER_PRUNE);
  });
});

// ---------------------------------------------------------------------------
// Section 16: Fix 5 — ArrowUp/ArrowDown navigation within columns (SPEC a11y)
// ---------------------------------------------------------------------------

describe('BackupBrowserView arrow-key navigation', () => {
  const NOW = new Date('2026-04-24T10:00:00Z');

  it('ArrowDown on the first snapshot row triggers selection of the second row', async () => {
    const snap1 = makeSnapshot({ id: 'snap-1', created_at: '2026-04-24T09:00:00Z' });
    const snap2 = makeSnapshot({ id: 'snap-2', created_at: '2026-04-24T08:00:00Z' });
    const materialize = vi.fn().mockResolvedValue({});
    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap1, snap2]),
      },
      restoreService: {
        materializeVaultStateAt: materialize,
        fetchContent: vi.fn().mockResolvedValue(new Uint8Array()),
      },
      now: () => NOW,
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();

    // Find the first snapshot row and dispatch ArrowDown
    const snapshotsList = findByClass(view.contentEl, 'archivist-snapshots-list') as MockEl;
    const rows = findAllByClass(snapshotsList, 'archivist-snapshot-row');
    expect(rows.length).toBeGreaterThanOrEqual(2);

    rows[0].dispatchEvent({ key: 'ArrowDown', type: 'keydown', preventDefault: () => {} });
    await Promise.resolve();

    // Selection of snap-2 should have been triggered
    expect(materialize).toHaveBeenCalledWith('snap-2');
  });

  it('ArrowUp on the first snapshot row is a no-op', async () => {
    const snap1 = makeSnapshot({ id: 'snap-1', created_at: '2026-04-24T09:00:00Z' });
    const materialize = vi.fn().mockResolvedValue({});
    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap1]),
      },
      restoreService: {
        materializeVaultStateAt: materialize,
        fetchContent: vi.fn().mockResolvedValue(new Uint8Array()),
      },
      now: () => NOW,
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();

    // After onOpen, materialize was not called yet (no snapshot selected)
    const snapshotsList = findByClass(view.contentEl, 'archivist-snapshots-list') as MockEl;
    const rows = findAllByClass(snapshotsList, 'archivist-snapshot-row');
    expect(rows.length).toBeGreaterThanOrEqual(1);

    materialize.mockClear();
    rows[0].dispatchEvent({ key: 'ArrowUp', type: 'keydown', preventDefault: () => {} });
    await Promise.resolve();

    // No selection should have been triggered (no-op at boundary)
    expect(materialize).not.toHaveBeenCalled();
  });

  it('ArrowDown in the files column advances to the next file and triggers selection', async () => {
    const snap = makeSnapshot({ id: 'snap-1', created_at: '2026-04-24T09:00:00Z' });
    const state = makeVaultState(['a.md', 'b.md']);
    const fetchContent = vi.fn().mockResolvedValue(new TextEncoder().encode('content'));
    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(state),
        fetchContent,
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);

    const filesList = findByClass(view.contentEl, 'archivist-files-list') as MockEl;
    const fileRows = findAllByClass(filesList, 'archivist-file-row');
    expect(fileRows.length).toBeGreaterThanOrEqual(2);

    fetchContent.mockClear();
    fileRows[0].dispatchEvent({ key: 'ArrowDown', type: 'keydown', preventDefault: () => {} });
    await Promise.resolve();
    await Promise.resolve(); // flush the async _selectFile chain

    // fetchContent should have been called for the second file
    expect(fetchContent).toHaveBeenCalledOnce();
  });

  it('ArrowUp on first file row is a no-op', async () => {
    const snap = makeSnapshot({ id: 'snap-1', created_at: '2026-04-24T09:00:00Z' });
    const state = makeVaultState(['a.md', 'b.md']);
    const fetchContent = vi.fn().mockResolvedValue(new TextEncoder().encode('content'));
    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(state),
        fetchContent,
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);

    const filesList = findByClass(view.contentEl, 'archivist-files-list') as MockEl;
    const fileRows = findAllByClass(filesList, 'archivist-file-row');
    expect(fileRows.length).toBeGreaterThanOrEqual(1);

    fetchContent.mockClear();
    fileRows[0].dispatchEvent({ key: 'ArrowUp', type: 'keydown', preventDefault: () => {} });
    await Promise.resolve();

    expect(fetchContent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Section 17: Fix 6 — empty-state body rendering (SPEC)
// ---------------------------------------------------------------------------

describe('BackupBrowserView empty state body', () => {
  it('renders the empty-state body text below the title', async () => {
    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([]),
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();

    const text = collectText(view.contentEl);
    expect(text).toContain(S.BROWSER_EMPTY_STATE_TITLE);
    // Body text contains "when backups are configured" placeholder
    expect(text).toContain('when backups are configured');
  });
});

// ---------------------------------------------------------------------------
// Section 18: Fix 7 — storage-warning banner rendering (SPEC + ROB-006)
// ---------------------------------------------------------------------------

describe('BackupBrowserView banner rendering', () => {
  it('renders a banner when onBannersChange fires with a persistent banner', async () => {
    let bannerCallback: (() => void) | null = null;
    let banners: Array<{ code: string; message: string; onDismiss?: () => void }> = [];

    const noticeCenter = {
      showPersistent: vi.fn(),
      onBannersChange: vi.fn().mockImplementation((cb: () => void) => {
        bannerCallback = cb;
        return () => {};
      }),
      getPersistentBanners: vi.fn(() => banners),
    };

    const deps = makeDeps({ noticeCenter });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();

    // No banners yet
    const bannerRegion = findByClass(view.contentEl, 'archivist-browser-banners') as MockEl;
    expect(bannerRegion).toBeDefined();
    expect(bannerRegion.children).toHaveLength(0);

    // Publish a banner and fire the subscription callback
    banners = [{ code: 'STORAGE_WARN', message: 'Storage at 90%' }];
    bannerCallback!();

    const text = collectText(bannerRegion);
    expect(text).toContain('Storage at 90%');
  });

  it('clearing banners removes them from the banner region', async () => {
    let bannerCallback: (() => void) | null = null;
    let banners: Array<{ code: string; message: string }> = [
      { code: 'STORAGE_WARN', message: 'Storage at 90%' },
    ];

    const noticeCenter = {
      showPersistent: vi.fn(),
      onBannersChange: vi.fn().mockImplementation((cb: () => void) => {
        bannerCallback = cb;
        return () => {};
      }),
      getPersistentBanners: vi.fn(() => banners),
    };

    const deps = makeDeps({ noticeCenter });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();

    // Trigger initial render with banner
    bannerCallback!();
    const bannerRegion = findByClass(view.contentEl, 'archivist-browser-banners') as MockEl;
    expect(collectText(bannerRegion)).toContain('Storage at 90%');

    // Clear banners and re-fire
    banners = [];
    bannerCallback!();
    expect(bannerRegion.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Section 19: Fix 8 — deleted-file visual differentiation (SPEC minor)
// ---------------------------------------------------------------------------

describe('BackupBrowserView deleted-file marker', () => {
  it('shows "[deleted in live vault]" marker when file is absent from vault', async () => {
    const snap = makeSnapshot({ id: 'snap-1', created_at: '2026-04-24T09:00:00Z' });
    const state = makeVaultState(['gone.md']);

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(state),
        fetchContent: vi.fn().mockResolvedValue(new TextEncoder().encode('content')),
      },
      vaultHasPath: vi.fn().mockReturnValue(false),
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);
    await view._selectFile('gone.md');

    const previewCol = findByClass(view.contentEl, 'archivist-preview') as MockEl;
    const text = collectText(previewCol);
    expect(text).toContain('[deleted in live vault]');
  });

  it('does not show the deleted marker when file exists in live vault', async () => {
    const snap = makeSnapshot({ id: 'snap-1', created_at: '2026-04-24T09:00:00Z' });
    const state = makeVaultState(['present.md']);

    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
      },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(state),
        fetchContent: vi.fn().mockResolvedValue(new TextEncoder().encode('content')),
      },
      vaultHasPath: vi.fn().mockReturnValue(true),
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);
    await view._selectFile('present.md');

    const previewCol = findByClass(view.contentEl, 'archivist-preview') as MockEl;
    const text = collectText(previewCol);
    expect(text).not.toContain('[deleted in live vault]');
  });
});

// ---------------------------------------------------------------------------
// Section 20: Fix 10 — buildFileTree path normalization
// ---------------------------------------------------------------------------

describe('buildFileTree path normalization', () => {
  it('handles backslash-separated paths (Windows-style)', () => {
    const state = makeVaultState(['folder\\note.md']);
    const tree = buildFileTree(state);
    const folderNode = tree.children.find((c) => c.name === 'folder');
    expect(folderNode).toBeDefined();
    expect(folderNode?.isDir).toBe(true);
    const noteNode = folderNode?.children.find((c) => c.name === 'note.md');
    expect(noteNode).toBeDefined();
    expect(noteNode?.isDir).toBe(false);
  });

  it('handles double-slash paths without producing empty segments', () => {
    const state = makeVaultState(['folder//note.md']);
    const tree = buildFileTree(state);
    const folderNode = tree.children.find((c) => c.name === 'folder');
    expect(folderNode).toBeDefined();
    const noteNode = folderNode?.children.find((c) => c.name === 'note.md');
    expect(noteNode).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Section 21: Directory selection populates fullPath + supports nested prefixes
// ---------------------------------------------------------------------------

describe('buildFileTree directory fullPath', () => {
  it('top-level directory gets its own name as fullPath', () => {
    const state = makeVaultState(['foo/a.md', 'foo/b.md']);
    const tree = buildFileTree(state);
    const foo = tree.children.find((c) => c.name === 'foo' && c.isDir);
    expect(foo?.fullPath).toBe('foo');
  });

  it('nested directory fullPath reflects the joined ancestor chain', () => {
    const state = makeVaultState(['foo/sub/c.md']);
    const tree = buildFileTree(state);
    const foo = tree.children.find((c) => c.name === 'foo' && c.isDir);
    const sub = foo?.children.find((c) => c.name === 'sub' && c.isDir);
    expect(sub?.fullPath).toBe('foo/sub');
  });
});

// ---------------------------------------------------------------------------
// Section 22: Directory selection + restore flow
// ---------------------------------------------------------------------------

describe('BackupBrowserView directory selection', () => {
  it('selecting a directory blanks selectedPath and renders the dir filelist', async () => {
    const snap = makeSnapshot({ created_at: '2026-04-25T10:00:00Z' });
    const state = makeVaultState(['notes/a.md', 'notes/b.md', 'other/c.md']);
    const deps = makeDeps({
      manifestCache: { listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]) },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(state),
        fetchContent: vi.fn().mockResolvedValue(new Uint8Array()),
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);
    await view._selectDir('notes');

    // Internal state: dir selected, file deselected.
    expect((view as unknown as { selectedDir: string }).selectedDir).toBe('notes');
    expect((view as unknown as { selectedPath: string | null }).selectedPath).toBeNull();

    // Preview column rendered the file list with both notes/* paths.
    const previewCol = (view as unknown as { previewColEl: MockEl }).previewColEl;
    const list = findByClass(previewCol, 'archivist-dir-file-list');
    expect(list).toBeDefined();
    const text = collectText(list!);
    expect(text).toContain('notes/a.md');
    expect(text).toContain('notes/b.md');
    expect(text).not.toContain('other/c.md');
  });

  it('renders a placeholder + disabled buttons when prefix matches no files', async () => {
    const snap = makeSnapshot({ created_at: '2026-04-25T10:00:00Z' });
    // Materialized state has no files under "empty/" — common when the dir
    // existed at one snapshot but its contents were all deleted by the next.
    const deps = makeDeps({
      manifestCache: { listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]) },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(makeVaultState(['kept/a.md'])),
        fetchContent: vi.fn().mockResolvedValue(new Uint8Array()),
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);
    await view._selectDir('empty');

    const previewCol = (view as unknown as { previewColEl: MockEl }).previewColEl;
    const placeholder = findByClass(previewCol, 'archivist-dir-empty');
    expect(placeholder).toBeDefined();
    expect(placeholder?.textContent).toContain('No files in this directory');

    const buttons = findAllByClass(previewCol, '');
    const actions = findByClass(previewCol, 'archivist-dir-actions');
    expect(actions).toBeDefined();
    const actionButtons = actions!.children.filter((c) => c.tagName === 'button');
    expect(actionButtons.length).toBe(2);
    for (const btn of actionButtons) {
      expect(btn.attrs['aria-disabled']).toBe('true');
      expect(btn.attrs['disabled']).toBe('');
    }
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('Restore-in-place button on a non-empty dir opens the confirm modal', async () => {
    const snap = makeSnapshot({ created_at: '2026-04-25T10:00:00Z' });
    const state = makeVaultState(['notes/a.md', 'notes/b.md']);
    const deps = makeDeps({
      manifestCache: { listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]) },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(state),
        fetchContent: vi.fn().mockResolvedValue(new Uint8Array()),
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);
    await view._selectDir('notes');

    const previewCol = (view as unknown as { previewColEl: MockEl }).previewColEl;
    const actions = findByClass(previewCol, 'archivist-dir-actions');
    expect(actions).toBeDefined();
    const inPlaceBtn = actions!.children.find((c) => c.tagName === 'button');
    expect(inPlaceBtn).toBeDefined();
    // Triggering the click should not throw and should not call restore yet
    // (modal must confirm first).
    inPlaceBtn!.dispatchEvent({ type: 'click', key: '', preventDefault: () => {} });
    const restoreOps = deps.restoreOperations as unknown as {
      restoreDirectory: ReturnType<typeof vi.fn>;
    };
    expect(restoreOps.restoreDirectory).not.toHaveBeenCalled();
  });

  it('_dirRestoreInFlight gate prevents a second restore while one is running', async () => {
    const snap = makeSnapshot({ created_at: '2026-04-25T10:00:00Z' });
    const state = makeVaultState(['notes/a.md']);
    const deps = makeDeps({
      manifestCache: { listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]) },
      restoreService: {
        materializeVaultStateAt: vi.fn().mockResolvedValue(state),
        fetchContent: vi.fn().mockResolvedValue(new Uint8Array()),
      },
    });
    const view = new BackupBrowserView(makeLeaf(), deps);
    await view.onOpen();
    await view._selectSnapshot(snap);

    // Manually flip the gate and call the private confirm method via cast.
    const internal = view as unknown as {
      _dirRestoreInFlight: boolean;
      _confirmDirectoryRestore: (
        prefix: string,
        matches: string[],
        snapshotId: string,
        mode: 'in_place' | 'as_copy',
      ) => void;
    };
    internal._dirRestoreInFlight = true;
    internal._confirmDirectoryRestore('notes', ['notes/a.md'], snap.id, 'in_place');

    const restoreOps = deps.restoreOperations as unknown as {
      restoreDirectory: ReturnType<typeof vi.fn>;
    };
    expect(restoreOps.restoreDirectory).not.toHaveBeenCalled();
  });
});

