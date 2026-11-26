// Dev modal preview — must only register on the test-vault build.

import { describe, expect, it, vi } from 'vitest';
import { isDevBuild, registerDevModalPreviews } from '../../src/dev/ModalPreview';
import type { Command } from 'obsidian';
import { App } from '../fixtures/obsidian-mock';

function pluginWith(version: string) {
  return {
    addCommand: vi.fn((command: Command) => command),
    app: new App() as never,
    manifest: { version },
  };
}

describe('isDevBuild', () => {
  it.each([
    ['0.12.5-dev.20261126-1523', true],
    ['0.12.5', false],
    ['1.0.0-beta.1', false],
    ['0.12.5-dev.', false],
    ['0.12.5-dev.1764163200000', false],
  ])('%s → %s', (version, expected) => {
    expect(isDevBuild(version)).toBe(expected);
  });
});

describe('registerDevModalPreviews', () => {
  it('registers nothing on a release build', () => {
    const plugin = pluginWith('0.12.5');
    registerDevModalPreviews({ plugin });
    expect(plugin.addCommand).not.toHaveBeenCalled();
  });

  it('registers the three preview commands on a dev build', () => {
    const plugin = pluginWith('0.12.5-dev.20261126-1523');
    registerDevModalPreviews({ plugin });
    const ids = plugin.addCommand.mock.calls.map(([c]) => (c as { id: string }).id);
    expect(ids).toEqual([
      'dev-preview-error-details',
      'dev-preview-mismatch-recovery',
      'dev-preview-adopt-vault',
    ]);
  });
});
