// Time + schedule math. All helpers are pure — callers supply `now` (or Date)
// rather than reading the clock inside the module, so tests can use fake
// timers and the scheduler stays deterministic.

/**
 * Parse a snapshot id back to its UTC epoch-ms timestamp.
 *
 * Snapshot ids are produced by `ManifestBuilder.deriveId` from the UTC
 * `createdAt` in the format `YYYY-MM-DDTHH-MM-{full|inc}` (minute resolution,
 * UTC). Round-tripping is lossy below the minute boundary — that's by design,
 * the id is a stable filesystem-safe identifier, not a high-precision clock
 * stamp.
 *
 * Returns `null` when the input doesn't match the expected pattern, so the
 * caller can fall back to "no prior backup known" rather than crash.
 */
export function epochMsFromSnapshotId(id: string | null | undefined): number | null {
  if (typeof id !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(?:full|inc)$/.exec(id);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
}

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
  // Equality is returned as-is so the FSM tick fires exactly at the scheduled
  // instant instead of slipping to next week; the strict inequality only skips
  // when the candidate is genuinely in the past.
  if (deltaDays === 0 && candidate.getTime() < now.getTime()) {
    deltaDays = 7;
  }
  candidate.setDate(candidate.getDate() + deltaDays);
  if (candidate.getTime() < now.getTime()) {
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

export type FullCadence = 'weekly' | 'biweekly' | 'monthly';

/**
 * Next biweekly occurrence. Anchored to the prior full if present (exactly
 * 14 days after it at `hhmm`); otherwise falls back to `nextWeeklyFullAt`.
 */
export function nextBiweeklyFullAt(
  now: Date,
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  hhmm: string,
  lastFullAt: Date | null,
): Date {
  if (!lastFullAt) return nextWeeklyFullAt(now, dayOfWeek, hhmm);
  const { hours, minutes } = parseHHMM(hhmm);
  // Walk forward from lastFullAt in 14-day increments until at-or-after now.
  // Strict `<` (not `<=`) so the tick at the exact scheduled instant fires.
  const candidate = new Date(lastFullAt.getTime());
  candidate.setHours(hours, minutes, 0, 0);
  while (candidate.getTime() < now.getTime()) {
    candidate.setDate(candidate.getDate() + 14);
  }
  return candidate;
}

/**
 * First occurrence of `dayOfWeek` at `hhmm` in the current or next month.
 * Example: "first Sunday of the month at 03:00".
 */
export function nextMonthlyFullAt(
  now: Date,
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  hhmm: string,
): Date {
  const { hours, minutes } = parseHHMM(hhmm);
  const candidate = firstDowOfMonth(now.getFullYear(), now.getMonth(), dayOfWeek, hours, minutes);
  if (candidate.getTime() >= now.getTime()) return candidate;

  // Move to next month
  const nextMonth = now.getMonth() + 1;
  const y = now.getFullYear() + (nextMonth > 11 ? 1 : 0);
  const m = nextMonth % 12;
  return firstDowOfMonth(y, m, dayOfWeek, hours, minutes);
}

function firstDowOfMonth(
  year: number,
  month: number,
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  hours: number,
  minutes: number,
): Date {
  const first = new Date(year, month, 1, hours, minutes, 0, 0);
  const offset = (dayOfWeek - first.getDay() + 7) % 7;
  first.setDate(1 + offset);
  return first;
}

/**
 * Cadence-aware next scheduled full. Unified entry point for the FSM's
 * scheduler. `lastFullAt` anchors biweekly drift; it is ignored by weekly
 * and monthly.
 */
export function nextFullAt(
  now: Date,
  cadence: FullCadence,
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  hhmm: string,
  lastFullAt: Date | null,
): Date {
  switch (cadence) {
    case 'weekly':
      return nextWeeklyFullAt(now, dayOfWeek, hhmm);
    case 'biweekly':
      return nextBiweeklyFullAt(now, dayOfWeek, hhmm, lastFullAt);
    case 'monthly':
      return nextMonthlyFullAt(now, dayOfWeek, hhmm);
  }
}
