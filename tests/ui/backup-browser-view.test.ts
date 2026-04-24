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

    // Trigger restore in place
    await view._triggerRestoreInPlace();

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
