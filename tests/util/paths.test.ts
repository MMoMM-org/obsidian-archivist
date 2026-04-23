import { describe, it, expect } from 'vitest';
import {
  APP_FOLDER_ROOT,
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
  it.each([
    `${APP_FOLDER_ROOT}/my-vault/HEAD.json`,
    `${APP_FOLDER_ROOT}/my-vault/snapshots/2026-04-23T03-00-full.json`,
    APP_FOLDER_ROOT,
  ])('accepts: %s', (p) => {
    expect(() => assertInAppFolder(p)).not.toThrow();
  });

  it.each([
    '',
    '/etc/passwd',
    'Apps/Evil/foo',
    `${APP_FOLDER_ROOT}/../escape`,
    'not-apps/Archivist/foo',
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

  it('builds the canonical paths', () => {
    expect(vaultRoot(prefix)).toBe('Apps/Archivist/my-vault');
    expect(headPath(prefix)).toBe('Apps/Archivist/my-vault/HEAD.json');
    expect(snapshotIndexPath(prefix)).toBe('Apps/Archivist/my-vault/snapshot_index.json');
    expect(gcLockPath(prefix)).toBe('Apps/Archivist/my-vault/gc_lock');
    expect(snapshotsDir(prefix)).toBe('Apps/Archivist/my-vault/snapshots');
  });

  it('snapshotPath uses ISO-with-dashes', () => {
    const p = snapshotPath({ vault_prefix: prefix, id: '2026-04-23T03-15-inc' });
    expect(p).toBe('Apps/Archivist/my-vault/snapshots/2026-04-23T03-15-inc.json');
  });

  it('snapshotPath rejects bad ids', () => {
    expect(() => snapshotPath({ vault_prefix: prefix, id: 'not-an-id' })).toThrow(PathError);
    expect(() => snapshotPath({ vault_prefix: prefix, id: '2026-04-23T03:15-inc' })).toThrow(PathError);
  });

  it('contentPath buckets by first 2 hex chars', () => {
    const hash = 'abcdef' + '0'.repeat(58);
    expect(contentPath(prefix, hash)).toBe(`Apps/Archivist/my-vault/content/ab/${hash}`);
  });

  it('contentPath rejects non-hex or wrong-length hash', () => {
    expect(() => contentPath(prefix, 'ZZ'.repeat(32))).toThrow(PathError);
    expect(() => contentPath(prefix, 'abc')).toThrow(PathError);
  });

  it('builders reject an invalid prefix before composing', () => {
    expect(() => headPath('Bad Prefix!')).toThrow(PathError);
  });
});
