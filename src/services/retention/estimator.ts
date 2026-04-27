// estimator — pure storage-projection for the Retention settings UI (T7.8).
//
// Purpose: help the user reason about retention tiers BEFORE they commit to
// them. Takes a profile (vault size, recent edit rate) and the desired
// retention settings, returns a projected snapshot count and storage GB.
//
// This is a rough model, not a planner. Production behaviour is governed by
// `evaluator.ts` (the real retention algorithm). The estimator exists so a
// user who lowers "monthly years" from 3 to 1 sees the change immediately —
// it is NOT a promise of exact behaviour.

import type { PluginSettings } from '../../model/Settings';
import type { RetentionProfile, RetentionEstimate } from '../../ui/settings/context';

// Heuristic: assume one incremental per tracked "edit day" produces a
// snapshot. Fulls are one per cadence period. The estimator rolls both up
// into a single snapshot count.
const GB_DIVISOR = 1024 * 1024 * 1024;

const CADENCE_PER_YEAR: Record<PluginSettings['schedule']['full_cadence'], number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
};

export function estimateRetention(
  profile: RetentionProfile,
  settings: PluginSettings,
): RetentionEstimate {
  const { retention, schedule } = settings;

  // Snapshot count projection: sum of the per-tier windows.
  //   recent high-frequency: 24 edits/day (capped) × window / 24  ≈ roughly 1 per 2h
  //   never-prune: up to 1 snapshot per ~30 min of edit activity
  //   daily: 1 per day
  //   monthly: 1 per month
  //   plus full-count projection driven by cadence.
  const recentHours = Math.max(0, retention.recent_hours);
  const neverPruneDays = Math.max(0, retention.never_prune_window_days);
  const dailyDays = Math.max(0, retention.daily_days);
  const monthlyYears = Math.max(0, retention.monthly_years);

  // Assume ~one incremental per 30 min of edit activity. Cap by the profile
  // edit-rate so a quiet vault doesn't over-project.
  const editEventsPerHour = Math.min(2, Math.max(0, profile.avg_edits_per_day / 24));

  const recentSnaps = Math.round(recentHours * editEventsPerHour);
  const neverPruneSnaps = Math.round(neverPruneDays * 24 * editEventsPerHour);
  const dailySnaps = dailyDays;
  const monthlySnaps = monthlyYears * 12;

  // Full-backup count across the retention window (years worth).
  const windowYears = monthlyYears + dailyDays / 365 + neverPruneDays / 365;
  const fullCount = Math.ceil(windowYears * CADENCE_PER_YEAR[schedule.full_cadence]);

  const snapshots = recentSnaps + neverPruneSnaps + dailySnaps + monthlySnaps + fullCount;

  // Storage projection:
  //   fulls ≈ vault size
  //   incrementals ≈ ~0.5% of vault size (dedup + content-addressed)
  //   metadata ≈ ~100 KB per snapshot
  const fullBytes = fullCount * profile.vault_bytes;
  const incBytes = (snapshots - fullCount) * profile.vault_bytes * 0.005;
  const metadataBytes = snapshots * 100 * 1024;
  const totalBytes = fullBytes + incBytes + metadataBytes;

  return {
    snapshots,
    gb: round2(totalBytes / GB_DIVISOR),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
