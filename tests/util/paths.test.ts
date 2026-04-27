import { describe, it, expect } from 'vitest';
import {
  VAULT_PREFIX_REGEX,
  assertInAppFolder,
  contentPath,
  gcLockPath,
  headPath,
  slugifyVaultName,
  snapshotPath,
  snapshotIndexPath,
  snapshotsDir,
  validateVaultPrefix,
  vaultRoot,
} from '../../src/util/paths';
import { PathError } from '../../src/model/Errors';

describe('paths — assertInAppFolder', () => {
  // App-Folder OAuth scope means Dropbox enforces the folder boundary
  // server-side. The client-side assertion is now only a `..` traversal
  // guard plus a non-empty check.
  it.each([
    'my-vault/HEAD.json',
    'my-vault/snapshots/2026-04-23T03-00-full.json',
    '/my-vault/HEAD.json',
    'just-a-prefix',
  ])('accepts: %s', (p) => {
    expect(() => assertInAppFolder(p)).not.toThrow();
  });

  it.each([
    '',
    'my-vault/../escape',
    'foo/../../etc/passwd',
  ])('rejects: %s', (p) => {
    expect(() => assertInAppFolder(p)).toThrow(PathError);
  });
});

describe('paths — validateVaultPrefix', () => {
  it.each(['my-vault', 'abc123', 'a_b', 'v1_v2-v3'])('accepts: %s', (p) => {
    expect(validateVaultPrefix(p)).toBe(p);
  });

  it.each([
    '',
    'a', // too short
    'Bad Prefix!',
    '-leading-dash',
    '_leading-underscore',
    '../evil',
    'UPPERCASE',
    'has space',
    'a'.repeat(65), // too long
  ])('rejects: %s', (p) => {
    expect(() => validateVaultPrefix(p)).toThrow(PathError);
    expect(VAULT_PREFIX_REGEX.test(p)).toBe(false);
  });
});

describe('paths — slugifyVaultName', () => {
  it.each([
    ['My Vault', 'my-vault'],
    ['Étude', 'etude'],
    ['  whitespace  ', 'whitespace'],
    ['emoji🔥vault', 'emoji-vault'],
    ['///////', 'vault'],
    ['A', 'a-vault'],
  ])('%s → %s', (input, expected) => {
    expect(slugifyVaultName(input)).toBe(expected);
  });

  it('output always passes validateVaultPrefix', () => {
    for (const name of ['My Vault', 'Z', 'hello/world', '日本語', 'A B C 123']) {
      const slug = slugifyVaultName(name);
      expect(() => validateVaultPrefix(slug)).not.toThrow();
    }
  });
});

describe('paths — remote-path builders', () => {
  const prefix = 'my-vault';

  it('builds the canonical paths (app-folder-relative)', () => {
    // Dropbox prepends `/Apps/Archivist/` server-side because the OAuth app
    // is App-Folder scoped. The builders MUST NOT include that prefix —
    // they did until the path-double-prefix bug was fixed.
    expect(vaultRoot(prefix)).toBe('my-vault');
    expect(headPath(prefix)).toBe('my-vault/HEAD.json');
    expect(snapshotIndexPath(prefix)).toBe('my-vault/snapshot_index.json');
    expect(gcLockPath(prefix)).toBe('my-vault/gc_lock');
    expect(snapshotsDir(prefix)).toBe('my-vault/snapshots');
  });

  it('snapshotPath uses ISO-with-dashes', () => {
    const p = snapshotPath({ vault_prefix: prefix, id: '2026-04-23T03-15-inc' });
    expect(p).toBe('my-vault/snapshots/2026-04-23T03-15-inc.json');
  });

  it('snapshotPath rejects bad ids', () => {
    expect(() => snapshotPath({ vault_prefix: prefix, id: 'not-an-id' })).toThrow(PathError);
    expect(() => snapshotPath({ vault_prefix: prefix, id: '2026-04-23T03:15-inc' })).toThrow(PathError);
  });

  it('contentPath buckets by first 2 hex chars', () => {
    const hash = 'abcdef' + '0'.repeat(58);
    expect(contentPath(prefix, hash)).toBe(`my-vault/content/ab/${hash}`);
  });

  it('contentPath rejects non-hex or wrong-length hash', () => {
    expect(() => contentPath(prefix, 'ZZ'.repeat(32))).toThrow(PathError);
    expect(() => contentPath(prefix, 'abc')).toThrow(PathError);
  });

  it('builders reject an invalid prefix before composing', () => {
    expect(() => headPath('Bad Prefix!')).toThrow(PathError);
  });
});
