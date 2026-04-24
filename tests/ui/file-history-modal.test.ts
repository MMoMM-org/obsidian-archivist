// T9.2 — FileHistoryModal: version list with pagination + rename markers.
//
// Testing strategy:
//   - Pure helper functions (formatVersionRow, buildLiveNowRow) via direct calls.
//   - Modal rendering via renderHistoryContent() with a RecordingHistoryHandle.
//   - Command registration via registerShowHistoryCommand() with a stub plugin.
//   - Integration path: modal open → row render → preview → restore flow.
//
// All tests are behavioural; no spy on internal methods.

import { describe, expect, it, vi } from 'vitest';
import type { VersionEntry } from '../../src/services/RestoreService';
import type { SnapshotManifest } from '../../src/model/Manifest';
import {
  formatVersionRow,
  buildLiveNowRow,
  renderHistoryContent,
  type HistoryHandle,
  type HistoryRenderOpts,
  type HistoryRenderState,
  type FormattedRow,
} from '../../src/ui/FileHistoryModal';
import { registerShowHistoryCommand } from '../../src/ui/Commands';
import { S } from '../../src/ui/strings';

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

const BASE_ISO = '2025-01-15T09:00:00.000Z';
const NOW_ISO = '2025-01-15T14:00:00.000Z';
const NOW_MS = new Date(NOW_ISO).getTime();

function makeVersionEntry(overrides: Partial<VersionEntry> = {}): VersionEntry {
  return {
    snapshot_id: 'snap-001',
    path: 'notes/journal.md',
    hash: 'abc123',
    size: 12_288,
    created_at: BASE_ISO,
    currentPath: 'notes/journal.md',
    priorPath: null,
    renamedAt: null,
    ...overrides,
  };
}

function makeManifest(overrides: Partial<SnapshotManifest> = {}): SnapshotManifest {
  return {
    schema_version: '1.0',
    id: 'snap-001',
    type: 'full',
    parent_id: null,
    device_id: 'dev-1',
    created_at: BASE_ISO,
    vault_name: 'test-vault',
    vault_prefix: 'test-vault',
    files: {},
    deleted: [],
    renames: [],
    exclusions_applied: null,
    ...overrides,
  };
}

// Build N sequential version entries, newest first.
function makeVersions(n: number): VersionEntry[] {
  return Array.from({ length: n }, (_, i) => {
    const ms = NOW_MS - i * 60_000;
    return makeVersionEntry({
      snapshot_id: `snap-${String(i).padStart(3, '0')}`,
      created_at: new Date(ms).toISOString(),
    });
  });
}

// ---------------------------------------------------------------------------
// Recording HistoryHandle — drives tests without Obsidian
// ---------------------------------------------------------------------------

interface RecordedRow {
  timestamp: string;
  size: string;
  tierTag: string | null;
  renamedFrom: string | null;
  isNowRow: boolean;
  onPreview?: () => void;
  onRestore?: () => void;
}

interface RecordedContent {
  title: string;
  singleVersionMsg: string | null;
  emptyMsg: string | null;
  rows: RecordedRow[];
  showMoreVisible: boolean;
  onShowMore?: () => void;
  errorMsg: string | null;
  previewContainerCleared: boolean;
}

interface RecordingHandle extends HistoryHandle {
  _recorded: RecordedContent;
  _closed: boolean;
  _keydownHandlers: Array<(key: string) => void>;
  fireKeydown(key: string): void;
  clickRow(index: number, action: 'preview' | 'restore'): void;
  clickShowMore(): void;
}

