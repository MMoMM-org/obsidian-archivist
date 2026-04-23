// Minimal glob matcher — enough for exclusion-globs (F1/S1). Supports:
//   `*`        — any run of characters except `/`
//   `**`       — any run of characters including `/`
//   `?`        — exactly one character except `/`
//   `[abc]`    — character class (literal)
//   `[^abc]`   — negated character class
// Paths are forward-slash; matching is case-sensitive (vault paths are).

function globToRegExp(pattern: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i += 1; // consume trailing slash of `**/`
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        re += '\\[';
        i += 1;
      } else {
        let cls = pattern.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls + ']';
        i = end + 1;
      }
    } else if ('.+^$(){}|\\'.includes(ch)) {
      re += '\\' + ch;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  re += '$';
  return new RegExp(re);
}

const cache = new Map<string, RegExp>();
function compile(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  const re = globToRegExp(pattern);
  cache.set(pattern, re);
  return re;
}

export function matches(pattern: string, path: string): boolean {
  return compile(pattern).test(path);
}

export function matchAny(patterns: readonly string[], path: string): boolean {
  for (const p of patterns) {
    if (matches(p, path)) return true;
  }
  return false;
}
