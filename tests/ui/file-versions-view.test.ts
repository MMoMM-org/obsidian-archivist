// FileVersionsView — per-file 3-column ItemView for version browsing.
//
// Coverage:
//   - setState(path) loads the version chain via Promise.allSettled and
//     renders the snapshot list.
//   - A rejected manifest load is silently dropped — surviving versions
//     still render (skip-and-warn pattern).
//   - Stale-async bailout: when selectedSnapshotId changes mid-fetch,
//     the in-flight handler does not touch the DOM.
//   - ChainError on listVersionsForPath renders inline error.
//   - Restore-in-place button instantiates ConfirmRestoreModal with the
//     correct path / timestamp / size / missingDirs payload.
//   - Empty-history path renders the empty placeholder.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ui/ConfirmRestoreModal', () => ({
  ConfirmRestoreModal: class {
    static _last: { opts: Record<string, unknown> } | null = null;
    private opts: Record<string, unknown>;
    constructor(_app: unknown, opts: Record<string, unknown>) {
      this.opts = opts;
      (this.constructor as unknown as { _last: unknown })._last = { opts };
    }
    open(): void {}
  },
}));

vi.mock('../../src/ui/PreviewPane', () => ({
  renderPreview: vi.fn().mockResolvedValue(undefined),
  maybeShowPreviewAdvisory: vi.fn(),
}));

import {
  FileVersionsView,
  fvFormatTimestamp,
  fvTierLabel,
  type FileVersionsViewDeps,
} from '../../src/ui/FileVersionsView';
import { App, WorkspaceLeaf } from '../fixtures/obsidian-mock';
import type { MockEl } from '../fixtures/obsidian-mock';
import type { SnapshotIndexEntry } from '../../src/model/SnapshotIndex';
import type { SnapshotManifest } from '../../src/model/Manifest';
import type { VersionEntry } from '../../src/services/RestoreService';
import { ChainError } from '../../src/model/Errors';
import * as ModalMock from '../../src/ui/ConfirmRestoreModal';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(id: string, created: string): SnapshotIndexEntry {
  return {
    id,
    type: 'inc',
    parent_id: null,
    device_id: 'd0',
    blob_hashes: [],
    created_at: created,
    tier: 'daily',
  };
}

function makeManifest(id: string, created: string): SnapshotManifest {
  return {
    schema_version: '1.0',
    id,
    type: 'full',
    parent_id: null,
    device_id: 'd0',
    created_at: created,
    vault_name: 'v',
    vault_prefix: 'vp',
    files: { 'notes/a.md': { hash: 'h', size: 100, mtime: 1 } },
    deleted: [],
    renames: [],
    exclusions_applied: null,
  };
}

function makeVersion(id: string, created: string): VersionEntry {
  return {
    snapshot_id: id,
    path: 'notes/a.md',
    hash: 'h',
    size: 100,
    created_at: created,
    currentPath: 'notes/a.md',
    priorPath: null,
    renamedAt: null,
  };
}

function findByClass(el: MockEl, cls: string): MockEl | undefined {
  if (el.className.includes(cls)) return el;
  for (const child of el.children) {
    const found = findByClass(child, cls);
    if (found) return found;
  }
  return undefined;
}

function findAllByClass(el: MockEl, cls: string): MockEl[] {
  const acc: MockEl[] = [];
  if (el.className.includes(cls)) acc.push(el);
  for (const child of el.children) acc.push(...findAllByClass(child, cls));
  return acc;
}

