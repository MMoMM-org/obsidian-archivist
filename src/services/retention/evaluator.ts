// T6.1 — Pure retention tier evaluator.
// No I/O, no logging, no side effects. All inputs explicit, output is a Set<snapshot_id>.
//
// Bucketing note: daily and monthly buckets are anchored to LOCAL wall-clock time.
// DST transitions (spring-forward 23h day, fall-back 25h day) do not create zero- or
// 25-hour buckets because the newest-per-bucket rule deduplicates any snapshots that
// land in the same local date/month string regardless of wall-clock hour count.

import type { SnapshotIndexEntry } from '../../model/SnapshotIndex';
import type { RetentionSettings } from '../../model/Settings';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

/** Returns the local-time date string "YYYY-MM-DD" for an ISO-8601 timestamp. */
function localDateKey(isoTs: string): string {
  const d = new Date(isoTs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Returns the local-time month string "YYYY-MM" for an ISO-8601 timestamp. */
function localMonthKey(isoTs: string): string {
  const d = new Date(isoTs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Computes the cutoff month key "YYYY-MM" by subtracting totalMonths from now.
 * Uses direct year/month arithmetic — no Date intermediate, avoids end-of-month rollover
 * (e.g. Date.setMonth on a 31st-of-month now produces incorrect results).
 */
function monthlyCutoffKey(now: Date, totalMonths: number): string {
  const totalNowMonths = now.getFullYear() * 12 + now.getMonth();
  const totalCutoff = totalNowMonths - totalMonths;
  const year = Math.floor(totalCutoff / 12);
  const month = totalCutoff - year * 12;
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** Keeps only the newest snapshot per bucket key. Returns a Set of kept IDs. */
function newestPerBucket(
  snapshots: SnapshotIndexEntry[],
  toBucketKey: (s: SnapshotIndexEntry) => string,
): Set<string> {
  const newest = new Map<string, SnapshotIndexEntry>();
  for (const s of snapshots) {
    const key = toBucketKey(s);
    const prev = newest.get(key);
    if (!prev || s.created_at > prev.created_at) newest.set(key, s);
  }
  return new Set(Array.from(newest.values()).map((s) => s.id));
}

/** Snapshots kept by the never-prune window (age <= never_prune_window_days). */
function applyNeverPrune(
  snapshots: SnapshotIndexEntry[],
  settings: RetentionSettings,
  nowMs: number,
): Set<string> {
  if (settings.never_prune_window_days === 0) return new Set();
  const cutoffMs = nowMs - settings.never_prune_window_days * MS_PER_DAY;
  return new Set(
    snapshots.filter((s) => new Date(s.created_at).getTime() >= cutoffMs).map((s) => s.id),
  );
}

/** Snapshots kept by the recent-hours window (age <= recent_hours). */
function applyRecentHours(
  snapshots: SnapshotIndexEntry[],
  settings: RetentionSettings,
  nowMs: number,
): Set<string> {
  if (settings.recent_hours === 0) return new Set();
  const cutoffMs = nowMs - settings.recent_hours * MS_PER_HOUR;
  return new Set(
    snapshots.filter((s) => new Date(s.created_at).getTime() >= cutoffMs).map((s) => s.id),
  );
}

/** Snapshots kept by the daily tier: newest-per-calendar-day for the last daily_days days. */
function applyDaily(
  snapshots: SnapshotIndexEntry[],
  settings: RetentionSettings,
  nowMs: number,
): Set<string> {
  if (settings.daily_days === 0) return new Set();
  const cutoffMs = nowMs - settings.daily_days * MS_PER_DAY;
  const inWindow = snapshots.filter((s) => new Date(s.created_at).getTime() >= cutoffMs);
  return newestPerBucket(inWindow, (s) => localDateKey(s.created_at));
}

/** Snapshots kept by the monthly tier: newest-per-calendar-month for the last monthly_years*12 months. */
function applyMonthly(
  snapshots: SnapshotIndexEntry[],
  settings: RetentionSettings,
  now: Date,
): Set<string> {
  if (settings.monthly_years === 0) return new Set();
  const totalMonths = settings.monthly_years * 12;
  const cutoffMonthKey = monthlyCutoffKey(now, totalMonths);
  const inWindow = snapshots.filter((s) => localMonthKey(s.created_at) >= cutoffMonthKey);
  return newestPerBucket(inWindow, (s) => localMonthKey(s.created_at));
}

/**
 * Evaluates retention tiers for a list of snapshots.
 *
 * Returns the set of snapshot IDs that pass at least one tier rule (UNION of all tiers).
 * Chain-integrity (transitive ancestor promotion) is NOT applied here — that is T6.2's job.
 *
 * Tiers:
 *   - Never-prune: all snapshots within the last never_prune_window_days (inclusive). Always kept.
 *   - Recent: all snapshots within the last recent_hours. Overlaps with never-prune.
 *   - Daily: newest snapshot per local calendar day within the last daily_days days.
 *   - Monthly: newest snapshot per local calendar month within the last monthly_years * 12 months.
 *
 * A tier value of 0 disables that tier (contributes no keeps).
 *
 * @param snapshots - Snapshot index entries to evaluate (order does not matter).
 * @param settings  - Retention configuration.
 * @param now       - Current wall-clock time (injected for testability).
 * @returns Set of snapshot IDs that should be kept by tier rules.
 */
export function evaluateTiers(
  snapshots: SnapshotIndexEntry[],
  settings: RetentionSettings,
  now: Date,
): Set<string> {
  const nowMs = now.getTime();
  const kept = new Set<string>();
  const addAll = (ids: Set<string>): void => { for (const id of ids) kept.add(id); };

  addAll(applyNeverPrune(snapshots, settings, nowMs));
  addAll(applyRecentHours(snapshots, settings, nowMs));
  addAll(applyDaily(snapshots, settings, nowMs));
  addAll(applyMonthly(snapshots, settings, now));

  return kept;
}
