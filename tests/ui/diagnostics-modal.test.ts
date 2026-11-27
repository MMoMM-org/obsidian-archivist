// #143 — DiagnosticsModal: pure report builder + render over a ModalHandle.

import { describe, expect, it, vi } from 'vitest';
import {
  buildDiagnosticsReport,
  chainDepthFromIndex,
  renderDiagnosticsContent,
  type DiagnosticsInput,
} from '../../src/ui/DiagnosticsModal';
import type { ModalHandle } from '../../src/ui/ConfirmRestoreModal';
import type { SnapshotIndexEntry } from '../../src/model/SnapshotIndex';
import { DEFAULT_SETTINGS } from '../../src/model/Settings';
import { S } from '../../src/ui/strings';

function entry(id: string, type: 'full' | 'inc', parent: string | null, hashes = 0): SnapshotIndexEntry {
  return {
    id,
    type,
    parent_id: parent,
    created_at: '2026-11-27T10:00:00.000Z',
    device_id: 'd0',
    blob_hashes: Array.from({ length: hashes }, (_, i) => `h${i}`),
  };
}

// full ← inc1 ← inc2 ← inc3
const chain = [
  entry('full', 'full', null, 5),
  entry('inc1', 'inc', 'full', 1),
  entry('inc2', 'inc', 'inc1', 1),
  entry('inc3', 'inc', 'inc2', 1),
];

function makeInput(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    generatedAt: Date.UTC(2026, 10, 27, 14, 0),
    pluginVersion: '0.13.2',
    fsmState: 'READY',
    lastFull: { id: 'full', commitAt: '2026-11-22T02:40:00.000Z' },
    lastInc: { id: 'inc3', commitAt: '2026-11-27T10:27:00.000Z' },
    nextScheduledFullAt: Date.UTC(2026, 10, 29, 2, 0),
    catchupPending: false,
    skippedCycleAt: null,
    lastError: null,
    snapshots: chain,
    manifestCache: { cached: 12, max: 50, hits: 30, misses: 12 },
    progress: null,
    settings: DEFAULT_SETTINGS,
    ...overrides,
  };
}

describe('chainDepthFromIndex', () => {
  it('counts incs back to the FULL', () => {
    expect(chainDepthFromIndex(chain, 'inc3')).toEqual({ depth: 3, complete: true });
  });

  it('is 0 when the start is the FULL itself or there is no start', () => {
    expect(chainDepthFromIndex(chain, 'full')).toEqual({ depth: 0, complete: true });
    expect(chainDepthFromIndex(chain, null)).toEqual({ depth: 0, complete: true });
  });

  it('flags an incomplete chain when a link is missing from the index', () => {
    const gap = chain.filter((s) => s.id !== 'inc1');
    expect(chainDepthFromIndex(gap, 'inc3')).toEqual({ depth: 2, complete: false });
  });

  it('stops on a cycle instead of looping', () => {
    const cyclic = [entry('a', 'inc', 'b'), entry('b', 'inc', 'a')];
    expect(chainDepthFromIndex(cyclic, 'a')).toEqual({ depth: 2, complete: false });
  });
});

describe('buildDiagnosticsReport', () => {
  it('reports backup state, chain depth, snapshot counts and cache stats', () => {
    const report = buildDiagnosticsReport(makeInput());
    expect(report).toContain('plugin version: 0.13.2');
    expect(report).toContain('scheduler state: READY');
    expect(report).toContain('last full: full (committed 2026-11-22T02:40:00.000Z)');
    expect(report).toContain('chain depth since last full: 3');
    expect(report).toContain('next scheduled full: 2026-11-29T02:00:00.000Z');
    expect(report).toContain('catch-up pending: no');
    expect(report).toContain('snapshots: 4 (full 1, inc 3)');
    expect(report).toContain('blob hash references in index: 8');
    expect(report).toContain('manifest cache: 12/50 cached, 30 hits, 12 misses');
    expect(report).toContain('running backup: none');
    expect(report).toContain('last error: none');
  });

  it('says the index is unknown instead of failing when it could not be loaded', () => {
    const report = buildDiagnosticsReport(makeInput({ snapshots: null }));
    expect(report).toContain('chain depth since last full: unknown (snapshot index not loaded)');
    expect(report).toContain('snapshots: unknown (snapshot index not loaded)');
  });

  it('includes a running backup and the last error code without its message', () => {
    const report = buildDiagnosticsReport(makeInput({
      progress: { kind: 'full', phase: 'uploading', current: 500, total: 6041, startedAtMs: Date.UTC(2026, 10, 27, 12, 0) },
      lastError: { code: 'NETWORK', kind: 'inc', at: Date.UTC(2026, 10, 27, 11, 0) },
    }));
    expect(report).toContain('running backup: full, uploading 500/6041, started 2026-11-27T12:00:00.000Z');
    expect(report).toContain('last error: NETWORK (inc, 2026-11-27T11:00:00.000Z)');
  });
});

describe('renderDiagnosticsContent', () => {
  function makeHandle(): ModalHandle & { title: string; lines: string[]; buttons: Map<string, () => void>; closed: number; key(k: string): void } {
    const keyHandlers: Array<(k: string) => void> = [];
    const h = {
      title: '',
      lines: [] as string[],
      buttons: new Map<string, () => void>(),
      closed: 0,
      setTitle(t: string) { h.title = t; },
      setBody() {},
      addLine(l: string) { h.lines.push(l); },
      addButton(label: string, _d: boolean, onClick: () => void) { h.buttons.set(label, onClick); },
      close() { h.closed += 1; },
      onKeydown(fn: (k: string) => void) { keyHandlers.push(fn); },
      key(k: string) { for (const fn of keyHandlers) fn(k); },
    };
    return h;
  }

  it('renders the report lines and copies the full report', () => {
    const input = makeInput();
    const onCopy = vi.fn();
    const h = makeHandle();

    renderDiagnosticsContent(h, { input, onCopy });

    expect(h.title).toBe(S.DIAGNOSTICS_TITLE);
    expect(h.lines).toContain('chain depth since last full: 3');
    h.buttons.get(S.DIAGNOSTICS_COPY)!();
    expect(onCopy).toHaveBeenCalledWith(buildDiagnosticsReport(input));
  });

  it('closes on the Close button and on Escape', () => {
    const h = makeHandle();
    renderDiagnosticsContent(h, { input: makeInput(), onCopy: vi.fn() });
    h.buttons.get(S.DIAGNOSTICS_CLOSE)!();
    h.key('Escape');
    expect(h.closed).toBe(2);
  });
});
