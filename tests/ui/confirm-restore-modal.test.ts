// T9.3 — ConfirmRestoreModal: destructive-action safety, keyboard guard,
// dir-creation variant.
//
// All tests use a recording ModalHandle to fire keyboard events and assert
// rendered content without needing real Obsidian or a browser.
// renderConfirmRestoreContent() is called directly with the recording handle —
// same logic that ConfirmRestoreModal.onOpen() exercises in production.

import { describe, expect, it, vi } from 'vitest';
import {
  type ConfirmRestoreOpts,
  type ModalHandle,
  renderConfirmRestoreContent,
} from '../../src/ui/ConfirmRestoreModal';
import { S } from '../../src/ui/strings';

// ---------------------------------------------------------------------------
// Recording ModalHandle — test-internal
// ---------------------------------------------------------------------------

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
  _closed: boolean;
  _keydownHandlers: Array<(key: string) => void>;
  recorded: RecordedContent;
  fireKeydown(key: string): void;
  clickButton(label: string): void;
} {
  const recorded: RecordedContent = {
    title: '',
    body: '',
    extraLines: [],
    buttons: [],
  };

  let closedCount = 0;
  const keydownHandlers: Array<(key: string) => void> = [];

  return {
    get _closed() {
      return closedCount > 0;
    },
    get _keydownHandlers() {
      return keydownHandlers;
    },
    recorded,

    // ModalHandle interface
    setTitle(title: string) {
      recorded.title = title;
    },
    setBody(body: string) {
      recorded.body = body;
    },
    addLine(line: string) {
      recorded.extraLines.push(line);
    },
    addButton(label: string, isDefault: boolean, onClick: () => void) {
      recorded.buttons.push({ label, isDefault, onClick });
    },
    close() {
      closedCount += 1;
    },
    onKeydown(handler: (key: string) => void) {
      keydownHandlers.push(handler);
    },

    // Test driver helpers
    fireKeydown(key: string) {
      for (const h of keydownHandlers) h(key);
    },
    clickButton(label: string) {
      const btn = recorded.buttons.find((b) => b.label === label);
      if (!btn) throw new Error(`Button "${label}" not found`);
      btn.onClick();
    },
  };
}

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

