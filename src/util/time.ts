// Time + schedule math. All helpers are pure — callers supply `now` (or Date)
// rather than reading the clock inside the module, so tests can use fake
// timers and the scheduler stays deterministic.

export function isoUtc(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('isoUtc: expected a valid Date');
  }
  return date.toISOString();
}

export function fromIsoUtc(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(`fromIsoUtc: invalid ISO-8601 string: ${iso}`);
  }
  return d;
}

export function parseHHMM(hhmm: string): { hours: number; minutes: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new TypeError(`parseHHMM: expected "HH:MM", got ${hhmm}`);
  return { hours: Number(m[1]), minutes: Number(m[2]) };
}

/**
 * Next future occurrence of `dayOfWeek` at `hhmm` in local time.
 *
 * DST behavior: we build a local-time Date with `new Date(y, m, d, h, m)`,
 * which the runtime resolves to the correct UTC instant including DST
 * shifts. On a spring-forward day (e.g., a 02:30 target) the runtime picks
 * the first valid wall-clock match after the skip, so we never double-fire
 * or emit an earlier-than-now instant.
 */
export function nextWeeklyFullAt(
  now: Date,
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  hhmm: string,
): Date {
  const { hours, minutes } = parseHHMM(hhmm);
  const candidate = new Date(now.getTime());
  candidate.setHours(hours, minutes, 0, 0);

  const currentDow = candidate.getDay();
  let deltaDays = (dayOfWeek - currentDow + 7) % 7;
  if (deltaDays === 0 && candidate.getTime() <= now.getTime()) {
    deltaDays = 7;
  }
  candidate.setDate(candidate.getDate() + deltaDays);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 7);
  }
  return candidate;
}

/**
 * Next occurrence of `hhmm` today or tomorrow in local time.
 */
export function nextDailyAt(now: Date, hhmm: string): Date {
  const { hours, minutes } = parseHHMM(hhmm);
  const candidate = new Date(now.getTime());
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000;
}
