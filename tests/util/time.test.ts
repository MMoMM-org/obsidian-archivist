import { describe, it, expect } from 'vitest';
import {
  addMinutes,
  fromIsoUtc,
  isoUtc,
  minutesBetween,
  nextBiweeklyFullAt,
  nextDailyAt,
  nextFullAt,
  nextMonthlyFullAt,
  nextWeeklyFullAt,
  parseHHMM,
} from '../../src/util/time';

describe('time — isoUtc / fromIsoUtc', () => {
  it('round-trips through ISO', () => {
    const d = new Date('2026-04-23T03:15:00.000Z');
    expect(fromIsoUtc(isoUtc(d)).getTime()).toBe(d.getTime());
  });

  it('rejects an invalid Date', () => {
    expect(() => isoUtc(new Date('garbage'))).toThrow(TypeError);
    expect(() => fromIsoUtc('not-an-iso')).toThrow(TypeError);
  });
});

describe('time — parseHHMM', () => {
  it.each([
    ['00:00', 0, 0],
    ['03:15', 3, 15],
    ['23:59', 23, 59],
  ])('%s → %d:%d', (s, h, m) => {
    expect(parseHHMM(s)).toEqual({ hours: h, minutes: m });
  });

  it.each(['24:00', '1:30', '12:60', '3-30', ''])('rejects: %s', (s) => {
    expect(() => parseHHMM(s)).toThrow(TypeError);
  });
});

describe('time — nextWeeklyFullAt', () => {
  it('returns a future instant on the requested day', () => {
    const now = new Date('2026-04-23T12:00:00'); // Thursday
    const next = nextWeeklyFullAt(now, 0, '03:00'); // next Sunday 03:00
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getDay()).toBe(0);
    expect(next.getHours()).toBe(3);
    expect(next.getMinutes()).toBe(0);
  });

  it('skips today when time has already passed', () => {
    const now = new Date('2026-04-23T04:00:00'); // Thursday 04:00
    const next = nextWeeklyFullAt(now, 4, '03:00'); // Thursday 03:00 — already gone
    expect(next.getDay()).toBe(4);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    // Must be next week, not today.
    const hours = (next.getTime() - now.getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(24 * 6);
  });

  it('accepts today when time is still in the future', () => {
    const now = new Date('2026-04-23T01:00:00'); // Thursday 01:00
    const next = nextWeeklyFullAt(now, 4, '03:00');
    expect(next.getDay()).toBe(4);
    const hours = (next.getTime() - now.getTime()) / 3_600_000;
    expect(hours).toBeLessThan(24);
  });
});

describe('time — nextDailyAt', () => {
  it('picks today if future, else tomorrow', () => {
    const now = new Date('2026-04-23T01:00:00');
    const sameDay = nextDailyAt(now, '03:00');
    expect(sameDay.getDate()).toBe(23);

    const past = new Date('2026-04-23T04:00:00');
    const tomorrow = nextDailyAt(past, '03:00');
    expect(tomorrow.getDate()).toBe(24);
  });
});

describe('time — addMinutes / minutesBetween', () => {
  it('inverse-pair', () => {
    const start = new Date('2026-04-23T03:00:00Z');
    const later = addMinutes(start, 42);
    expect(minutesBetween(start, later)).toBe(42);
  });
});

describe('time — nextBiweeklyFullAt', () => {
  it('falls back to weekly when lastFullAt is null (first backup)', () => {
    const now = new Date('2026-04-23T12:00:00'); // Thursday
    const next = nextBiweeklyFullAt(now, 0, '03:00', null); // next Sunday 03:00
    expect(next.getDay()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('anchors 14 days after lastFullAt', () => {
    const lastFull = new Date('2026-04-19T03:00:00'); // Sunday
    const now = new Date('2026-04-20T12:00:00'); // day after
    const next = nextBiweeklyFullAt(now, 0, '03:00', lastFull);
    const expected = new Date('2026-05-03T03:00:00'); // 14 days after
    expect(next.getTime()).toBe(expected.getTime());
  });

  it('walks forward when lastFullAt + 14d is still in the past', () => {
    const lastFull = new Date('2026-01-04T03:00:00'); // Sunday long ago
    const now = new Date('2026-04-23T12:00:00'); // Thursday
    const next = nextBiweeklyFullAt(now, 0, '03:00', lastFull);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getDay()).toBe(0); // still Sunday
    // 14-day rhythm in calendar days (ms delta is DST-sensitive — spring-forward
    // shaves 1h — so we compare calendar midnights instead of ms).
    const calendarDays = Math.round(
      (Date.UTC(next.getFullYear(), next.getMonth(), next.getDate()) -
        Date.UTC(lastFull.getFullYear(), lastFull.getMonth(), lastFull.getDate())) /
        (24 * 3_600_000),
    );
    expect(calendarDays % 14).toBe(0);
  });
});

describe('time — nextMonthlyFullAt', () => {
  it('returns first dayOfWeek of current month when still future', () => {
    const now = new Date('2026-04-01T00:00:00'); // Wed, before first Sunday (Apr 5)
    const next = nextMonthlyFullAt(now, 0, '03:00'); // first Sunday of April
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(3); // April
    expect(next.getDate()).toBe(5); // first Sunday of April 2026
    expect(next.getDay()).toBe(0);
    expect(next.getHours()).toBe(3);
  });

  it('rolls to next month when current-month target has passed', () => {
    const now = new Date('2026-04-10T12:00:00'); // past first Sunday (Apr 5)
    const next = nextMonthlyFullAt(now, 0, '03:00');
    expect(next.getMonth()).toBe(4); // May
    expect(next.getDate()).toBe(3); // first Sunday of May 2026
    expect(next.getDay()).toBe(0);
  });

  it('rolls into next year across December boundary', () => {
    const now = new Date('2026-12-31T23:59:00');
    const next = nextMonthlyFullAt(now, 0, '03:00');
    expect(next.getFullYear()).toBe(2027);
    expect(next.getMonth()).toBe(0); // January
    expect(next.getDay()).toBe(0);
  });
});

describe('time — nextFullAt (unified)', () => {
  it('weekly dispatches to nextWeeklyFullAt', () => {
    const now = new Date('2026-04-23T12:00:00');
    expect(nextFullAt(now, 'weekly', 0, '03:00', null).getTime()).toBe(
      nextWeeklyFullAt(now, 0, '03:00').getTime(),
    );
  });

  it('biweekly dispatches to nextBiweeklyFullAt with lastFullAt', () => {
    const now = new Date('2026-04-23T12:00:00');
    const lastFull = new Date('2026-04-19T03:00:00');
    expect(nextFullAt(now, 'biweekly', 0, '03:00', lastFull).getTime()).toBe(
      nextBiweeklyFullAt(now, 0, '03:00', lastFull).getTime(),
    );
  });

  it('monthly dispatches to nextMonthlyFullAt', () => {
    const now = new Date('2026-04-10T12:00:00');
    expect(nextFullAt(now, 'monthly', 0, '03:00', null).getTime()).toBe(
      nextMonthlyFullAt(now, 0, '03:00').getTime(),
    );
  });
});
