// T7.8 — retention estimator: pure projection used by the settings UI.

import { describe, expect, it } from 'vitest';
import { estimateRetention } from '../../../src/services/retention/estimator';
import { DEFAULT_SETTINGS } from '../../../src/model/Settings';
import type { RetentionProfile } from '../../../src/ui/settings/context';

function profile(overrides: Partial<RetentionProfile> = {}): RetentionProfile {
  return {
    vault_bytes: 50 * 1024 * 1024, // 50 MB
    avg_edits_per_day: 20,
    ...overrides,
  };
}

describe('estimateRetention — pure projection', () => {
  it('returns a non-negative snapshot count and GB', () => {
    const est = estimateRetention(profile(), DEFAULT_SETTINGS);
    expect(est.snapshots).toBeGreaterThan(0);
    expect(est.gb).toBeGreaterThan(0);
  });

  it('monotonic in monthly_years (longer retention → more snapshots)', () => {
    const small = estimateRetention(profile(), {
      ...DEFAULT_SETTINGS,
      retention: { ...DEFAULT_SETTINGS.retention, monthly_years: 1 },
    });
    const large = estimateRetention(profile(), {
      ...DEFAULT_SETTINGS,
      retention: { ...DEFAULT_SETTINGS.retention, monthly_years: 10 },
    });
    expect(large.snapshots).toBeGreaterThan(small.snapshots);
    expect(large.gb).toBeGreaterThan(small.gb);
  });

  it('monotonic in vault_bytes (bigger vault → more GB)', () => {
    const small = estimateRetention(profile({ vault_bytes: 10 * 1024 * 1024 }), DEFAULT_SETTINGS);
    const large = estimateRetention(profile({ vault_bytes: 500 * 1024 * 1024 }), DEFAULT_SETTINGS);
    expect(large.gb).toBeGreaterThan(small.gb);
  });

  it('handles zero edit-rate without NaN', () => {
    const est = estimateRetention(profile({ avg_edits_per_day: 0 }), DEFAULT_SETTINGS);
    expect(Number.isFinite(est.snapshots)).toBe(true);
    expect(Number.isFinite(est.gb)).toBe(true);
    expect(est.snapshots).toBeGreaterThanOrEqual(0);
  });

  it('handles empty vault (0 bytes) without division-by-zero', () => {
    const est = estimateRetention(profile({ vault_bytes: 0 }), DEFAULT_SETTINGS);
    expect(Number.isFinite(est.gb)).toBe(true);
    expect(est.gb).toBeGreaterThanOrEqual(0);
  });

  it('monotonic in full cadence (weekly > monthly)', () => {
    const weekly = estimateRetention(profile(), {
      ...DEFAULT_SETTINGS,
      schedule: { ...DEFAULT_SETTINGS.schedule, full_cadence: 'weekly' },
    });
    const monthly = estimateRetention(profile(), {
      ...DEFAULT_SETTINGS,
      schedule: { ...DEFAULT_SETTINGS.schedule, full_cadence: 'monthly' },
    });
    // More fulls → more snapshots AND more GB (fulls dominate the storage).
    expect(weekly.snapshots).toBeGreaterThan(monthly.snapshots);
    expect(weekly.gb).toBeGreaterThan(monthly.gb);
  });

  it('pure — repeated calls with same args return the same result', () => {
    const a = estimateRetention(profile(), DEFAULT_SETTINGS);
    const b = estimateRetention(profile(), DEFAULT_SETTINGS);
    expect(a).toEqual(b);
  });
});
