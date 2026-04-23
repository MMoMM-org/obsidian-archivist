import { describe, it, expect } from 'vitest';
import { matchAny, matches } from '../../src/util/glob';

describe('glob — matches', () => {
  it.each([
    ['*.md', 'hello.md', true],
    ['*.md', 'Notes/hello.md', false],
    ['**/*.md', 'Notes/hello.md', true],
    ['.trash/**', '.trash/old.md', true],
    ['.trash/**', '.trash/sub/old.md', true],
    ['_templates/**', '_templates/x', true],
    ['_templates/**', 'templates/x', false],
    ['?oo.md', 'foo.md', true],
    ['?oo.md', 'fooo.md', false],
    ['[abc].md', 'a.md', true],
    ['[abc].md', 'z.md', false],
    ['[^abc].md', 'z.md', true],
    ['[^abc].md', 'a.md', false],
    ['docs/**/*.md', 'docs/a/b/c.md', true],
    ['docs/**/*.md', 'docs/c.md', true],
    ['foo/bar', 'foo/bar', true],
    ['foo/bar', 'foo/baz', false],
  ])('%s vs %s → %s', (pattern, path, expected) => {
    expect(matches(pattern, path)).toBe(expected);
  });
});

describe('glob — matchAny', () => {
  it('returns true if any pattern matches', () => {
    expect(matchAny(['.trash/**', '_templates/**'], '.trash/a.md')).toBe(true);
    expect(matchAny(['.trash/**', '_templates/**'], 'Notes/a.md')).toBe(false);
  });

  it('empty pattern list matches nothing', () => {
    expect(matchAny([], 'anything')).toBe(false);
  });
});
