// Pin the OAuth scope string so a future change doesn't silently widen
// the user-facing Dropbox consent screen. Adding a scope here MUST be
// matched by an updated entry in the README's "Dropbox scopes" table.

import { describe, expect, it } from 'vitest';
import { OAUTH_SCOPE } from '../../src/config/dropbox';

const EXPECTED_SCOPES = [
  'files.content.write',
  'files.content.read',
  'files.metadata.read',
  'account_info.read',
];

describe('OAUTH_SCOPE', () => {
  it('requests exactly the four documented scopes', () => {
    const actual = OAUTH_SCOPE.split(' ').sort();
    const expected = [...EXPECTED_SCOPES].sort();
    expect(actual).toEqual(expected);
  });

  it('does NOT request files.metadata.write (no filesMove / filesCopyV2 / filesCreateFolderV2 in code)', () => {
    expect(OAUTH_SCOPE).not.toContain('files.metadata.write');
  });

  it('does NOT request sharing.* (we are App-Folder-scoped, no shares)', () => {
    expect(OAUTH_SCOPE).not.toMatch(/sharing\./);
  });
});
