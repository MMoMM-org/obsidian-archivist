// #121 — makeContentElHandle is the one ModalHandle adapter every modal
// uses (Confirm, ConfirmRestore, ErrorDetails, MismatchRecovery, AdoptVault).
// Buttons must share one `modal-button-container` row so Obsidian spaces them.

import { describe, expect, it, vi } from 'vitest';
import { makeContentElHandle } from '../../src/ui/ConfirmRestoreModal';
import { makeMockEl, type MockEl } from '../fixtures/obsidian-mock';

function setup(): { content: MockEl; modal: MockEl; dismiss: ReturnType<typeof vi.fn>; handle: ReturnType<typeof makeContentElHandle> } {
  const content = makeMockEl('div');
  const modal = makeMockEl('div');
  const dismiss = vi.fn();
  const handle = makeContentElHandle(
    content as unknown as HTMLElement,
    modal as unknown as HTMLElement,
    dismiss,
  );
  return { content, modal, dismiss, handle };
}

describe('makeContentElHandle', () => {
  it('puts all buttons into one modal-button-container row after the text', () => {
    const { content, handle } = setup();
    handle.setTitle('Title');
    handle.setBody('Body');
    handle.addLine('Line');
    handle.addButton('Cancel', true, () => {});
    handle.addButton('Adopt', false, () => {});

    expect(content.children.map((c) => c.tagName)).toEqual(['h2', 'p', 'p', 'div']);
    const row = content.children[3];
    expect(row.className).toBe('modal-button-container');
    expect(row.children.map((b) => [b.tagName, b.textContent])).toEqual([
      ['button', 'Cancel'],
      ['button', 'Adopt'],
    ]);
    expect(row.children[0].attrs.autofocus).toBe('');
    expect(row.children[1].attrs.autofocus).toBeUndefined();
  });

  it('wires button clicks, keydown and close', () => {
    const { content, modal, dismiss, handle } = setup();
    const onClick = vi.fn();
    const onKey = vi.fn();
    handle.addButton('OK', false, onClick);
    handle.onKeydown(onKey);

    const button = content.children[0].children[0];
    button.dispatchEvent({ type: 'click', key: '', preventDefault: () => {} });
    expect(onClick).toHaveBeenCalledTimes(1);

    modal.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault: () => {} });
    expect(onKey).toHaveBeenCalledWith('Escape');

    handle.close();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
