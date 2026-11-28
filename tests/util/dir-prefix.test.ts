import { describe, expect, it } from 'vitest';
import { normalizeDirPrefix, pathsUnderDir } from '../../src/util/dirPrefix';

describe('normalizeDirPrefix', () => {
  it('strips trailing slashes', () => {
    expect(normalizeDirPrefix('notes//')).toBe('notes');
    expect(normalizeDirPrefix('notes')).toBe('notes');
    expect(normalizeDirPrefix('/')).toBe('');
  });
});

describe('pathsUnderDir', () => {
  const paths = ['notes/b.md', 'notes/a.md', 'notes-old/c.md', 'notes/sub/d.md', 'other.md'];

  it('returns the paths in the directory and below, sorted', () => {
    expect(pathsUnderDir(paths, 'notes')).toEqual(['notes/a.md', 'notes/b.md', 'notes/sub/d.md']);
  });

  it('does not match a sibling that shares the name as a prefix', () => {
    expect(pathsUnderDir(paths, 'notes')).not.toContain('notes-old/c.md');
  });

  it('accepts a trailing slash on the prefix', () => {
    expect(pathsUnderDir(paths, 'notes/sub/')).toEqual(['notes/sub/d.md']);
  });

  it('matches nothing for the vault root', () => {
    expect(pathsUnderDir(paths, '')).toEqual([]);
    expect(pathsUnderDir(paths, '/')).toEqual([]);
  });
});
