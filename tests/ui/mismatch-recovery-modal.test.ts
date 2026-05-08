// MismatchRecoveryModal — pure-render tests for the BLOCKED-state recovery
// dialog. Covers both shapes: 'mismatch' (Adopt button + cancel) and
// 'remote-corrupt' (cancel only, instructional copy).

import { describe, expect, it, vi } from 'vitest';
import {
  renderMismatchRecoveryContent,
  type MismatchRecoveryModalOpts,
  type MismatchRecoveryRecord,
} from '../../src/ui/MismatchRecoveryModal';
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

const mismatchRecord: MismatchRecoveryRecord = {
  kind: 'mismatch',
  localVaultId: '14033243-2186-4868-a986-4944916dc212',
  remoteVaultId: '35dc40d7-24a8-4b53-ae09-50186bdbeee6',
  remoteVaultName: 'Privat',
  rawError: null,
};

const corruptRecord: MismatchRecoveryRecord = {
  kind: 'remote-corrupt',
  localVaultId: '14033243-2186-4868-a986-4944916dc212',
  remoteVaultId: null,
  remoteVaultName: null,
  rawError: 'vault_meta.vault_id: expected UUID v4',
};

function makeOpts(
  record: MismatchRecoveryRecord,
  overrides?: Partial<MismatchRecoveryModalOpts>,
): MismatchRecoveryModalOpts {
  return {
    record,
    onAdoptRemote: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
    ...overrides,
  };
}

describe('renderMismatchRecoveryContent — kind: mismatch', () => {
  it('uses the mismatch title and shows local + remote ids with vault name', () => {
    const handle = makeRecordingHandle();
    renderMismatchRecoveryContent(handle, makeOpts(mismatchRecord));
    expect(handle.recorded.title).toBe(S.MISMATCH_RECOVERY_TITLE_MISMATCH);
    const joined = handle.recorded.extraLines.join('\n');
    expect(joined).toContain('14033243-2186-4868-a986-4944916dc212');
    expect(joined).toContain('35dc40d7-24a8-4b53-ae09-50186bdbeee6');
    expect(joined).toContain('Privat');
  });

  it('renders Adopt + Cancel buttons; Cancel is the safe default', () => {
    const handle = makeRecordingHandle();
    renderMismatchRecoveryContent(handle, makeOpts(mismatchRecord));
    const adopt = handle.recorded.buttons.find((b) => b.label === S.MISMATCH_RECOVERY_ADOPT);
    const cancel = handle.recorded.buttons.find((b) => b.label === S.MISMATCH_RECOVERY_CANCEL);
    expect(adopt?.isDefault).toBe(false);
    expect(cancel?.isDefault).toBe(true);
  });

  it('renders Change-prefix button only when onChangePrefix is provided', () => {
    const withChange = makeRecordingHandle();
    renderMismatchRecoveryContent(
      withChange,
      makeOpts(mismatchRecord, { onChangePrefix: vi.fn() }),
    );
    expect(
      withChange.recorded.buttons.some((b) => b.label === S.MISMATCH_RECOVERY_CHANGE_PREFIX),
    ).toBe(true);

    const withoutChange = makeRecordingHandle();
    renderMismatchRecoveryContent(withoutChange, makeOpts(mismatchRecord));
    expect(
      withoutChange.recorded.buttons.some((b) => b.label === S.MISMATCH_RECOVERY_CHANGE_PREFIX),
    ).toBe(false);
  });

  it('clicking Adopt fires onAdoptRemote and closes the modal afterwards', async () => {
    const onAdoptRemote = vi.fn().mockResolvedValue(undefined);
    const handle = makeRecordingHandle();
    renderMismatchRecoveryContent(handle, makeOpts(mismatchRecord, { onAdoptRemote }));
    handle.clickButton(S.MISMATCH_RECOVERY_ADOPT);
    // onAdoptRemote is async; flush microtasks so the .finally close fires.
    await Promise.resolve();
    await Promise.resolve();
    expect(onAdoptRemote).toHaveBeenCalledOnce();
    expect(handle.closedCount()).toBe(1);
  });

  it('Adopt closes even if onAdoptRemote rejects — error reporting is the caller’s job', async () => {
    const onAdoptRemote = vi.fn().mockRejectedValue(new Error('network'));
    const handle = makeRecordingHandle();
    renderMismatchRecoveryContent(handle, makeOpts(mismatchRecord, { onAdoptRemote }));
    handle.clickButton(S.MISMATCH_RECOVERY_ADOPT);
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.closedCount()).toBe(1);
  });

  it('Cancel fires onCancel and closes; Escape behaves the same', () => {
    const onCancel = vi.fn();
    const onAdoptRemote = vi.fn();
    const handle = makeRecordingHandle();
    renderMismatchRecoveryContent(
      handle,
      makeOpts(mismatchRecord, { onCancel, onAdoptRemote }),
    );
    handle.clickButton(S.MISMATCH_RECOVERY_CANCEL);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onAdoptRemote).not.toHaveBeenCalled();
    expect(handle.closedCount()).toBe(1);

    const handle2 = makeRecordingHandle();
    const onCancel2 = vi.fn();
    renderMismatchRecoveryContent(
      handle2,
      makeOpts(mismatchRecord, { onCancel: onCancel2 }),
    );
    handle2.fireKeydown('Escape');
    expect(onCancel2).toHaveBeenCalledOnce();
    expect(handle2.closedCount()).toBe(1);
  });
});

describe('renderMismatchRecoveryContent — kind: remote-corrupt', () => {
  it('uses the corrupt-meta title and surfaces the schema error verbatim', () => {
    const handle = makeRecordingHandle();
    renderMismatchRecoveryContent(handle, makeOpts(corruptRecord));
    expect(handle.recorded.title).toBe(S.MISMATCH_RECOVERY_TITLE_CORRUPT);
    expect(
      handle.recorded.extraLines.some((l) =>
        l.includes('vault_meta.vault_id: expected UUID v4'),
      ),
    ).toBe(true);
  });

  it('does NOT render an Adopt button — adopting a broken meta would be unsafe', () => {
    const handle = makeRecordingHandle();
    renderMismatchRecoveryContent(handle, makeOpts(corruptRecord));
    expect(
      handle.recorded.buttons.some((b) => b.label === S.MISMATCH_RECOVERY_ADOPT),
    ).toBe(false);
  });

  it('only renders the Cancel button (and it is the default)', () => {
    const handle = makeRecordingHandle();
    renderMismatchRecoveryContent(handle, makeOpts(corruptRecord));
    expect(handle.recorded.buttons).toHaveLength(1);
    expect(handle.recorded.buttons[0].label).toBe(S.MISMATCH_RECOVERY_CANCEL);
    expect(handle.recorded.buttons[0].isDefault).toBe(true);
  });

  it('Escape fires onCancel and closes', () => {
    const onCancel = vi.fn();
    const handle = makeRecordingHandle();
    renderMismatchRecoveryContent(handle, makeOpts(corruptRecord, { onCancel }));
    handle.fireKeydown('Escape');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(handle.closedCount()).toBe(1);
  });
});
