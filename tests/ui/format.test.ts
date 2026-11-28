import { describe, expect, it } from 'vitest';
import { formatSnapshotTimestamp } from '../../src/ui/format';

describe('formatSnapshotTimestamp', () => {
  it('returns a compact 24-hour form without AM/PM or seconds', () => {
    const out = formatSnapshotTimestamp(new Date('2026-04-25T10:00:07Z'));
    expect(out.length).toBeGreaterThan(0);
    expect(/AM|PM/.test(out)).toBe(false);
    expect(out).not.toContain(':07');
  });
});
