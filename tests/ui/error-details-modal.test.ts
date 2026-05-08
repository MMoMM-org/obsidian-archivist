// ErrorDetailsModal — pure-render tests for the status-bar error dialog.
//
// Mirrors the recording-handle pattern from adopt-vault-modal.test.ts. The
// Modal subclass itself wires Obsidian internals; this file only covers the
// pure render contract used by both the subclass and any future test
// harness.

import { describe, expect, it, vi } from 'vitest';
import {
  buildErrorReport,
  renderErrorDetailsContent,
  type ErrorDetailsModalOpts,
  type ErrorDetailsRecord,
} from '../../src/ui/ErrorDetailsModal';
import type { ModalHandle } from '../../src/ui/ConfirmRestoreModal';
import { S } from '../../src/ui/strings';

interface RecordedButton {
  label: string;
  isDefault: boolean;
  onClick: () => void;
}

interface RecordedContent {
  title: string;
  body: string;
  extraLines: string[];
  buttons: RecordedButton[];
}

function makeRecordingHandle(): ModalHandle & {
  recorded: RecordedContent;
  fireKeydown(key: string): void;
  clickButton(label: string): void;
  closedCount(): number;
} {
  const recorded: RecordedContent = { title: '', body: '', extraLines: [], buttons: [] };
  let closedCount = 0;
  const keydownHandlers: Array<(key: string) => void> = [];
  return {
    setTitle(t) { recorded.title = t; },
    setBody(b) { recorded.body = b; },
    addLine(l) { recorded.extraLines.push(l); },
    addButton(label, isDefault, onClick) {
      recorded.buttons.push({ label, isDefault, onClick });
    },
    close() { closedCount += 1; },
    onKeydown(h) { keydownHandlers.push(h); },
    recorded,
    fireKeydown(key) { for (const h of keydownHandlers) h(key); },
    clickButton(label) {
      const btn = recorded.buttons.find((b) => b.label === label);
      if (!btn) throw new Error(`button ${label} not rendered`);
      btn.onClick();
    },
    closedCount() { return closedCount; },
  };
}

const fixedTime = new Date('2026-05-08T11:33:00Z').getTime();

const sampleError: ErrorDetailsRecord = {
  code: 'NETWORK',
  message: 'getaddrinfo ENOTFOUND api.dropboxapi.com',
  stack: 'Error: getaddrinfo ENOTFOUND api.dropboxapi.com\n    at upload (BackupService.ts:512)',
  at: fixedTime,
  kind: 'full',
};

function makeOpts(overrides?: Partial<ErrorDetailsModalOpts>): ErrorDetailsModalOpts {
  return {
    lastError: sampleError,
    formatTimestamp: () => '2026-05-08 11:33',
    onOpenSettings: vi.fn(),
    onCopy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('renderErrorDetailsContent', () => {
  it('renders the standard title for both populated and empty cases', () => {
    const populated = makeRecordingHandle();
    renderErrorDetailsContent(populated, makeOpts());
    expect(populated.recorded.title).toBe(S.ERROR_DETAILS_TITLE);

    const empty = makeRecordingHandle();
    renderErrorDetailsContent(empty, makeOpts({ lastError: null }));
    expect(empty.recorded.title).toBe(S.ERROR_DETAILS_TITLE);
  });

  it('shows the actual error message in the body — not a generic fallback', () => {
    const handle = makeRecordingHandle();
    renderErrorDetailsContent(handle, makeOpts());
    expect(handle.recorded.body).toContain('getaddrinfo ENOTFOUND api.dropboxapi.com');
  });

  it('exposes structured context (kind / code / time) as labelled lines', () => {
    const handle = makeRecordingHandle();
    renderErrorDetailsContent(handle, makeOpts());
    const joined = handle.recorded.extraLines.join('\n');
    expect(joined).toContain(`${S.ERROR_DETAILS_LABEL_KIND}: full`);
    expect(joined).toContain(`${S.ERROR_DETAILS_LABEL_CODE}: NETWORK`);
    expect(joined).toContain(`${S.ERROR_DETAILS_LABEL_TIME}: 2026-05-08 11:33`);
  });

  it('shows the no-error notice and only Open-Settings + Close buttons when lastError is null', () => {
    const handle = makeRecordingHandle();
    renderErrorDetailsContent(handle, makeOpts({ lastError: null }));
    expect(handle.recorded.body).toBe(S.ERROR_DETAILS_NO_ERROR);
    const labels = handle.recorded.buttons.map((b) => b.label);
    expect(labels).toEqual([S.ERROR_DETAILS_OPEN_SETTINGS, S.ERROR_DETAILS_CLOSE]);
  });

  it('Close is the default button so Enter dismisses without side effects', () => {
    const handle = makeRecordingHandle();
    renderErrorDetailsContent(handle, makeOpts());
    const close = handle.recorded.buttons.find((b) => b.label === S.ERROR_DETAILS_CLOSE);
    const open = handle.recorded.buttons.find((b) => b.label === S.ERROR_DETAILS_OPEN_SETTINGS);
    const copy = handle.recorded.buttons.find((b) => b.label === S.ERROR_DETAILS_COPY);
    expect(close?.isDefault).toBe(true);
    expect(open?.isDefault).toBe(false);
    expect(copy?.isDefault).toBe(false);
  });

  it('clicking Open-Settings fires onOpenSettings and closes', () => {
    const onOpenSettings = vi.fn();
    const handle = makeRecordingHandle();
    renderErrorDetailsContent(handle, makeOpts({ onOpenSettings }));
    handle.clickButton(S.ERROR_DETAILS_OPEN_SETTINGS);
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(handle.closedCount()).toBe(1);
  });

  it('clicking Copy fires onCopy with a multi-line report and does not close the modal', () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    const handle = makeRecordingHandle();
    renderErrorDetailsContent(handle, makeOpts({ onCopy }));
    handle.clickButton(S.ERROR_DETAILS_COPY);
    expect(onCopy).toHaveBeenCalledOnce();
    const report = onCopy.mock.calls[0][0] as string;
    expect(report).toContain('NETWORK');
    expect(report).toContain('getaddrinfo ENOTFOUND api.dropboxapi.com');
    expect(report).toContain('BackupService.ts:512');
    // Copy is a non-destructive action; modal stays open so the user can
    // paste the report and read it before deciding what to do next.
    expect(handle.closedCount()).toBe(0);
  });

  it('Escape key closes the modal', () => {
    const handle = makeRecordingHandle();
    renderErrorDetailsContent(handle, makeOpts());
    handle.fireKeydown('Escape');
    expect(handle.closedCount()).toBe(1);
  });
});

describe('buildErrorReport', () => {
  it('includes time, kind, code, and message', () => {
    const report = buildErrorReport(sampleError);
    expect(report).toContain('time: ');
    expect(report).toContain('kind: full');
    expect(report).toContain('code: NETWORK');
    expect(report).toContain('message: getaddrinfo ENOTFOUND api.dropboxapi.com');
  });

  it('appends the stack when present', () => {
    const report = buildErrorReport(sampleError);
    expect(report).toContain('stack:');
    expect(report).toContain('BackupService.ts:512');
  });

  it('omits the stack section when stack is null', () => {
    const report = buildErrorReport({ ...sampleError, stack: null });
    expect(report).not.toContain('stack:');
  });
});