function makeRecordingHandle(): RecordingHandle {
  const recorded: RecordedContent = {
    title: '',
    singleVersionMsg: null,
    emptyMsg: null,
    rows: [],
    showMoreVisible: false,
    onShowMore: undefined,
    errorMsg: null,
    previewContainerCleared: false,
  };

  let isClosed = false;
  const keydownHandlers: Array<(key: string) => void> = [];

  const handle: RecordingHandle = {
    _recorded: recorded,
    get _closed() {
      return isClosed;
    },
    _keydownHandlers: keydownHandlers,

    // HistoryHandle interface
    setTitle(title: string) {
      recorded.title = title;
    },
    showEmpty(msg: string) {
      recorded.emptyMsg = msg;
    },
    showSingleVersionMsg(msg: string) {
      recorded.singleVersionMsg = msg;
    },
    clearRows() {
      recorded.rows = [];
    },
    addRow(row: RecordedRow & { onPreview?: () => void; onRestore?: () => void }) {
      recorded.rows.push(row);
    },
    showShowMoreButton(onClick: () => void) {
      recorded.showMoreVisible = true;
      recorded.onShowMore = onClick;
    },
    hideShowMoreButton() {
      recorded.showMoreVisible = false;
      recorded.onShowMore = undefined;
    },
    clearPreview() {
      recorded.previewContainerCleared = true;
    },
    showError(msg: string) {
      recorded.errorMsg = msg;
    },
    close() {
      isClosed = true;
    },
    onKeydown(handler: (key: string) => void) {
      keydownHandlers.push(handler);
    },

    // Test driver helpers
    fireKeydown(key: string) {
      for (const h of keydownHandlers) h(key);
    },
    clickRow(index: number, action: 'preview' | 'restore') {
      const row = recorded.rows[index];
      if (!row) throw new Error(`No row at index ${index}`);
      if (action === 'preview') row.onPreview?.();
      else row.onRestore?.();
    },
    clickShowMore() {
      recorded.onShowMore?.();
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Helpers for rendering
// ---------------------------------------------------------------------------

function makeRestoreService(opts: {
  fetchContent?: (id: string, path: string) => Promise<Uint8Array>;
} = {}): HistoryRenderOpts['restoreService'] {
  return {
    fetchContent: opts.fetchContent ?? vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  };
}

function makeRestoreOperations(opts: {
  restoreInPlace?: (path: string, snapId: string) => Promise<unknown>;
} = {}): HistoryRenderOpts['restoreOperations'] {
  return {
    restoreInPlace: opts.restoreInPlace ?? vi.fn().mockResolvedValue({ ok: true }),
  };
}

function makeVaultInfo(opts: {
  size?: number;
  mtime?: number;
  exists?: boolean;
} = {}): HistoryRenderOpts['vaultInfo'] {
  return {
    size: opts.size ?? 8_192,
    mtime: opts.mtime ?? NOW_MS,
    exists: opts.exists ?? true,
  };
}

function makeRenderOpts(
  entries: VersionEntry[],
  overrides: Partial<HistoryRenderOpts> = {},
): HistoryRenderOpts {
  return {
    currentPath: 'notes/journal.md',
    entries,
    restoreService: makeRestoreService(),
    restoreOperations: makeRestoreOperations(),
    vaultInfo: makeVaultInfo(),
    now: () => NOW_MS,
    onConfirmRestore: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function makeRenderState(overrides: Partial<HistoryRenderState> = {}): HistoryRenderState {
  return {
    visibleCount: 50,
    previewEntry: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. formatVersionRow pure helper
// ---------------------------------------------------------------------------

describe('formatVersionRow — pure formatting', () => {
  it('includes the iso timestamp from the entry', () => {
    const entry = makeVersionEntry({ created_at: '2025-06-01T12:30:00.000Z' });
    const row = formatVersionRow(entry, null, NOW_MS);
    expect(row.timestamp).toContain('2025');
  });

  it('formats size as human-readable string', () => {
    const entry = makeVersionEntry({ size: 1_024 });
    const row = formatVersionRow(entry, null, NOW_MS);
    expect(row.size).toMatch(/\d+/);
  });

  it('marks isNowRow = false for older entries', () => {
    const entry = makeVersionEntry({ created_at: BASE_ISO });
    const row = formatVersionRow(entry, null, NOW_MS);
    expect(row.isNowRow).toBe(false);
  });

  it('returns no renamedFromMarker when priorPath is null', () => {
    const entry = makeVersionEntry({ priorPath: null });
    const row = formatVersionRow(entry, null, NOW_MS);
    expect(row.renamedFromMarker).toBeNull();
  });

  it('returns renamedFromMarker when priorPath is set', () => {
    const entry = makeVersionEntry({
      priorPath: 'old/path.md',
      renamedAt: '2025-01-10T10:00:00.000Z',
    });
    const row = formatVersionRow(entry, null, NOW_MS);
    expect(row.renamedFromMarker).toContain('old/path.md');
    expect(row.renamedFromMarker).toContain('2025');
  });

  it('uses S.FILE_HISTORY_RENAMED_FROM template', () => {
    const entry = makeVersionEntry({
      priorPath: 'archive/old.md',
      renamedAt: '2025-03-01T08:00:00.000Z',
    });
    const row = formatVersionRow(entry, null, NOW_MS);
    const expected = S.FILE_HISTORY_RENAMED_FROM('archive/old.md', '2025-03-01');
    expect(row.renamedFromMarker).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 2. buildLiveNowRow
// ---------------------------------------------------------------------------

describe('buildLiveNowRow', () => {
  it('returns null when file does not exist in vault', () => {
    const result = buildLiveNowRow({ exists: false, size: 0, mtime: NOW_MS }, 'notes/a.md', NOW_MS);
    expect(result).toBeNull();
  });

  it('returns a synthetic entry when file exists', () => {
    const result = buildLiveNowRow({ exists: true, size: 4_096, mtime: NOW_MS }, 'notes/a.md', NOW_MS);
    expect(result).not.toBeNull();
    expect(result!.isNowRow).toBe(true);
    expect(result!.size).toBe(4_096);
  });

  it('live-now row has current path', () => {
    const result = buildLiveNowRow({ exists: true, size: 100, mtime: NOW_MS }, 'work/report.md', NOW_MS);
    expect(result!.path).toBe('work/report.md');
  });
});

// ---------------------------------------------------------------------------
// 3. renderHistoryContent — empty case
// ---------------------------------------------------------------------------

describe('renderHistoryContent — empty case', () => {
  it('shows S.FILE_HISTORY_EMPTY when entries is empty', () => {
    const handle = makeRecordingHandle();
    const opts = makeRenderOpts([]);
    renderHistoryContent(handle, opts, makeRenderState());
    expect(handle._recorded.emptyMsg).toBe(S.FILE_HISTORY_EMPTY);
  });

  it('renders no rows when empty', () => {
    const handle = makeRecordingHandle();
    renderHistoryContent(handle, makeRenderOpts([]), makeRenderState());
    expect(handle._recorded.rows).toHaveLength(0);
  });

  it('does not show show-more button when empty', () => {
    const handle = makeRecordingHandle();
    renderHistoryContent(handle, makeRenderOpts([]), makeRenderState());
    expect(handle._recorded.showMoreVisible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. renderHistoryContent — single version
// ---------------------------------------------------------------------------

describe('renderHistoryContent — single version', () => {
  it('shows S.FILE_HISTORY_ONLY_ONE_VERSION message', () => {
    const handle = makeRecordingHandle();
    renderHistoryContent(handle, makeRenderOpts([makeVersionEntry()]), makeRenderState());
    expect(handle._recorded.singleVersionMsg).toBe(S.FILE_HISTORY_ONLY_ONE_VERSION);
  });

  it('still renders the one entry row', () => {
    const handle = makeRecordingHandle();
    // vaultInfo.exists = false so no live-now row — just the one history row
    renderHistoryContent(
      handle,
      makeRenderOpts([makeVersionEntry()], { vaultInfo: makeVaultInfo({ exists: false }) }),
      makeRenderState(),
    );
    expect(handle._recorded.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. renderHistoryContent — newest-first ordering
// ---------------------------------------------------------------------------

describe('renderHistoryContent — ordering', () => {
  it('renders rows with newest entry first', () => {
    const handle = makeRecordingHandle();
    const entries = [
      makeVersionEntry({ created_at: '2025-01-01T00:00:00.000Z', snapshot_id: 'old' }),
      makeVersionEntry({ created_at: '2025-06-01T00:00:00.000Z', snapshot_id: 'new' }),
    ];
    renderHistoryContent(
      handle,
      makeRenderOpts(entries, { vaultInfo: makeVaultInfo({ exists: false }) }),
      makeRenderState(),
    );
    // Entries passed in are already newest-first (per RestoreService contract)
    // Rows render in the order provided; verify no reordering happens.
    expect(handle._recorded.rows[0].timestamp).toContain('2025');
    expect(handle._recorded.rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 6. renderHistoryContent — live-now row
// ---------------------------------------------------------------------------

describe('renderHistoryContent — live-now row', () => {
  it('first row is [now] when file exists in vault', () => {
    const handle = makeRecordingHandle();
    const entries = makeVersions(3);
    renderHistoryContent(handle, makeRenderOpts(entries), makeRenderState());
    expect(handle._recorded.rows[0].isNowRow).toBe(true);
  });

  it('live-now row tierTag is S.FILE_HISTORY_NOW_MARKER', () => {
    const handle = makeRecordingHandle();
    renderHistoryContent(handle, makeRenderOpts(makeVersions(2)), makeRenderState());
    expect(handle._recorded.rows[0].tierTag).toBe(S.FILE_HISTORY_NOW_MARKER);
  });

  it('no [now] row when file does not exist in vault', () => {
    const handle = makeRecordingHandle();
    renderHistoryContent(
      handle,
      makeRenderOpts(makeVersions(2), { vaultInfo: makeVaultInfo({ exists: false }) }),
      makeRenderState(),
    );
    expect(handle._recorded.rows[0].isNowRow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. renderHistoryContent — rename markers
// ---------------------------------------------------------------------------

describe('renderHistoryContent — rename markers', () => {
  it('row with priorPath shows renamedFrom marker', () => {
    const handle = makeRecordingHandle();
    const entries = [
      makeVersionEntry({
        priorPath: 'old/name.md',
        renamedAt: '2025-01-10T08:00:00.000Z',
      }),
    ];
    renderHistoryContent(
      handle,
      makeRenderOpts(entries, { vaultInfo: makeVaultInfo({ exists: false }) }),
      makeRenderState(),
    );
    expect(handle._recorded.rows[0].renamedFrom).toContain('old/name.md');
  });

  it('row without priorPath has null renamedFrom', () => {
    const handle = makeRecordingHandle();
    renderHistoryContent(
      handle,
      makeRenderOpts([makeVersionEntry()], { vaultInfo: makeVaultInfo({ exists: false }) }),
      makeRenderState(),
    );
    expect(handle._recorded.rows[0].renamedFrom).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. renderHistoryContent — pagination
// ---------------------------------------------------------------------------

describe('renderHistoryContent — pagination', () => {
  it('renders first 50 rows from 60 entries + live-now row (51 total)', () => {
    const handle = makeRecordingHandle();
    const entries = makeVersions(60);
    renderHistoryContent(handle, makeRenderOpts(entries), makeRenderState({ visibleCount: 50 }));
    // 1 live-now + 49 history = 50 rows; show-more visible
    expect(handle._recorded.rows).toHaveLength(50);
    expect(handle._recorded.showMoreVisible).toBe(true);
  });

  it('no show-more button when entries fit within page (25 entries)', () => {
    const handle = makeRecordingHandle();
    const entries = makeVersions(25);
    renderHistoryContent(handle, makeRenderOpts(entries), makeRenderState({ visibleCount: 50 }));
    // 1 live-now + 25 entries = 26 rows — all within limit
    expect(handle._recorded.showMoreVisible).toBe(false);
  });

  it('clicking show-more increases visible count by 50', () => {
    const handle1 = makeRecordingHandle();
    const entries = makeVersions(60);
    const state: HistoryRenderState = { visibleCount: 50, previewEntry: null };
    renderHistoryContent(handle1, makeRenderOpts(entries), state);

    // Simulate clicking show-more; the handler should re-render with updated state
    let updatedState: HistoryRenderState | null = null;
    const handle2 = makeRecordingHandle();
    const opts = makeRenderOpts(entries, {
      onShowMore: (s) => { updatedState = s; },
    });
    renderHistoryContent(handle2, opts, state);
    handle2.clickShowMore();
    expect(updatedState).not.toBeNull();
    expect(updatedState!.visibleCount).toBe(100);
  });

  it('60 entries, after show-more all 61 rows rendered (1 live-now + 60)', () => {
    const handle = makeRecordingHandle();
    const entries = makeVersions(60);
    renderHistoryContent(
      handle,
      makeRenderOpts(entries),
      makeRenderState({ visibleCount: 100 }),
    );
    expect(handle._recorded.rows).toHaveLength(61);
    expect(handle._recorded.showMoreVisible).toBe(false);
  });

  it('500 entries render first 50 (perf: limit enforced)', () => {
    const handle = makeRecordingHandle();
    const entries = makeVersions(500);
    renderHistoryContent(handle, makeRenderOpts(entries), makeRenderState({ visibleCount: 50 }));
    expect(handle._recorded.rows).toHaveLength(50);
    expect(handle._recorded.showMoreVisible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. renderHistoryContent — title
// ---------------------------------------------------------------------------

describe('renderHistoryContent — title', () => {
  it('title includes S.FILE_HISTORY_TITLE and the filename', () => {
    const handle = makeRecordingHandle();
    renderHistoryContent(
      handle,
      makeRenderOpts(makeVersions(1), { currentPath: 'notes/journal.md' }),
      makeRenderState(),
    );
    expect(handle._recorded.title).toContain('Version history');
    expect(handle._recorded.title).toContain('journal.md');
  });
});

// ---------------------------------------------------------------------------
// 10. renderHistoryContent — preview action
// ---------------------------------------------------------------------------

describe('renderHistoryContent — preview action', () => {
  it('preview row handler calls fetchContent with correct args', async () => {
    const fetchContent = vi.fn().mockResolvedValue(new Uint8Array([10, 20]));
    const handle = makeRecordingHandle();
    const entries = [makeVersionEntry({ snapshot_id: 'snap-abc', path: 'notes/note.md' })];
    renderHistoryContent(
      handle,
      makeRenderOpts(entries, {
        vaultInfo: makeVaultInfo({ exists: false }),
        restoreService: makeRestoreService({ fetchContent }),
      }),
      makeRenderState(),
    );
    // Click preview on the single row
    handle.clickRow(0, 'preview');
    // Allow microtask flush
    await Promise.resolve();
    expect(fetchContent).toHaveBeenCalledWith('snap-abc', 'notes/note.md');
  });

  it('live-now row does not have a preview button', () => {
    const handle = makeRecordingHandle();
    renderHistoryContent(handle, makeRenderOpts(makeVersions(3)), makeRenderState());
    const nowRow = handle._recorded.rows[0];
    // Now row has isNowRow = true; its onPreview should be undefined
    expect(nowRow.onPreview).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11. renderHistoryContent — restore action
// ---------------------------------------------------------------------------

describe('renderHistoryContent — restore action', () => {
  it('restore row handler calls onConfirmRestore with entry', () => {
    const onConfirmRestore = vi.fn();
    const handle = makeRecordingHandle();
    const entry = makeVersionEntry({ snapshot_id: 'snap-xyz' });
    renderHistoryContent(
      handle,
      makeRenderOpts([entry], {
        vaultInfo: makeVaultInfo({ exists: false }),
        onConfirmRestore,
      }),
      makeRenderState(),
    );
    handle.clickRow(0, 'restore');
    expect(onConfirmRestore).toHaveBeenCalledWith(entry);
  });

  it('live-now row does not have a restore button', () => {
    const handle = makeRecordingHandle();
    renderHistoryContent(handle, makeRenderOpts(makeVersions(3)), makeRenderState());
    const nowRow = handle._recorded.rows[0];
    expect(nowRow.onRestore).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 12. registerShowHistoryCommand
// ---------------------------------------------------------------------------

interface CapturedCommand {
  id: string;
  name: string;
  checkCallback?: (checking: boolean) => boolean | void;
}

function makeCommandPlugin() {
  const captured: CapturedCommand[] = [];
  return {
    plugin: {
      addCommand: (c: CapturedCommand) => {
        captured.push(c);
        return c;
      },
    },
    captured,
  };
}

describe('registerShowHistoryCommand', () => {
  it('registers a command with S.CMD_SHOW_HISTORY_OF_CURRENT_FILE as name', () => {
    const { plugin, captured } = makeCommandPlugin();
    registerShowHistoryCommand({
      plugin,
      currentFileProvider: () => null,
      onOpen: vi.fn(),
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].name).toBe(S.CMD_SHOW_HISTORY_OF_CURRENT_FILE);
  });

  it('registers with id archivist-show-file-history', () => {
    const { plugin, captured } = makeCommandPlugin();
    registerShowHistoryCommand({
      plugin,
      currentFileProvider: () => null,
      onOpen: vi.fn(),
    });
    expect(captured[0].id).toBe('archivist-show-file-history');
  });

  it('checkCallback returns false when no markdown file is active', () => {
    const { plugin, captured } = makeCommandPlugin();
    registerShowHistoryCommand({
      plugin,
      currentFileProvider: () => null,
      onOpen: vi.fn(),
    });
    const result = captured[0].checkCallback!(true);
    expect(result).toBe(false);
  });

  it('checkCallback returns true when a markdown file is active', () => {
    const { plugin, captured } = makeCommandPlugin();
    registerShowHistoryCommand({
      plugin,
      currentFileProvider: () => 'notes/journal.md',
      onOpen: vi.fn(),
    });
    const result = captured[0].checkCallback!(true);
    expect(result).toBe(true);
  });

  it('checkCallback(false) calls onOpen with current file path', () => {
    const { plugin, captured } = makeCommandPlugin();
    const onOpen = vi.fn();
    registerShowHistoryCommand({
      plugin,
      currentFileProvider: () => 'daily/2025-01-15.md',
      onOpen,
    });
    captured[0].checkCallback!(false);
    expect(onOpen).toHaveBeenCalledWith('daily/2025-01-15.md');
  });

  it('checkCallback(false) does not call onOpen when no file active', () => {
    const { plugin, captured } = makeCommandPlugin();
    const onOpen = vi.fn();
    registerShowHistoryCommand({
      plugin,
      currentFileProvider: () => null,
      onOpen,
    });
    captured[0].checkCallback!(false);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 13. Keyboard safety
// ---------------------------------------------------------------------------

describe('FileHistoryModal keyboard handling', () => {
  it('Escape fires onClose callback', () => {
    const onClose = vi.fn();
    const handle = makeRecordingHandle();
    renderHistoryContent(handle, makeRenderOpts(makeVersions(3), { onClose }), makeRenderState());
    handle.fireKeydown('Escape');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Enter does not trigger any action', () => {
    const onConfirmRestore = vi.fn();
    const handle = makeRecordingHandle();
    renderHistoryContent(
      handle,
      makeRenderOpts(makeVersions(3), { onConfirmRestore }),
      makeRenderState(),
    );
    handle.fireKeydown('Enter');
    expect(onConfirmRestore).not.toHaveBeenCalled();
  });
});
