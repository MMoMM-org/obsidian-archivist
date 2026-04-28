// AdoptVaultModal — pure-render tests for the vault-id adoption dialog.
//
// Mirrors the recording-handle pattern from confirm-restore-modal.test.ts:
// the Modal subclass is exercised end-to-end in tests/lifecycle for the
// Obsidian wiring; this file exclusively covers the render contract +
// keyboard guard.

import { describe, expect, it, vi } from 'vitest';
import {
  renderAdoptVaultContent,
  type AdoptVaultModalOpts,
} from '../../src/ui/AdoptVaultModal';
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

function makeOpts(overrides?: Partial<AdoptVaultModalOpts>): AdoptVaultModalOpts {
  return {
    remoteVaultName: 'OtherVault',
    remoteVaultId: '3f2a8c1e-7d4b-4f12-a1c0-bc5d76e9a2e1',
    onAdopt: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

describe('renderAdoptVaultContent', () => {
  it('renders the standard adoption title + body with remote vault name and id', () => {
    const handle = makeRecordingHandle();
    renderAdoptVaultContent(handle, makeOpts());
    expect(handle.recorded.title).toBe(S.ADOPT_VAULT_TITLE);
    expect(handle.recorded.body).toContain('OtherVault');
    expect(handle.recorded.body).toContain('3f2a8c1e-7d4b-4f12-a1c0-bc5d76e9a2e1');
  });

  it('appends the docs hint as a supplemental line', () => {
    const handle = makeRecordingHandle();
    renderAdoptVaultContent(handle, makeOpts());
    expect(handle.recorded.extraLines).toContain(S.ADOPT_VAULT_HINT);
  });

  it('renders Adopt + Cancel outcome paragraphs separately (M16)', () => {
    const handle = makeRecordingHandle();
    renderAdoptVaultContent(handle, makeOpts());
    // Body is now the lead summary — neither outcome paragraph should
    // be folded into it.
    expect(handle.recorded.body).not.toContain('Backups will resume');
    expect(handle.recorded.body).not.toContain('keep this device unclaimed');
    // Each outcome lives on its own line so the two decision paths are
    // visually separated.
    expect(handle.recorded.extraLines).toContain(S.ADOPT_VAULT_BODY_ADOPT);
    expect(handle.recorded.extraLines).toContain(S.ADOPT_VAULT_BODY_CANCEL);
  });

  it('Cancel is the default button — Adopt is NOT default', () => {
    const handle = makeRecordingHandle();
    renderAdoptVaultContent(handle, makeOpts());
    const cancel = handle.recorded.buttons.find((b) => b.label === S.ADOPT_VAULT_CANCEL);
    const adopt = handle.recorded.buttons.find((b) => b.label === S.ADOPT_VAULT_ADOPT);
    expect(cancel?.isDefault).toBe(true);
    expect(adopt?.isDefault).toBe(false);
  });

  it('clicking Adopt fires onAdopt and closes the modal', () => {
    const onAdopt = vi.fn();
    const onCancel = vi.fn();
    const handle = makeRecordingHandle();
    renderAdoptVaultContent(handle, makeOpts({ onAdopt, onCancel }));
    handle.clickButton(S.ADOPT_VAULT_ADOPT);
    expect(onAdopt).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
    expect(handle.closedCount()).toBe(1);
  });

  it('clicking Cancel fires onCancel and closes the modal', () => {
    const onAdopt = vi.fn();
    const onCancel = vi.fn();
    const handle = makeRecordingHandle();
    renderAdoptVaultContent(handle, makeOpts({ onAdopt, onCancel }));
    handle.clickButton(S.ADOPT_VAULT_CANCEL);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onAdopt).not.toHaveBeenCalled();
    expect(handle.closedCount()).toBe(1);
  });

  it('Escape key fires onCancel and closes', () => {
    const onAdopt = vi.fn();
    const onCancel = vi.fn();
    const handle = makeRecordingHandle();
    renderAdoptVaultContent(handle, makeOpts({ onAdopt, onCancel }));
    handle.fireKeydown('Escape');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onAdopt).not.toHaveBeenCalled();
    expect(handle.closedCount()).toBe(1);
  });

  it('Enter key is INERT — adoption is one-way; refuse stray-keystroke claims', () => {
    const onAdopt = vi.fn();
    const onCancel = vi.fn();
    const handle = makeRecordingHandle();
    renderAdoptVaultContent(handle, makeOpts({ onAdopt, onCancel }));
    handle.fireKeydown('Enter');
    expect(onAdopt).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(handle.closedCount()).toBe(0);
  });
});
