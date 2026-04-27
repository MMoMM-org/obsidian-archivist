// Retention section (T7.8 — PRD F2 / S3 / SDD storage_warn).
//
// Four tier inputs + recent_hours sub-control, storage hard-limit, warn-%,
// and a live-recomputing estimate row.
//
// Storage warning: if dropboxUsedBytes >= warn_percent * hard_limit_gb * GB,
// a persistent warning banner is prepended (shown above the section).
// Clicking "storage" from a top-tab banner also drops the user here.

import type { SectionHost } from '../SectionHost';
import type { SettingsContext } from '../context';
import { S } from '../../strings';
import type { RetentionSettings } from '../../../model/Settings';

const GB = 1024 * 1024 * 1024;

export function renderRetention(host: SectionHost, ctx: SettingsContext): void {
  host.heading(S.SETTINGS_SECTION_RETENTION);

  const settings = ctx.getSettings();
  const r = settings.retention;

  // ---- Storage warning banner (section-level) -----------------------------
  const warnThresholdBytes = (r.storage_warn_at_percent / 100) * r.storage_hard_limit_gb * GB;
  if (ctx.dropboxUsedBytes >= warnThresholdBytes && warnThresholdBytes > 0) {
    const pct = Math.round((ctx.dropboxUsedBytes / (r.storage_hard_limit_gb * GB)) * 100);
    host.field({
      kind: 'banner',
      code: 'STORAGE',
      message: S.STORAGE_LIMIT_WARN(pct),
      severity: 'warn',
    });
  }

  // ---- Tier inputs --------------------------------------------------------
  host.field({
    kind: 'number',
    label: S.SETTINGS_RETENTION_RECENT_HOURS,
    description: 'Keep every snapshot captured in the last N hours (0–168).',
    value: r.recent_hours,
    min: 0,
    max: 168,
    onChange: (v) => {
      void ctx.updateSettings({ retention: mergeRetention(r, { recent_hours: v }) });
    },
  });

  host.field({
    kind: 'number',
    label: S.SETTINGS_RETENTION_NEVER_PRUNE,
    description: 'Keep every snapshot in this window (0–14 days).',
    value: r.never_prune_window_days,
    min: 0,
    max: 14,
    onChange: (v) => {
      void ctx.updateSettings({ retention: mergeRetention(r, { never_prune_window_days: v }) });
    },
  });

  host.field({
    kind: 'number',
    label: S.SETTINGS_RETENTION_DAILY_DAYS,
    description: 'After the never-prune window, keep one snapshot per day (0–90).',
    value: r.daily_days,
    min: 0,
    max: 90,
    onChange: (v) => {
      void ctx.updateSettings({ retention: mergeRetention(r, { daily_days: v }) });
    },
  });

  host.field({
    kind: 'number',
    label: S.SETTINGS_RETENTION_MONTHLY_YEARS,
    description: 'After daily window, keep one per month (0–10 years).',
    value: r.monthly_years,
    min: 0,
    max: 10,
    onChange: (v) => {
      void ctx.updateSettings({ retention: mergeRetention(r, { monthly_years: v }) });
    },
  });

  // ---- Storage cap + warn percent ----------------------------------------
  host.field({
    kind: 'number',
    label: S.SETTINGS_STORAGE_HARD_LIMIT,
    value: r.storage_hard_limit_gb,
    min: 1,
    max: 10_000,
    onChange: (v) => {
      void ctx.updateSettings({ retention: mergeRetention(r, { storage_hard_limit_gb: v }) });
    },
  });

  host.field({
    kind: 'number',
    label: S.SETTINGS_STORAGE_WARN_AT,
    value: r.storage_warn_at_percent,
    min: 50,
    max: 99,
    onChange: (v) => {
      void ctx.updateSettings({ retention: mergeRetention(r, { storage_warn_at_percent: v }) });
    },
  });

  // ---- Live estimate row --------------------------------------------------
  const profile = ctx.getRetentionProfile();
  const est = ctx.estimateRetention(profile, settings);
  host.field({
    kind: 'static',
    text: `Estimate: ~${est.snapshots} snapshots kept, ~${est.gb} GB. Based on last 7-day edit rate.`,
  });
}

function mergeRetention(
  current: RetentionSettings,
  patch: Partial<RetentionSettings>,
): RetentionSettings {
  return { ...current, ...patch };
}
