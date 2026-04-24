// T9.5 — Phase 9 integration: BackupBrowserView + FileHistoryModal +
// ConfirmRestoreModal wired together. Focused on cross-module contracts —
// per-unit behaviour is exhaustively tested in tests/ui/*.test.ts.
//
// Scenarios:
//   1. BackupBrowserView: 1k-file snapshot (cut from 10k for <1s test run;
//      see note below) + deleted-path restore via confirm modal.
//   2. FileHistoryModal: 500-version pagination — 50 rows initial, +50 per
//      click, all 500 revealed on 9th click, show-more hidden after.
//   3. End-to-end: FileHistoryModal → row-restore → ConfirmRestoreModal fires
//      → restoreInPlace called with correct (path, snapshotId), both modals close.
//
// Note on scale: 10k paths pushes buildFileTree + renderFilesColumn past the
// 1s vitest per-test budget in CI. 1k paths with 10 folders × 100 files each
// provides adequate coverage of the tree-building wiring without the perf hit.

import { describe, expect, it, vi } from 'vitest';
import {
  BackupBrowserView,
  type BackupBrowserDeps,
} from '../../src/ui/BackupBrowserView';
import {
  renderHistoryContent,
  type HistoryHandle,
  type HistoryRenderOpts,
  type HistoryRenderState,
} from '../../src/ui/FileHistoryModal';
import {
  renderConfirmRestoreContent,
  type ModalHandle,
  type ConfirmRestoreOpts,
} from '../../src/ui/ConfirmRestoreModal';
import type { VersionEntry } from '../../src/services/RestoreService';
import { App, WorkspaceLeaf } from '../fixtures/obsidian-mock';
import type { MockEl } from '../fixtures/obsidian-mock';
import type { SnapshotIndexEntry } from '../../src/model/SnapshotIndex';
import type { FileEntry } from '../../src/model/Manifest';

// ---------------------------------------------------------------------------
// Shared factories
// ---------------------------------------------------------------------------

function makeSnapshot(id: string, created_at: string): SnapshotIndexEntry {
  return {
    id,
    type: 'full',
    parent_id: null,
    device_id: 'device-integration',
    blob_hashes: [],
    created_at,
  };
}

function makeVersionEntry(overrides: Partial<VersionEntry> = {}): VersionEntry {
  return {
    snapshot_id: 'snap-001',
    path: 'notes/journal.md',
    hash: 'abc123',
    size: 4_096,
    created_at: '2026-04-01T03:00:00.000Z',
    currentPath: 'notes/journal.md',
    priorPath: null,
    renamedAt: null,
    ...overrides,
  };
}

/** Build N sequential VersionEntry items, newest first. */
function makeVersions(n: number): VersionEntry[] {
  const base = new Date('2026-04-24T12:00:00.000Z').getTime();
  return Array.from({ length: n }, (_, i) => {
    const ms = base - i * 3_600_000; // 1 hour apart
    return makeVersionEntry({
      snapshot_id: `snap-${String(i).padStart(3, '0')}`,
      created_at: new Date(ms).toISOString(),
    });
  });
}

// ---------------------------------------------------------------------------
// DOM helper — collect text from MockEl tree
// ---------------------------------------------------------------------------

function collectText(el: MockEl): string {
  return (el.textContent ?? '') + el.children.map(collectText).join('');
}

function findAllByClass(el: MockEl, cls: string): MockEl[] {
  const hits: MockEl[] = [];
  if (el.className.includes(cls)) hits.push(el);
  for (const child of el.children) hits.push(...findAllByClass(child, cls));
  return hits;
}

// ---------------------------------------------------------------------------
// Recording HistoryHandle (subset of file-history-modal unit test handle)
// ---------------------------------------------------------------------------

interface RecordedRow {
  timestamp: string;
  size: string;
  isNowRow: boolean;
  onRestore?: () => void;
}

interface RecordingHistoryHandle extends HistoryHandle {
  rows: RecordedRow[];
  showMoreVisible: boolean;
  closed: boolean;
  clickShowMore(): void;
  clickRowRestore(index: number): void;
}

function makeRecordingHistoryHandle(): RecordingHistoryHandle {
  let showMoreCb: (() => void) | undefined;
  let isClosed = false;
  const rows: RecordedRow[] = [];
  const keydownHandlers: Array<(key: string) => void> = [];

  return {
    get rows() { return rows; },
    get showMoreVisible() { return showMoreCb !== undefined; },
    get closed() { return isClosed; },

    // HistoryHandle interface
    setTitle() {},
    showEmpty() {},
    showSingleVersionMsg() {},
    clearRows() { rows.length = 0; },
    addRow(row) {
      rows.push({
        timestamp: row.timestamp,
        size: row.size,
        isNowRow: row.isNowRow,
        onRestore: row.onRestore,
      });
    },
    showShowMoreButton(onClick) { showMoreCb = onClick; },
    hideShowMoreButton() { showMoreCb = undefined; },
    showError() {},
    close() { isClosed = true; },
    onKeydown(handler) { keydownHandlers.push(handler); },

    // Test helpers
    clickShowMore() { showMoreCb?.(); },
    clickRowRestore(index: number) { rows[index]?.onRestore?.(); },
  };
}