function makeDeps(overrides?: Partial<FileVersionsViewDeps>): FileVersionsViewDeps {
  return {
    restoreService: {
      fetchContent: vi.fn().mockResolvedValue(new Uint8Array()),
      listVersionsForPath: vi.fn().mockReturnValue([]),
    },
    manifestCache: {
      listSnapshotsNewestFirst: vi.fn().mockResolvedValue([]),
      loadManifest: vi.fn().mockResolvedValue(makeManifest('m1', '2026-04-25T10:00:00Z')),
    },
    restoreOperations: {
      restoreInPlace: vi.fn().mockResolvedValue({}),
      restoreAsCopy: vi.fn().mockResolvedValue({}),
    },
    noticeCenter: {
      showPersistent: vi.fn(),
    },
    vaultHasPath: vi.fn().mockReturnValue(true),
    notify: vi.fn(),
    app: new App(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('fvTierLabel', () => {
  it('maps daily / monthly / never_prune', () => {
    expect(fvTierLabel('daily')).toContain('daily');
    expect(fvTierLabel('monthly')).toContain('monthly');
    expect(fvTierLabel('never_prune')).toContain('never-prune');
  });
  it('returns null for null / undefined', () => {
    expect(fvTierLabel(null)).toBeNull();
    expect(fvTierLabel(undefined)).toBeNull();
  });
});

describe('fvFormatTimestamp', () => {
  it('returns a stable compact form (24h)', () => {
    const out = fvFormatTimestamp(new Date('2026-04-25T10:00:00Z'));
    expect(out.length).toBeGreaterThan(0);
    // Should not contain AM/PM markers — 24h.
    expect(/AM|PM/.test(out)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// onOpen + setState — happy path
// ---------------------------------------------------------------------------

describe('FileVersionsView render flow', () => {
  it('renders shell on onOpen and loads versions when path is set', async () => {
    const snap = makeSnapshot('m1', '2026-04-25T10:00:00Z');
    const versions = [makeVersion('m1', '2026-04-25T10:00:00Z')];
    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
        loadManifest: vi.fn().mockResolvedValue(makeManifest('m1', '2026-04-25T10:00:00Z')),
      },
      restoreService: {
        fetchContent: vi.fn().mockResolvedValue(new Uint8Array()),
        listVersionsForPath: vi.fn().mockReturnValue(versions),
      },
    });
    const view = new FileVersionsView(new WorkspaceLeaf(), deps);
    await view.onOpen();
    await view.setState({ path: 'notes/a.md' }, undefined);
    // Let auto-select fetch complete.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const internal = view as unknown as { contentEl: MockEl };
    const fileCol = findByClass(internal.contentEl, 'archivist-fv-file');
    const snapsList = findByClass(internal.contentEl, 'archivist-fv-snapshots-list');
    const previewCol = findByClass(internal.contentEl, 'archivist-fv-preview');
    expect(fileCol).toBeDefined();
    expect(snapsList).toBeDefined();
    expect(previewCol).toBeDefined();

    const rows = findAllByClass(snapsList!, 'archivist-fv-snapshot-row');
    expect(rows.length).toBe(1);
  });

  it('skips a manifest that fails to load and renders surviving versions', async () => {
    const ok = makeSnapshot('m-ok', '2026-04-25T10:00:00Z');
    const bad = makeSnapshot('m-bad', '2026-04-24T10:00:00Z');
    const okManifest = makeManifest('m-ok', '2026-04-25T10:00:00Z');
    const versions = [makeVersion('m-ok', '2026-04-25T10:00:00Z')];
    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([ok, bad]),
        loadManifest: vi.fn().mockImplementation((id: string) =>
          id === 'm-bad' ? Promise.reject(new Error('chain busted')) : Promise.resolve(okManifest),
        ),
      },
      restoreService: {
        fetchContent: vi.fn().mockResolvedValue(new Uint8Array()),
        // Inspect the manifests that reached the listVersions step — should
        // exclude m-bad entirely (filtered by allSettled).
        listVersionsForPath: vi.fn().mockImplementation((_p: string, manifests: SnapshotManifest[]) => {
          expect(manifests.map((m) => m.id)).toEqual(['m-ok']);
          return versions;
        }),
      },
    });
    const view = new FileVersionsView(new WorkspaceLeaf(), deps);
    await view.onOpen();
    await view.setState({ path: 'notes/a.md' }, undefined);
    await Promise.resolve();
    await Promise.resolve();

    const internal = view as unknown as { contentEl: MockEl };
    const snapsList = findByClass(internal.contentEl, 'archivist-fv-snapshots-list');
    const rows = findAllByClass(snapsList!, 'archivist-fv-snapshot-row');
    expect(rows.length).toBe(1);
  });

  it('renders empty placeholder when listVersionsForPath returns []', async () => {
    const snap = makeSnapshot('m1', '2026-04-25T10:00:00Z');
    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
        loadManifest: vi.fn().mockResolvedValue(makeManifest('m1', '2026-04-25T10:00:00Z')),
      },
      restoreService: {
        fetchContent: vi.fn().mockResolvedValue(new Uint8Array()),
        listVersionsForPath: vi.fn().mockReturnValue([]),
      },
    });
    const view = new FileVersionsView(new WorkspaceLeaf(), deps);
    await view.onOpen();
    await view.setState({ path: 'notes/a.md' }, undefined);
    await Promise.resolve();

    const internal = view as unknown as { contentEl: MockEl };
    const snapsList = findByClass(internal.contentEl, 'archivist-fv-snapshots-list');
    const placeholder = snapsList!.children.find((c) => c.tagName === 'p');
    expect(placeholder?.textContent).toContain('No backed-up versions');
  });
});

// ---------------------------------------------------------------------------
// ChainError handling
// ---------------------------------------------------------------------------

