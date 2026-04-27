// T6.1 — evaluateTiers: pure retention tier evaluator.
//
// Test coverage:
//   - Never-prune window includes the snapshot → keep (overrides all tiers)
//   - Recent-hours window (inside never-prune) match → keep
//   - Daily: newest-per-bucket is kept; older-within-same-bucket is pruned
//   - Monthly: newest-per-bucket is kept; older-within-same-bucket is pruned
//   - Bucket outside daily window → not considered by daily tier
//   - Bucket outside monthly window → not considered by monthly tier
//   - DST note: local-time bucketing; fall-back hour handled by newest-per-bucket rule
//   - A snapshot that matches no tier → pruned
//   - All tiers disabled (0) except never-prune → only never-prune-window snapshots survive
//   - Table-driven fixture: 50 synthetic snapshots at 1/day over 50 days → exact keep-set
//   - PRD/F2 AC-1: 35-day fixture with default retention → retained count within ±1 of tier math
//   - PRD/F2 AC-2: never-prune override always honored
//   - Property: monotonicity — adding older snapshots never removes a kept snapshot
//   - Property: idempotency — two runs produce identical output
//   - Property: orphan Full with no tier match and no kept descendants → pruned

import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateTiers } from '../../../src/services/retention/evaluator';
import type { SnapshotIndexEntry } from '../../../src/model/SnapshotIndex';
import type { RetentionSettings } from '../../../src/model/Settings';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

// Counter is reset before each test so IDs are unique within a test but
// cross-describe state cannot leak between tests.
let _idCounter = 0;
beforeEach(() => { _idCounter = 0; });

function makeSnapshot(
  created_at: string,
  overrides?: Partial<SnapshotIndexEntry>,
): SnapshotIndexEntry {
  _idCounter += 1;
  return {
    id: `snap-${String(_idCounter).padStart(4, '0')}`,
    type: 'full',
    parent_id: null,
    created_at,
    device_id: 'device-test',
    blob_hashes: [],
    ...overrides,
  };
}

function makeSettings(overrides?: Partial<RetentionSettings>): RetentionSettings {
  return {
    never_prune_window_days: 14,
    recent_hours: 24,
    daily_days: 30,
    monthly_years: 3,
    storage_hard_limit_gb: 200,
    storage_warn_at_percent: 80,
    ...overrides,
  };
}

