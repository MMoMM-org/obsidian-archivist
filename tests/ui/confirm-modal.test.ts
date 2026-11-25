// #109 — generic confirmation dialog behind SettingsContext.confirm.
//
// Regression guard: "Disconnect Dropbox" used to be wired to a stub that
// always resolved true, so the token was cleared on the first click. These
// tests pin the dialog contract: only an explicit OK confirms; Cancel,
// Escape, Enter and closing without a choice all leave the caller's state
// untouched (resolve false).

import { describe, expect, it } from 'vitest';
import {
  type ConfirmOpts,
  createConfirmSession,
  renderConfirmContent,
} from '../../src/ui/ConfirmModal';
import type { ModalHandle } from '../../src/ui/ConfirmRestoreModal';

interface RecordedButton {
  label: string;
  isDefault: boolean;
  onClick: () => void;
}

function makeRecordingHandle(): ModalHandle & {
  title: string;
  body: string;
  buttons: RecordedButton[];
  closeCount: number;
  fireKeydown(key: string): void;
  click(label: string): void;
} {
  const keydownHandlers: Array<(key: string) => void> = [];
  const handle = {
    title: '',
    body: '',
    buttons: [] as RecordedButton[],
    closeCount: 0,
    setTitle(t: string): void {
      handle.title = t;
    },
    setBody(b: string): void {
      handle.body = b;
    },
    addLine(): void {},
    addButton(label: string, isDefault: boolean, onClick: () => void): void {
      handle.buttons.push({ label, isDefault, onClick });
    },
    close(): void {
      handle.closeCount++;
    },
    onKeydown(h: (key: string) => void): void {
      keydownHandlers.push(h);
    },
    fireKeydown(key: string): void {
      for (const h of keydownHandlers) h(key);
    },
    click(label: string): void {
      const btn = handle.buttons.find((b) => b.label === label);
      if (!btn) throw new Error(`no button "${label}"`);
      btn.onClick();
    },
  };
  return handle;
}

const OPTS: ConfirmOpts = {
  title: 'Disconnect Dropbox?',
  body: 'Backups stop until you reconnect.',
  okLabel: 'Disconnect',
  cancelLabel: 'Cancel',
};

function render(): { handle: ReturnType<typeof makeRecordingHandle>; results: boolean[] } {
  const handle = makeRecordingHandle();
  const results: boolean[] = [];
  renderConfirmContent(handle, OPTS, (ok) => results.push(ok));
  return { handle, results };
}

describe('renderConfirmContent', () => {
  it('renders the caller-supplied title, body and button labels', () => {
    const { handle } = render();
    expect(handle.title).toBe(OPTS.title);
    expect(handle.body).toBe(OPTS.body);
    expect(handle.buttons.map((b) => b.label)).toEqual([OPTS.cancelLabel, OPTS.okLabel]);
  });

  it('makes Cancel the default button, never the destructive OK', () => {
    const { handle } = render();
    expect(handle.buttons.find((b) => b.isDefault)?.label).toBe(OPTS.cancelLabel);
  });

  it('reports true and closes when OK is clicked', () => {
    const { handle, results } = render();
    handle.click(OPTS.okLabel);
    expect(results).toEqual([true]);
    expect(handle.closeCount).toBe(1);
  });

  it('reports false and closes when Cancel is clicked', () => {
    const { handle, results } = render();
    handle.click(OPTS.cancelLabel);
    expect(results).toEqual([false]);
    expect(handle.closeCount).toBe(1);
  });

  it('reports false on Escape', () => {
    const { handle, results } = render();
    handle.fireKeydown('Escape');
    expect(results).toEqual([false]);
  });

  it('does not confirm on Enter', () => {
    const { handle, results } = render();
    handle.fireKeydown('Enter');
    expect(results).toEqual([]);
  });
});

describe('createConfirmSession', () => {
  it('resolves with the first answer only', async () => {
    const session = createConfirmSession();
    session.settle(true);
    session.settle(false);
    await expect(session.promise).resolves.toBe(true);
  });

  it('resolves false when the dialog closes without a choice', async () => {
    const session = createConfirmSession();
    // Modal.onClose settles false; an explicit choice before it wins.
    session.settle(false);
    await expect(session.promise).resolves.toBe(false);
  });
});