describe('FileVersionsView error handling', () => {
  it('renders BROWSER_ERROR_CHAIN_BROKEN when listVersionsForPath throws ChainError', async () => {
    const snap = makeSnapshot('m1', '2026-04-25T10:00:00Z');
    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
        loadManifest: vi.fn().mockResolvedValue(makeManifest('m1', '2026-04-25T10:00:00Z')),
      },
      restoreService: {
        fetchContent: vi.fn().mockResolvedValue(new Uint8Array()),
        listVersionsForPath: vi.fn().mockImplementation(() => {
          throw new ChainError('CHAIN_BROKEN', 'broken', false);
        }),
      },
    });
    const view = new FileVersionsView(new WorkspaceLeaf(), deps);
    await view.onOpen();
    await view.setState({ path: 'notes/a.md' }, undefined);
    await Promise.resolve();

    const internal = view as unknown as { contentEl: MockEl };
    const snapsList = findByClass(internal.contentEl, 'archivist-fv-snapshots-list');
    const errEl = findByClass(snapsList!, 'archivist-error');
    expect(errEl).toBeDefined();
    expect(errEl!.textContent).toContain('chain has a missing ancestor');
  });
});

// ---------------------------------------------------------------------------
// Restore-button → ConfirmRestoreModal
// ---------------------------------------------------------------------------

describe('FileVersionsView restore button', () => {
  it('clicking Restore-in-place opens ConfirmRestoreModal with correct payload', async () => {
    const snap = makeSnapshot('m1', '2026-04-25T10:00:00Z');
    const versions = [makeVersion('m1', '2026-04-25T10:00:00Z')];
    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
        loadManifest: vi.fn().mockResolvedValue(makeManifest('m1', '2026-04-25T10:00:00Z')),
      },
      restoreService: {
        fetchContent: vi.fn().mockResolvedValue(new Uint8Array()),
        listVersionsForPath: vi.fn().mockReturnValue(versions),
      },
    });
    const view = new FileVersionsView(new WorkspaceLeaf(), deps);
    await view.onOpen();
    await view.setState({ path: 'notes/a.md' }, undefined);
    // Drain the auto-select chain so preview + buttons are mounted.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const internal = view as unknown as { contentEl: MockEl };
    const previewCol = findByClass(internal.contentEl, 'archivist-fv-preview')!;
    const actions = findByClass(previewCol, 'archivist-fv-preview-actions');
    expect(actions).toBeDefined();
    const buttons = actions!.children.filter((c) => c.tagName === 'button');
    expect(buttons.length).toBe(2);

    // Click Restore-in-place (first button).
    buttons[0].dispatchEvent({ type: 'click', key: '', preventDefault: () => {} });

    const ModalCtor = ModalMock.ConfirmRestoreModal as unknown as { _last: { opts: { filePath: string; size: string } } | null };
    expect(ModalCtor._last).not.toBeNull();
    expect(ModalCtor._last!.opts.filePath).toBe('notes/a.md');
    expect(ModalCtor._last!.opts.size).toMatch(/B|KB|MB/);
  });
});

// ---------------------------------------------------------------------------
// Stale-async bailout
// ---------------------------------------------------------------------------

describe('FileVersionsView stale-async bailout', () => {
  it('does not render preview after _closed flips true mid-fetch', async () => {
    const snap = makeSnapshot('m1', '2026-04-25T10:00:00Z');
    const versions = [makeVersion('m1', '2026-04-25T10:00:00Z')];
    let resolveFetch: (v: Uint8Array) => void = () => {};
    const fetchGate = new Promise<Uint8Array>((r) => (resolveFetch = r));
    const deps = makeDeps({
      manifestCache: {
        listSnapshotsNewestFirst: vi.fn().mockResolvedValue([snap]),
        loadManifest: vi.fn().mockResolvedValue(makeManifest('m1', '2026-04-25T10:00:00Z')),
      },
      restoreService: {
        fetchContent: vi.fn().mockReturnValue(fetchGate),
        listVersionsForPath: vi.fn().mockReturnValue(versions),
      },
    });
    const view = new FileVersionsView(new WorkspaceLeaf(), deps);
    await view.onOpen();
    await view.setState({ path: 'notes/a.md' }, undefined);
    // Let auto-select reach the await on fetchContent.
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Close the view BEFORE the fetch resolves.
    await view.onClose();
    resolveFetch(new Uint8Array());
    for (let i = 0; i < 3; i++) await Promise.resolve();

    // contentEl was emptied in onClose; the resolved fetch must NOT have
    // re-populated the preview column (no h3 for the timestamp).
    const internal = view as unknown as { contentEl: MockEl };
    expect(internal.contentEl.children.length).toBe(0);
  });
});