// ISO-8601 helper: add N days to a UTC date string
function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// ISO-8601 helper: subtract N hours from a UTC date string
function subtractHours(isoDate: string, hours: number): string {
  const d = new Date(isoDate);
  d.setTime(d.getTime() - hours * 60 * 60 * 1000);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Never-prune window
// ---------------------------------------------------------------------------

describe('evaluateTiers — never-prune window', () => {
  it('keeps a snapshot inside the never-prune window regardless of other tiers', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // 5 days ago — well within 14-day never-prune window
    const snap = makeSnapshot('2026-04-19T12:00:00.000Z', { id: 'np-inside' });
    const settings = makeSettings({
      never_prune_window_days: 14,
      recent_hours: 0,
      daily_days: 0,
      monthly_years: 0,
    });

    const kept = evaluateTiers([snap], settings, now);

    expect(kept.has('np-inside')).toBe(true);
  });

  it('prunes a snapshot just outside the never-prune window when no other tier matches', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // 15 days ago — outside 14-day window; no other tier enabled
    const snap = makeSnapshot('2026-04-09T11:59:59.000Z', { id: 'np-outside' });
    const settings = makeSettings({
      never_prune_window_days: 14,
      recent_hours: 0,
      daily_days: 0,
      monthly_years: 0,
    });

    const kept = evaluateTiers([snap], settings, now);

    expect(kept.has('np-outside')).toBe(false);
  });

  it('keeps a snapshot exactly at the never-prune boundary (boundary = inclusive)', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // Exactly 14 days ago to the millisecond
    const snap = makeSnapshot('2026-04-10T12:00:00.000Z', { id: 'np-boundary' });
    const settings = makeSettings({
      never_prune_window_days: 14,
      recent_hours: 0,
      daily_days: 0,
      monthly_years: 0,
    });

    const kept = evaluateTiers([snap], settings, now);

    expect(kept.has('np-boundary')).toBe(true);
  });

  it('never-prune disabled (0) keeps nothing via never-prune tier', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    const snap = makeSnapshot('2026-04-23T12:00:00.000Z', { id: 'np-disabled' });
    const settings = makeSettings({
      never_prune_window_days: 0,
      recent_hours: 0,
      daily_days: 0,
      monthly_years: 0,
    });

    const kept = evaluateTiers([snap], settings, now);

    // No tier is enabled — should be pruned
    expect(kept.has('np-disabled')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Recent-hours window (sub-window inside never-prune)
// ---------------------------------------------------------------------------

describe('evaluateTiers — recent-hours window', () => {
  it('keeps a snapshot within the recent-hours window', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // 12 hours ago — inside recent_hours=24
    const snap = makeSnapshot('2026-04-24T00:00:00.000Z', { id: 'recent-in' });
    const settings = makeSettings({ never_prune_window_days: 0, recent_hours: 24, daily_days: 0, monthly_years: 0 });

    const kept = evaluateTiers([snap], settings, now);

    expect(kept.has('recent-in')).toBe(true);
  });

  it('prunes a snapshot just outside the recent-hours window when no other tier matches', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // 25 hours ago — outside recent_hours=24, outside never-prune (disabled)
    const snap = makeSnapshot('2026-04-23T11:00:00.000Z', { id: 'recent-out' });
    const settings = makeSettings({ never_prune_window_days: 0, recent_hours: 24, daily_days: 0, monthly_years: 0 });

    const kept = evaluateTiers([snap], settings, now);

    expect(kept.has('recent-out')).toBe(false);
  });

  it('recent-hours disabled (0) contributes no keeps', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    const snap = makeSnapshot('2026-04-24T11:00:00.000Z', { id: 'recent-disabled' });
    const settings = makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 });

    const kept = evaluateTiers([snap], settings, now);

    expect(kept.has('recent-disabled')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Daily tier
// ---------------------------------------------------------------------------

describe('evaluateTiers — daily tier', () => {
  it('keeps the newest snapshot in a day bucket', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // Two snapshots on 2026-04-20 — newer should be kept
    const older = makeSnapshot('2026-04-20T08:00:00.000Z', { id: 'daily-older' });
    const newer = makeSnapshot('2026-04-20T20:00:00.000Z', { id: 'daily-newer' });
    const settings = makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 30, monthly_years: 0 });

    const kept = evaluateTiers([older, newer], settings, now);

    expect(kept.has('daily-newer')).toBe(true);
    expect(kept.has('daily-older')).toBe(false);
  });

  it('prunes a snapshot whose day bucket falls outside the daily window', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // 31 days ago — outside daily_days=30
    const snap = makeSnapshot('2026-03-24T12:00:00.000Z', { id: 'daily-outside' });
    const settings = makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 30, monthly_years: 0 });

    const kept = evaluateTiers([snap], settings, now);

    expect(kept.has('daily-outside')).toBe(false);
  });

  it('keeps one snapshot per day when multiple days are in the window', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // 3 days, 2 snapshots each
    const days = ['2026-04-22', '2026-04-21', '2026-04-20'];
    const snapshots: SnapshotIndexEntry[] = [];
    const expectedKept: string[] = [];

    for (const day of days) {
      const older = makeSnapshot(`${day}T08:00:00.000Z`, { id: `${day}-early` });
      const newer = makeSnapshot(`${day}T20:00:00.000Z`, { id: `${day}-late` });
      snapshots.push(older, newer);
      expectedKept.push(newer.id);
    }

    const settings = makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 30, monthly_years: 0 });
    const kept = evaluateTiers(snapshots, settings, now);

    for (const id of expectedKept) expect(kept.has(id)).toBe(true);
    for (const s of snapshots) {
      if (!expectedKept.includes(s.id)) expect(kept.has(s.id)).toBe(false);
    }
  });

  it('daily disabled (0) contributes no keeps', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    const snap = makeSnapshot('2026-04-20T12:00:00.000Z', { id: 'daily-zero' });
    const settings = makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 });

    const kept = evaluateTiers([snap], settings, now);

    expect(kept.has('daily-zero')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Monthly tier
// ---------------------------------------------------------------------------

describe('evaluateTiers — monthly tier', () => {
  it('keeps the newest snapshot in a month bucket', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // Two snapshots in February 2026
    const older = makeSnapshot('2026-02-10T08:00:00.000Z', { id: 'monthly-older' });
    const newer = makeSnapshot('2026-02-28T20:00:00.000Z', { id: 'monthly-newer' });
    const settings = makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 3 });

    const kept = evaluateTiers([older, newer], settings, now);

    expect(kept.has('monthly-newer')).toBe(true);
    expect(kept.has('monthly-older')).toBe(false);
  });

  it('prunes a snapshot whose month bucket falls outside the monthly window', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // 3 years and 2 months ago — outside monthly_years=3 (36 months)
    const snap = makeSnapshot('2023-02-01T12:00:00.000Z', { id: 'monthly-outside' });
    const settings = makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 3 });

    const kept = evaluateTiers([snap], settings, now);

    expect(kept.has('monthly-outside')).toBe(false);
  });

  it('keeps one snapshot per month when multiple months are in the window', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // 3 months, 3 snapshots each
    const months = [
      { prefix: '2026-01', ids: ['2026-01-early', '2026-01-mid', '2026-01-late'] },
      { prefix: '2025-12', ids: ['2025-12-early', '2025-12-mid', '2025-12-late'] },
    ];
    const snapshots: SnapshotIndexEntry[] = [];
    const expectedKept: string[] = [];

    for (const m of months) {
      const times = ['T05:00:00.000Z', 'T12:00:00.000Z', 'T22:00:00.000Z'];
      for (let i = 0; i < 3; i++) {
        const day = i + 10;
        const s = makeSnapshot(`${m.prefix}-${String(day).padStart(2, '0')}${times[i]}`, { id: m.ids[i] });
        snapshots.push(s);
      }
      // Latest snapshot per month = last one (day 12, T22:00)
      expectedKept.push(m.ids[2]);
    }

    const settings = makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 3 });
    const kept = evaluateTiers(snapshots, settings, now);

    for (const id of expectedKept) expect(kept.has(id)).toBe(true);
    for (const s of snapshots) {
      if (!expectedKept.includes(s.id)) expect(kept.has(s.id)).toBe(false);
    }
  });

  it('monthly disabled (0) contributes no keeps', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    const snap = makeSnapshot('2026-01-15T12:00:00.000Z', { id: 'monthly-zero' });
    const settings = makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 0, monthly_years: 0 });

    const kept = evaluateTiers([snap], settings, now);

    expect(kept.has('monthly-zero')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Monthly cutoff: end-of-month rollover safety
// ---------------------------------------------------------------------------

describe('evaluateTiers — monthly cutoff end-of-month safety', () => {
  it('now=2026-03-31, monthly_years=1 → cutoff key is 2025-03 (no rollover skew)', () => {
    // Date.setMonth on a 31st-of-month date rolls over: new Date('2026-03-31').setMonth(-9)
    // produces 2025-04-01 (April) instead of 2025-03. Direct arithmetic must yield 2025-03.
    const now = new Date('2026-03-31T12:00:00.000Z');
    // A snapshot from March 2025 (inside 12-month window) must be kept as newest in its bucket
    const snap2025Mar = makeSnapshot('2025-03-15T12:00:00.000Z', { id: 'cutoff-march-2025' });
    // A snapshot from February 2025 (outside 12-month window) must be pruned
    const snap2025Feb = makeSnapshot('2025-02-15T12:00:00.000Z', { id: 'cutoff-feb-2025' });
    const settings = makeSettings({
      never_prune_window_days: 0,
      recent_hours: 0,
      daily_days: 0,
      monthly_years: 1,
    });

    const kept = evaluateTiers([snap2025Mar, snap2025Feb], settings, now);

    expect(kept.has('cutoff-march-2025')).toBe(true);
    expect(kept.has('cutoff-feb-2025')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No-tier-match → pruned
// ---------------------------------------------------------------------------

describe('evaluateTiers — no tier match', () => {
  it('prunes a snapshot that matches no tier', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // 60 days ago — outside all default windows
    const snap = makeSnapshot('2026-02-23T12:00:00.000Z', { id: 'no-tier' });
    const settings = makeSettings({
      never_prune_window_days: 14,
      recent_hours: 24,
      daily_days: 30,
      // Monthly: 36 months, 2026-02-23 IS within 36 months from 2026-04-24
      // Use a config that won't cover this
      monthly_years: 0,
    });

    const kept = evaluateTiers([snap], settings, now);

    // February 2026 is within 36 months normally but monthly_years=0 → disabled
    // Never-prune: 60 days > 14 → no
    // Recent: 60 days > 24h → no
    // Daily: 60 days > 30 → no
    expect(kept.has('no-tier')).toBe(false);
  });

  it('empty snapshot list → empty keep set', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    const kept = evaluateTiers([], makeSettings(), now);
    expect(kept.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// All tiers disabled except never-prune
// ---------------------------------------------------------------------------

describe('evaluateTiers — all tiers disabled except never-prune', () => {
  it('only never-prune-window snapshots survive when other tiers are 0', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    const inside = makeSnapshot('2026-04-20T12:00:00.000Z', { id: 'only-np-inside' });
    const outside = makeSnapshot('2026-03-01T12:00:00.000Z', { id: 'only-np-outside' });

    const settings = makeSettings({
      never_prune_window_days: 14,
      recent_hours: 0,
      daily_days: 0,
      monthly_years: 0,
    });

    const kept = evaluateTiers([inside, outside], settings, now);

    expect(kept.has('only-np-inside')).toBe(true);
    expect(kept.has('only-np-outside')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Orphan Full: no tier match, no kept descendants → pruned
// ---------------------------------------------------------------------------

describe('evaluateTiers — orphan Full behavior', () => {
  it('prunes an orphan Full with no tier match (chain-integrity is not applied at this layer)', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // Full from 60 days ago — outside all tier windows (with monthly disabled)
    const orphanFull = makeSnapshot('2026-02-23T12:00:00.000Z', {
      id: 'orphan-full',
      type: 'full',
      parent_id: null,
    });
    const settings = makeSettings({
      never_prune_window_days: 14,
      recent_hours: 0,
      daily_days: 30,
      monthly_years: 0,
    });

    const kept = evaluateTiers([orphanFull], settings, now);

    // evaluateTiers is tier-only; chain-integrity is T6.2's job.
    // A Full with no tier match and no dependents is NOT protected here.
    expect(kept.has('orphan-full')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Table-driven fixture: 50 snapshots over 50 days
// ---------------------------------------------------------------------------

describe('evaluateTiers — 50-snapshot table-driven fixture', () => {
  // Anchor: now = 2026-04-24T12:00:00.000Z
  // 50 snapshots: one per day for 50 consecutive days ending at day 50 = 2026-04-23T12:00:00.000Z
  // day 1  = 2026-03-05T12:00:00.000Z
  // day 50 = 2026-04-23T12:00:00.000Z
  //
  // Default settings: never_prune=14, recent=24, daily=30, monthly=3y
  //
  // Tier analysis (UTC-aligned, local time not needed since we use UTC noon):
  //   Never-prune boundary: 2026-04-24 minus 14 days = 2026-04-10T12:00:00.000Z
  //     Snapshots at or after 2026-04-10 = days 37-50 → 14 snapshots (kept by never-prune)
  //
  //   Daily window: 2026-04-24 minus 30 days = 2026-03-25T12:00:00.000Z
  //     Snapshots at or after 2026-03-25 = days 21-50 → 30 snapshots
  //     Each day has exactly 1 snapshot → all 30 are the newest in their bucket → kept by daily
  //
  //   Monthly window: 36 months back = all snapshots fall within this window
  //     Month buckets present:
  //       March 2026 (2026-03): days 1-27 = 2026-03-05 to 2026-03-31 → newest = day 27 (2026-03-31)
  //         day 27 is already kept by daily (2026-03-31 >= 2026-03-25 cutoff)
  //       April 2026 (2026-04): days 28-50 = 2026-04-01 to 2026-04-23 → newest = day 50 (2026-04-23)
  //         day 50 is already kept by daily+never-prune
  //
  //   TOTAL unique keeps: days 21-50 (daily covers all of these) = 30 snapshots
  //   Days 1-20 (2026-03-05 to 2026-03-24): not in daily, not the newest in any monthly bucket → PRUNED
  //
  // Expected keep-set size: 30

  const NOW_50 = new Date('2026-04-24T12:00:00.000Z');
  const BASE_ISO = '2026-03-05T12:00:00.000Z';

  function buildFiftySnapshots(): SnapshotIndexEntry[] {
    const result: SnapshotIndexEntry[] = [];
    for (let i = 0; i < 50; i++) {
      const created_at = addDays(BASE_ISO, i);
      result.push({
        id: `fixture-day-${String(i + 1).padStart(2, '0')}`,
        type: 'full',
        parent_id: null,
        created_at,
        device_id: 'device-fixture',
        blob_hashes: [],
      });
    }
    return result;
  }

  const FIFTY_SNAPSHOTS = buildFiftySnapshots();

  it('keeps exactly 30 snapshots (days 21-50) under default settings', () => {
    const settings = makeSettings(); // defaults: never_prune=14, recent=24, daily=30, monthly=3
    const kept = evaluateTiers(FIFTY_SNAPSHOTS, settings, NOW_50);

    // Days 21-50 should be kept
    for (let i = 20; i < 50; i++) {
      expect(kept.has(`fixture-day-${String(i + 1).padStart(2, '0')}`)).toBe(true);
    }
    // Days 1-20 should be pruned
    for (let i = 0; i < 20; i++) {
      expect(kept.has(`fixture-day-${String(i + 1).padStart(2, '0')}`)).toBe(false);
    }

    expect(kept.size).toBe(30);
  });

  it('never-prune subset is always ⊆ kept set', () => {
    const settings = makeSettings();
    const kept = evaluateTiers(FIFTY_SNAPSHOTS, settings, NOW_50);
    const neverPruneCutoffMs = NOW_50.getTime() - settings.never_prune_window_days * 24 * 60 * 60 * 1000;

    for (const s of FIFTY_SNAPSHOTS) {
      const ageMs = new Date(s.created_at).getTime();
      if (ageMs >= neverPruneCutoffMs) {
        expect(kept.has(s.id)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// PRD/F2 AC-1: 35-day fixture — retained count within ±1 of tier math
// ---------------------------------------------------------------------------

describe('evaluateTiers — PRD/F2 AC-1: 35-day fixture', () => {
  // 35 snapshots: one per day, day 1-35. now = day 35 at end of day.
  // Base: 2026-03-20T12:00:00.000Z
  // day 35 = 2026-04-23T12:00:00.000Z, now = 2026-04-24T12:00:00.000Z
  //
  // Default settings: never_prune=14, recent=24, daily=30, monthly=3y
  //
  // Tier analysis:
  //   Never-prune: >= 2026-04-10 = days 22-35 → 14 snapshots
  //   Daily (30 days, >= 2026-03-25): days 6-35 → 30 snapshots, one per day → all 30 kept
  //   Monthly:
  //     March 2026: days 1-12 (2026-03-20 to 2026-03-31), newest = day 12 (2026-03-31), already in daily
  //     April 2026: days 13-35 (2026-04-01 to 2026-04-23), newest = day 35, already in daily
  //
  //   TOTAL unique keeps: days 6-35 = 30 snapshots
  //   Days 1-5 (2026-03-20 to 2026-03-24): outside daily, not newest in March (day 12 is) → pruned
  //
  // Expected: 30 kept out of 35. PRD says "within ±1".

  const NOW_35 = new Date('2026-04-24T12:00:00.000Z');
  const BASE_35 = '2026-03-20T12:00:00.000Z';

  function buildThirtyFiveSnapshots(): SnapshotIndexEntry[] {
    const result: SnapshotIndexEntry[] = [];
    for (let i = 0; i < 35; i++) {
      result.push({
        id: `prd-day-${String(i + 1).padStart(2, '0')}`,
        type: 'full',
        parent_id: null,
        created_at: addDays(BASE_35, i),
        device_id: 'device-prd',
        blob_hashes: [],
      });
    }
    return result;
  }

  const THIRTY_FIVE_SNAPSHOTS = buildThirtyFiveSnapshots();

  it('PRD/F2 AC-1: retained count is within ±1 of tier-math expectation (30)', () => {
    const settings = makeSettings();
    const kept = evaluateTiers(THIRTY_FIVE_SNAPSHOTS, settings, NOW_35);
    // Tier math: 30 kept. PRD allows ±1.
    expect(kept.size).toBeGreaterThanOrEqual(29);
    expect(kept.size).toBeLessThanOrEqual(31);
  });

  it('PRD/F2 AC-2: snapshot within never-prune window is kept regardless of other tier configuration', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // A snapshot 3 days old — clearly inside never-prune=14
    const snap = makeSnapshot('2026-04-21T12:00:00.000Z', { id: 'prd-ac2-never-prune' });
    // Even if daily and monthly are disabled
    const settings = makeSettings({ daily_days: 0, monthly_years: 0 });
    const kept = evaluateTiers([snap], settings, now);
    expect(kept.has('prd-ac2-never-prune')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DST note: local-time bucketing
// ---------------------------------------------------------------------------

describe('evaluateTiers — DST / local-time bucketing', () => {
  // DST transitions in the US (UTC-5 → UTC-4 in spring): a 23-hour "day" exists
  // on the fall-forward date. Because we bucket by local date string, the spring
  // clock-forward produces a 23-hour day — a snapshot on that day still lands in
  // the correct bucket. The fall-back (extra hour) means two snapshots may share
  // the same local hour label; the newest-per-bucket rule picks one. Neither
  // case creates zero-bucket or 25-hour-bucket anomalies.
  //
  // This test uses UTC snapshots on known US-DST transition dates and verifies
  // that exactly one per day bucket survives.

  it('DST spring-forward: two snapshots on the transition day → newest-per-bucket kept', () => {
    const now = new Date('2026-03-10T12:00:00.000Z'); // after US DST 2026-03-08
    // Two snapshots on 2026-03-08 (spring-forward day in US Eastern)
    const earlier = makeSnapshot('2026-03-08T06:00:00.000Z', { id: 'dst-early' });
    const later = makeSnapshot('2026-03-08T18:00:00.000Z', { id: 'dst-late' });
    const settings = makeSettings({ never_prune_window_days: 30, recent_hours: 0, daily_days: 30, monthly_years: 0 });

    const kept = evaluateTiers([earlier, later], settings, now);

    // Both are in the daily window. They fall in the same day bucket.
    // Only the newest (later) is kept by daily. Both are in never-prune.
    expect(kept.has('dst-late')).toBe(true);
    // dst-early: kept by never-prune (within 30-day window), even if dropped by daily
    expect(kept.has('dst-early')).toBe(true);
  });

  it('fall-back duplicate hour: newest snapshot in the repeated hour is kept by daily', () => {
    const now = new Date('2026-11-03T12:00:00.000Z'); // after US DST fallback 2026-11-01
    // Two snapshots during fall-back: both appear to be "01:xx" local time but at different UTC times
    const first = makeSnapshot('2026-11-01T05:30:00.000Z', { id: 'dst-fallback-first' });  // 01:30 EDT
    const second = makeSnapshot('2026-11-01T06:30:00.000Z', { id: 'dst-fallback-second' }); // 01:30 EST
    const settings = makeSettings({ never_prune_window_days: 0, recent_hours: 0, daily_days: 30, monthly_years: 0 });

    const kept = evaluateTiers([first, second], settings, now);

    // Both on 2026-11-01 (same local date). Newest UTC time = second.
    expect(kept.has('dst-fallback-second')).toBe(true);
    expect(kept.has('dst-fallback-first')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property tests (hand-rolled, 20 seeded inputs)
// ---------------------------------------------------------------------------

describe('evaluateTiers — property tests', () => {
  // Seeded input generator: creates N snapshots spread over a date range
  function buildPropertySnapshots(count: number, baseDate: Date, spreadDays: number): SnapshotIndexEntry[] {
    const result: SnapshotIndexEntry[] = [];
    for (let i = 0; i < count; i++) {
      const offset = Math.floor((i / count) * spreadDays * 24 * 60 * 60 * 1000);
      const ts = new Date(baseDate.getTime() + offset);
      result.push({
        id: `prop-${i}`,
        type: i % 3 === 0 ? 'full' : 'inc',
        parent_id: i % 3 === 0 ? null : `prop-${Math.max(0, i - 1)}`,
        created_at: ts.toISOString(),
        device_id: 'device-prop',
        blob_hashes: [],
      });
    }
    return result;
  }

  it('property: monotonicity — adding an older snapshot never removes a snapshot from the kept set', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    const settings = makeSettings();

    // 20 seeded test inputs
    for (let seed = 0; seed < 20; seed++) {
      const baseDate = new Date(now.getTime() - (seed + 1) * 3 * 24 * 60 * 60 * 1000);
      const snapshots = buildPropertySnapshots(10 + seed, baseDate, 40);
      const kept1 = evaluateTiers(snapshots, settings, now);

      // Add one snapshot older than all existing ones
      const oldestTime = new Date(baseDate.getTime() - 365 * 24 * 60 * 60 * 1000);
      const olderSnap: SnapshotIndexEntry = {
        id: 'prop-extra-old',
        type: 'full',
        parent_id: null,
        created_at: oldestTime.toISOString(),
        device_id: 'device-prop',
        blob_hashes: [],
      };

      const kept2 = evaluateTiers([...snapshots, olderSnap], settings, now);

      // Every ID that was kept before must still be kept
      for (const id of kept1) {
        expect(kept2.has(id)).toBe(true);
      }
    }
  });

  it('property: idempotency — two runs with identical input produce identical output', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    const settings = makeSettings();

    for (let seed = 0; seed < 20; seed++) {
      const baseDate = new Date(now.getTime() - (seed + 2) * 2 * 24 * 60 * 60 * 1000);
      const snapshots = buildPropertySnapshots(8 + seed, baseDate, 35);

      const kept1 = evaluateTiers(snapshots, settings, now);
      const kept2 = evaluateTiers(snapshots, settings, now);

      expect(kept1.size).toBe(kept2.size);
      for (const id of kept1) expect(kept2.has(id)).toBe(true);
      for (const id of kept2) expect(kept1.has(id)).toBe(true);
    }
  });

  it('property: orphan Full with no tier match → pruned (chain-integrity not applied here)', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    // All tiers disabled → only never-prune applies
    // A Full from 200 days ago: not in any window with monthly_years=0
    const settings = makeSettings({
      never_prune_window_days: 14,
      recent_hours: 0,
      daily_days: 0,
      monthly_years: 0,
    });

    for (let seed = 0; seed < 20; seed++) {
      const daysAgo = 100 + seed * 5; // 100..195 days ago — all outside 14d never-prune
      const orphanFull: SnapshotIndexEntry = {
        id: `orphan-full-seed-${seed}`,
        type: 'full',
        parent_id: null,
        created_at: subtractHours(now.toISOString(), daysAgo * 24),
        device_id: 'device-prop',
        blob_hashes: [],
      };

      const kept = evaluateTiers([orphanFull], settings, now);

      // Outside never-prune, no other tier: should be pruned
      expect(kept.has(orphanFull.id)).toBe(false);
    }
  });

  it('property: never-prune subset ⊆ kept set holds for all 20 inputs', () => {
    const now = new Date('2026-04-24T12:00:00.000Z');
    const settings = makeSettings();

    for (let seed = 0; seed < 20; seed++) {
      const baseDate = new Date(now.getTime() - (seed + 3) * 4 * 24 * 60 * 60 * 1000);
      const snapshots = buildPropertySnapshots(15 + seed, baseDate, 45);
      const kept = evaluateTiers(snapshots, settings, now);

      const neverPruneCutoffMs = now.getTime() - settings.never_prune_window_days * 24 * 60 * 60 * 1000;
      for (const s of snapshots) {
        if (new Date(s.created_at).getTime() >= neverPruneCutoffMs) {
          expect(kept.has(s.id)).toBe(true);
        }
      }
    }
  });
});