function makeInPlaceParams(overrides: Partial<ConfirmRestoreOpts> = {}): ConfirmRestoreOpts {
  return {
    filePath: 'notes/journal/2025-01-15.md',
    timestamp: '2025-01-15 14:30',
    size: '12 KB',
    missingDirs: [],
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

function makeCreatesDirParams(overrides: Partial<ConfirmRestoreOpts> = {}): ConfirmRestoreOpts {
  return makeInPlaceParams({
    missingDirs: ['notes', 'notes/journal'],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openModal(params: ConfirmRestoreOpts): {
  handle: ReturnType<typeof makeRecordingHandle>;
} {
  const handle = makeRecordingHandle();
  renderConfirmRestoreContent(handle, params);
  return { handle };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConfirmRestoreModal — in-place variant', () => {
  it('sets title to S.CONFIRM_RESTORE_IN_PLACE_TITLE', () => {
    const { handle } = openModal(makeInPlaceParams());
    expect(handle.recorded.title).toBe(S.CONFIRM_RESTORE_IN_PLACE_TITLE);
  });

  it('body contains exact S.CONFIRM_RESTORE_IN_PLACE_BODY copy', () => {
    const params = makeInPlaceParams();
    const { handle } = openModal(params);
    const expected = S.CONFIRM_RESTORE_IN_PLACE_BODY(params.filePath, params.timestamp, params.size);
    expect(handle.recorded.body).toBe(expected);
  });

  it('body includes the file path', () => {
    const params = makeInPlaceParams({ filePath: 'work/report.md' });
    const { handle } = openModal(params);
    expect(handle.recorded.body).toContain('work/report.md');
  });

  it('body includes the snapshot timestamp', () => {
    const params = makeInPlaceParams({ timestamp: '2024-06-01 09:00' });
    const { handle } = openModal(params);
    expect(handle.recorded.body).toContain('2024-06-01 09:00');
  });

  it('body includes the size', () => {
    const params = makeInPlaceParams({ size: '256 KB' });
    const { handle } = openModal(params);
    expect(handle.recorded.body).toContain('256 KB');
  });

  it('has exactly two buttons: Cancel and Replace', () => {
    const { handle } = openModal(makeInPlaceParams());
    const labels = handle.recorded.buttons.map((b) => b.label);
    expect(labels).toHaveLength(2);
    expect(labels).toContain(S.CONFIRM_RESTORE_IN_PLACE_CANCEL);
    expect(labels).toContain(S.CONFIRM_RESTORE_IN_PLACE_OK);
  });

  it('Cancel is the default button (not Replace)', () => {
    const { handle } = openModal(makeInPlaceParams());
    const cancelBtn = handle.recorded.buttons.find(
      (b) => b.label === S.CONFIRM_RESTORE_IN_PLACE_CANCEL,
    );
    const replaceBtn = handle.recorded.buttons.find(
      (b) => b.label === S.CONFIRM_RESTORE_IN_PLACE_OK,
    );
    expect(cancelBtn?.isDefault).toBe(true);
    expect(replaceBtn?.isDefault).toBe(false);
  });
});

describe('ConfirmRestoreModal — creates-dir variant', () => {
  it('uses CONFIRM_RESTORE_CREATES_DIR_TITLE when dirs are missing', () => {
    const { handle } = openModal(makeCreatesDirParams());
    expect(handle.recorded.title).toBe(S.CONFIRM_RESTORE_CREATES_DIR_TITLE);
  });

  it('body contains S.CONFIRM_RESTORE_CREATES_DIR_BODY with dirs listed', () => {
    const params = makeCreatesDirParams({ missingDirs: ['notes', 'notes/journal'] });
    const { handle } = openModal(params);
    const expected = S.CONFIRM_RESTORE_CREATES_DIR_BODY(
      params.filePath,
      params.timestamp,
      params.size,
      'notes, notes/journal',
    );
    expect(handle.recorded.body).toBe(expected);
  });

  it('lists each missing directory in extra lines', () => {
    const params = makeCreatesDirParams({ missingDirs: ['notes', 'notes/journal'] });
    const { handle } = openModal(params);
    expect(handle.recorded.extraLines).toContain('notes');
    expect(handle.recorded.extraLines).toContain('notes/journal');
  });

  it('Cancel is still the default in creates-dir variant', () => {
    const { handle } = openModal(makeCreatesDirParams());
    const cancelBtn = handle.recorded.buttons.find(
      (b) => b.label === S.CONFIRM_RESTORE_CREATES_DIR_CANCEL,
    );
    expect(cancelBtn?.isDefault).toBe(true);
  });
});

describe('ConfirmRestoreModal — keyboard safety', () => {
  it('Escape fires onCancel and closes', () => {
    const onCancel = vi.fn();
    const { handle } = openModal(makeInPlaceParams({ onCancel }));
    handle.fireKeydown('Escape');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(handle._closed).toBe(true);
  });

  it('Enter does NOT call onConfirm (Replace is not the Enter default)', () => {
    const onConfirm = vi.fn();
    const { handle } = openModal(makeInPlaceParams({ onConfirm }));
    handle.fireKeydown('Enter');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(handle._closed).toBe(false);
  });

  it('Enter does NOT call onCancel either', () => {
    const onCancel = vi.fn();
    const { handle } = openModal(makeInPlaceParams({ onCancel }));
    handle.fireKeydown('Enter');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Tab key has no effect on callbacks', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { handle } = openModal(makeInPlaceParams({ onConfirm, onCancel }));
    handle.fireKeydown('Tab');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('ConfirmRestoreModal — confirm / cancel callbacks', () => {
  it('clicking Replace calls onConfirm then closes', () => {
    const onConfirm = vi.fn();
    const { handle } = openModal(makeInPlaceParams({ onConfirm }));
    handle.clickButton(S.CONFIRM_RESTORE_IN_PLACE_OK);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(handle._closed).toBe(true);
  });

  it('clicking Cancel calls onCancel then closes', () => {
    const onCancel = vi.fn();
    const { handle } = openModal(makeInPlaceParams({ onCancel }));
    handle.clickButton(S.CONFIRM_RESTORE_IN_PLACE_CANCEL);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(handle._closed).toBe(true);
  });

  it('clicking Replace closes the modal', () => {
    const { handle } = openModal(makeInPlaceParams());
    handle.clickButton(S.CONFIRM_RESTORE_IN_PLACE_OK);
    expect(handle._closed).toBe(true);
  });

  it('clicking Cancel closes the modal', () => {
    const { handle } = openModal(makeInPlaceParams());
    handle.clickButton(S.CONFIRM_RESTORE_IN_PLACE_CANCEL);
    expect(handle._closed).toBe(true);
  });

  it('Escape closes the modal', () => {
    const { handle } = openModal(makeInPlaceParams());
    handle.fireKeydown('Escape');
    expect(handle._closed).toBe(true);
  });
});

describe('ConfirmRestoreModal — single-dir missing edge case', () => {
  it('handles a single missing directory', () => {
    const params = makeCreatesDirParams({ missingDirs: ['archive'] });
    const { handle } = openModal(params);
    const expected = S.CONFIRM_RESTORE_CREATES_DIR_BODY(
      params.filePath,
      params.timestamp,
      params.size,
      'archive',
    );
    expect(handle.recorded.body).toBe(expected);
    expect(handle.recorded.extraLines).toContain('archive');
  });
});
