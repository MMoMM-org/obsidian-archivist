import { describe, it, expect } from 'vitest';
import { S } from '../../src/ui/strings';

describe('UI strings', () => {
  it('no key maps to an empty string or empty function result', () => {
    for (const [k, v] of Object.entries(S)) {
      if (typeof v === 'string') {
        expect(v.length, `S.${k} is empty`).toBeGreaterThan(0);
      } else if (typeof v === 'function') {
        // Invoke with stub args to verify the template emits non-empty output.
        const probe = (v as (...args: unknown[]) => string)(0, 'x', 'y');
        expect(probe.length, `S.${k}() returned empty`).toBeGreaterThan(0);
      } else {
        throw new Error(`S.${k} is neither string nor function`);
      }
    }
  });

  it('keys follow UPPER_SNAKE_CASE', () => {
    for (const k of Object.keys(S)) {
      expect(k, `S.${k} violates naming`).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('covers core user-visible surfaces from PRD', () => {
    // Spot-check: ensure the features referenced in phase-2 are present.
    expect(S.RESTORE_CONFIRM_TITLE).toBeDefined();
    expect(S.OAUTH_CONNECT_BUTTON).toBeDefined();
    expect(S.PREFLIGHT_FULL_TITLE).toBeDefined();
    expect(S.PREDECESSOR_NOTICE).toBeDefined();
    expect(S.RIBBON_LABEL).toBeDefined();
    expect(S.BROWSER_EMPTY_STATE_TITLE).toBeDefined();
  });
});
