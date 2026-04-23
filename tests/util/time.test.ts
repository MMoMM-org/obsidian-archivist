import { describe, it, expect } from 'vitest';
import {
  addMinutes,
  fromIsoUtc,
  isoUtc,
  minutesBetween,
  nextDailyAt,
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