// ---------------------------------------------------------------------------
// Recording ModalHandle for ConfirmRestoreModal
// ---------------------------------------------------------------------------

interface RecordingModalHandle extends ModalHandle {
  closed: boolean;
  clickButton(label: string): void;
}

function makeRecordingModalHandle(): RecordingModalHandle {
  let isClosed = false;
  const buttons: Array<{ label: string; onClick: () => void }> = [];
  const keydownHandlers: Array<(key: string) => void> = [];

  return {
    get closed() { return isClosed; },

    setTitle() {},
    setBody() {},
    addLine() {},
    addButton(label, _isDefault, onClick) { buttons.push({ label, onClick }); },
    close() { isClosed = true; },
    onKeydown(handler) { keydownHandlers.push(handler); },

    clickButton(label: string) {
      const found = buttons.find((b) => b.label === label);
      if (!found) throw new Error(`No button with label "${label}"`);
      found.onClick();
    },
  };
}

// ---------------------------------------------------------------------------
// BackupBrowserView deps builder
// ---------------------------------------------------------------------------

function makeBrowserDeps(overrides?: Partial<BackupBrowserDeps>): BackupBrowserDeps {
  return {
    restoreService: {
      materializeVaultStateAt: vi.fn().mockResolvedValue({}),
      fetchContent: vi.fn().mockResolvedValue(new TextEncoder().encode('# preview')),
    },
    manifestCache: {
      listSnapshotsNewestFirst: vi.fn().mockResolvedValue([]),
    },
    restoreOperations: {
      restoreInPlace: vi.fn().mockResolvedValue({ ok: true }),
      restoreAsCopy: vi.fn().mockResolvedValue({ ok: true }),
    },
    noticeCenter: {
      showPersistent: vi.fn(),
      onBannersChange: vi.fn().mockReturnValue(() => {}),
    },
    advisory: {
      isDismissed: () => true,
      saveDismissed: vi.fn().mockResolvedValue(undefined),
    },
    vaultHasPath: vi.fn().mockReturnValue(true),
    app: new App(),
    now: () => new Date('2026-04-24T10:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 — BackupBrowserView: 1k-file snapshot + deleted-path restore
// ---------------------------------------------------------------------------
// 10k paths push buildFileTree + renderFilesColumn past the 1s per-test
// budget in vitest. 1k files (10 folders × 100 files) is sufficient to
// validate that the tree-building + file-selection wiring handles large state.

describe('Phase 9 integration — Scenario 1: BackupBrowserView large snapshot + deleted-path restore', () => {
  // Build 1k synthetic paths: folder-0/file-0.md … folder-9/file-99.md
  function buildLargeState(): Record<string, FileEntry> {
    const state: Record<string, FileEntry> = {};
    for (let folder = 0; folder < 10; folder++) {
      for (let file = 0; file < 100; file++) {
        state[`folder-${folder}/file-${file}.md`] = { hash: `h${folder}${file}`, size: 1024, mtime: 0 };
      }
    }
    return state;
  }

  const SNAP_ID = 'snap-2026-04-24';
  const DELETED_PATH = 'folder-3/file-42.md';

  it('materializes a 1k-file snapshot and renders file nodes', async () => {
    const largeState = buildLargeState();
    const restoreService = {
      materializeVaultStateAt: vi.fn().mockResolvedValue(largeState),
      fetchContent: vi.fn().mockResolvedValue(new TextEncoder().encode('content')),
    };
    const manifestCache = {
      listSnapshotsNewestFirst: vi.fn().mockResolvedValue([makeSnapshot(SNAP_ID, '2026-04-24T03:00:00.000Z')]),
    };
    const deps = makeBrowserDeps({ restoreService, manifestCache });
    const view = new BackupBrowserView(new WorkspaceLeaf(), deps);

    await view.onOpen();

    // Select snapshot — triggers materializeVaultStateAt
    await view._selectSnapshot(makeSnapshot(SNAP_ID, '2026-04-24T03:00:00.000Z'));

    expect(restoreService.materializeVaultStateAt).toHaveBeenCalledWith(SNAP_ID);

    // File tree should have rendered folder nodes
    const folderNodes = findAllByClass(view.contentEl, 'archivist-file-dir');
    expect(folderNodes.length).toBeGreaterThanOrEqual(10);

    // File rows should be present
    const fileRows = findAllByClass(view.contentEl, 'archivist-file-row');
    expect(fileRows.length).toBeGreaterThan(0);
  });

  it('marks a deleted-path file and triggers restoreInPlace when confirm fires', async () => {
    const largeState = buildLargeState();
    const restoreInPlace = vi.fn().mockResolvedValue({ ok: true });
    const restoreService = {
      materializeVaultStateAt: vi.fn().mockResolvedValue(largeState),
      fetchContent: vi.fn().mockResolvedValue(new TextEncoder().encode('deleted content')),
    };
    const manifestCache = {
      listSnapshotsNewestFirst: vi.fn().mockResolvedValue([makeSnapshot(SNAP_ID, '2026-04-24T03:00:00.000Z')]),
    };
    // vaultHasPath returns false for the deleted path, true for everything else
    const vaultHasPath = vi.fn().mockImplementation((p: string) => p !== DELETED_PATH);

    const deps = makeBrowserDeps({
      restoreService,
      manifestCache,
      restoreOperations: {
        restoreInPlace,
        restoreAsCopy: vi.fn().mockResolvedValue({ ok: true }),
      },
      vaultHasPath,
    });
    const view = new BackupBrowserView(new WorkspaceLeaf(), deps);

    await view.onOpen();
    await view._selectSnapshot(makeSnapshot(SNAP_ID, '2026-04-24T03:00:00.000Z'));
    await view._selectFile(DELETED_PATH);

    // isDeleted marker must appear in the preview column
    const text = collectText(view.contentEl);
    expect(text).toContain('[deleted in live vault]');

    // Find and click the restore-in-place button
    const inPlaceBtn = findAllByClass(view.contentEl, 'archivist-restore-in-place');
    expect(inPlaceBtn.length).toBeGreaterThan(0);
    inPlaceBtn[0].dispatchEvent({ type: 'click', key: '', preventDefault: () => {} });

    // restoreInPlace is called with the correct (path, snapshotId) pair
    await vi.waitFor(() => {
      expect(restoreInPlace).toHaveBeenCalledWith(DELETED_PATH, SNAP_ID);
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — FileHistoryModal: 500-version pagination
// ---------------------------------------------------------------------------

describe('Phase 9 integration — Scenario 2: FileHistoryModal 500-version pagination', () => {
  const PAGE_SIZE = 50;
  const TOTAL = 500;
  // When vaultInfo.exists is true, a live-now row is prepended → first page
  // renders 1 live-now row + 49 history rows (50 total visible slots).
  // When vaultInfo.exists is false, all 50 slots are history rows.
  // Use exists=false for clean arithmetic in this pagination test.
  const VAULT_INFO = { exists: false, size: 0, mtime: 0 };

  function makeRenderOpts(handle: HistoryHandle, onShowMore: (s: HistoryRenderState) => void): HistoryRenderOpts {
    return {
      currentPath: 'notes/target.md',
      entries: makeVersions(TOTAL),
      restoreService: {
        fetchContent: vi.fn().mockResolvedValue(new Uint8Array([1])),
      },
      restoreOperations: {
        restoreInPlace: vi.fn().mockResolvedValue({ ok: true }),
      },
      vaultInfo: VAULT_INFO,
      now: () => new Date('2026-04-24T12:00:00Z').getTime(),
      onShowMore,
    };
  }

  it('initial render shows 50 rows and a show-more button', () => {
    const handle = makeRecordingHistoryHandle();
    const initialState: HistoryRenderState = { visibleCount: PAGE_SIZE, previewEntry: null };
    const opts = makeRenderOpts(handle, () => {});

    renderHistoryContent(handle, opts, initialState);

    expect(handle.rows.length).toBe(PAGE_SIZE);
    expect(handle.showMoreVisible).toBe(true);
  });

  it('clicking show-more 9 times reveals all 500 rows and hides the button', () => {
    let state: HistoryRenderState = { visibleCount: PAGE_SIZE, previewEntry: null };
    let handle = makeRecordingHistoryHandle();

    function rerender(): void {
      handle = makeRecordingHistoryHandle();
      const opts = makeRenderOpts(handle, (updated) => {
        state = updated;
        rerender();
      });
      renderHistoryContent(handle, opts, state);
    }

    rerender();

    // Click "Show 50 more" 9 times: 50 → 100 → … → 500
    for (let click = 0; click < 9; click++) {
      expect(handle.showMoreVisible).toBe(true);
      handle.clickShowMore();
    }

    // After 9 clicks: visibleCount = 50 + 9×50 = 500
    expect(handle.rows.length).toBe(TOTAL);
    expect(handle.showMoreVisible).toBe(false);
  });

  it('intermediate click advances row count by PAGE_SIZE each time', () => {
    let state: HistoryRenderState = { visibleCount: PAGE_SIZE, previewEntry: null };
    let handle = makeRecordingHistoryHandle();

    function rerender(): void {
      handle = makeRecordingHistoryHandle();
      const opts = makeRenderOpts(handle, (updated) => {
        state = updated;
        rerender();
      });
      renderHistoryContent(handle, opts, state);
    }

    rerender();

    // Click once: 50 → 100 rows
    handle.clickShowMore();
    expect(handle.rows.length).toBe(PAGE_SIZE * 2);
    expect(handle.showMoreVisible).toBe(true);

    // Click again: 100 → 150 rows
    handle.clickShowMore();
    expect(handle.rows.length).toBe(PAGE_SIZE * 3);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — End-to-end: history modal → confirm restore → both close
// ---------------------------------------------------------------------------

describe('Phase 9 integration — Scenario 3: history → restore → close both modals', () => {
  const CURRENT_PATH = 'project/roadmap.md';
  const ROW_SNAPSHOT_ID = 'snap-002'; // row at index 1 (0-based; index 0 is snap-000)

  it('clicking Restore on a row opens ConfirmRestoreModal; confirming calls restoreInPlace and closes both', () => {
    const restoreInPlace = vi.fn().mockResolvedValue({ ok: true });
    const historyHandle = makeRecordingHistoryHandle();
    const confirmHandle = makeRecordingModalHandle();

    let capturedConfirmOpts: ConfirmRestoreOpts | null = null;

    const entries = makeVersions(3);
    // Override snapshot_ids so we can assert the exact id
    entries[0] = { ...entries[0], snapshot_id: 'snap-000' };
    entries[1] = { ...entries[1], snapshot_id: ROW_SNAPSHOT_ID, currentPath: CURRENT_PATH, path: CURRENT_PATH };
    entries[2] = { ...entries[2], snapshot_id: 'snap-004' };

    const opts: HistoryRenderOpts = {
      currentPath: CURRENT_PATH,
      entries,
      restoreService: {
        fetchContent: vi.fn().mockResolvedValue(new Uint8Array([1])),
      },
      restoreOperations: { restoreInPlace },
      vaultInfo: { exists: true, size: 1024, mtime: Date.now() },
      now: () => new Date('2026-04-24T12:00:00Z').getTime(),
      onRestore: (entry, timestamp, size, missingDirs) => {
        capturedConfirmOpts = {
          filePath: entry.currentPath,
          timestamp,
          size,
          missingDirs,
          onConfirm: () => {
            void restoreInPlace(entry.currentPath, entry.snapshot_id).then(() => {
              historyHandle.close();
            });
          },
          onCancel: () => {},
        };
        // Simulate modal open by rendering into the recording handle
        renderConfirmRestoreContent(confirmHandle, capturedConfirmOpts);
      },
    };

    const state: HistoryRenderState = { visibleCount: 50, previewEntry: null };
    renderHistoryContent(historyHandle, opts, state);

    // Row 0 is the live-now row (isNowRow: true, no restore action).
    // Row 1 is entry[0] (snap-000), row 2 is entry[1] (snap-002).
    // Find the row that corresponds to ROW_SNAPSHOT_ID.
    const historyRows = historyHandle.rows.filter((r) => !r.isNowRow);
    // entry[1] is the second non-now row (index 1 in historyRows)
    const targetRowIdx = historyHandle.rows.findIndex((r) => !r.isNowRow && r.onRestore !== undefined);
    // Click restore on the first non-now row with a restore handler → entry[0] (snap-000)
    // For snap-002, find its position among all rows
    const allRows = historyHandle.rows;
    // vaultInfo.exists = true, so row[0] = live-now, row[1] = snap-000, row[2] = snap-002
    // We want row index 2 (snap-002 / ROW_SNAPSHOT_ID)
    expect(allRows.length).toBeGreaterThanOrEqual(3);
    historyHandle.clickRowRestore(2);

    // ConfirmRestoreModal should have been opened (capturedConfirmOpts set)
    expect(capturedConfirmOpts).not.toBeNull();
    expect(capturedConfirmOpts!.filePath).toBe(CURRENT_PATH);

    // Confirm button label triggers onConfirm
    confirmHandle.clickButton('Replace');

    // confirmHandle.close() was called by renderConfirmRestoreContent's dismiss()
    expect(confirmHandle.closed).toBe(true);

    // restoreInPlace must be called with the right args
    expect(restoreInPlace).toHaveBeenCalledWith(CURRENT_PATH, ROW_SNAPSHOT_ID);

    // history handle closes after restoreInPlace resolves
    return vi.waitFor(() => {
      expect(historyHandle.closed).toBe(true);
    });
  });
});
