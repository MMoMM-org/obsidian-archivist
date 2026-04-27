// Backup Schedule section (T7.7 — PRD F1 / F5 / SDD ScheduleSettings).
//
// Fields:
//   - Designated-device toggle (→ DeviceCoordinator takeOwnership/release)
//   - Device ID (readonly, first 6 chars displayed, full UUID copyable)
//   - Full cadence dropdown (weekly / biweekly / monthly)
//   - Full day-of-week dropdown
//   - Full time-of-day (HH:MM text with regex validation)
//   - Incremental interval dropdown (5 / 15 / 30 / 60 min)
//   - Startup grace period (number input, 1–60 min)
//   - Quiet period after edits (number input, 1–30 min)
//   - Active-window toggle + two time pickers (disabled unless toggle on)

import type { SectionHost } from '../SectionHost';
import type { SettingsContext } from '../context';
import { S } from '../../strings';
import type { FullCadence, DayOfWeek, IncIntervalMinutes } from '../../../model/Settings';

const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

const DAY_OF_WEEK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
];

const CADENCE_OPTIONS: Array<{ value: FullCadence; label: string }> = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly' },
];

const INC_INTERVAL_OPTIONS: Array<{ value: IncIntervalMinutes; label: string }> = [
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
];

export function renderBackupSchedule(host: SectionHost, ctx: SettingsContext): void {
  host.heading(S.SETTINGS_SECTION_SCHEDULE);

  const settings = ctx.getSettings();

  // ---- Designated-device toggle -------------------------------------------
  host.field({
    kind: 'toggle',
    label: S.SETTINGS_DESIGNATED_TOGGLE,
    value: ctx.deviceDesignated,
    onChange: (on) => {
      if (on) void ctx.device.takeOwnership();
      else void ctx.device.releaseOwnership();
    },
  });

  // ---- Device ID (read-only, first-6 display, full UUID copyable) ---------
  const shortId = ctx.deviceId.slice(0, 6);
  host.field({
    kind: 'readonly',
    label: 'Device ID',
    value: shortId,
    copyable: true,
    description: 'Used for multi-device coordination. Copies the full ID to clipboard.',
  });

  // ---- Full backup cadence / day / time -----------------------------------
  host.field({
    kind: 'dropdown',
    label: S.SETTINGS_FULL_CADENCE,
    value: settings.schedule.full_cadence,
    options: CADENCE_OPTIONS,
    onChange: (v) => {
      void ctx.updateSettings({
        schedule: { ...settings.schedule, full_cadence: v as FullCadence },
      });
    },
  });

  host.field({
    kind: 'dropdown',
    label: 'Full backup day',
    value: String(settings.schedule.full_day_of_week),
    options: DAY_OF_WEEK_OPTIONS,
    onChange: (v) => {
      void ctx.updateSettings({
        schedule: { ...settings.schedule, full_day_of_week: Number(v) as DayOfWeek },
      });
    },
  });

  host.field({
    kind: 'text',
    label: S.SETTINGS_FULL_TIME,
    value: settings.schedule.full_time_of_day,
    placeholder: 'HH:MM',
    onChange: (v) => {
      void ctx.updateSettings({
        schedule: { ...settings.schedule, full_time_of_day: v },
      });
    },
    validate: (v) => (HHMM_REGEX.test(v) ? null : 'Expected HH:MM (24-hour).'),
  });

  // ---- Incremental interval -----------------------------------------------
  host.field({
    kind: 'dropdown',
    label: S.SETTINGS_INC_INTERVAL,
    value: String(settings.schedule.inc_interval_minutes),
    options: INC_INTERVAL_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
    onChange: (v) => {
      void ctx.updateSettings({
        schedule: {
          ...settings.schedule,
          inc_interval_minutes: Number(v) as IncIntervalMinutes,
        },
      });
    },
  });

  // ---- Grace + quiet timers -----------------------------------------------
  host.field({
    kind: 'number',
    label: S.SETTINGS_STARTUP_GRACE,
    value: settings.schedule.startup_grace_minutes,
    min: 1,
    max: 60,
    onChange: (v) => {
      void ctx.updateSettings({
        schedule: { ...settings.schedule, startup_grace_minutes: v },
      });
    },
  });

  host.field({
    kind: 'number',
    label: S.SETTINGS_QUIET_PERIOD,
    value: settings.schedule.quiet_after_event_minutes,
    min: 1,
    max: 30,
    onChange: (v) => {
      void ctx.updateSettings({
        schedule: { ...settings.schedule, quiet_after_event_minutes: v },
      });
    },
  });

  // ---- Active-window toggle + conditional time pickers --------------------
  host.field({
    kind: 'toggle',
    label: 'Active backup window',
    description: 'Limit backups to a daily time window (e.g. 08:00–22:00).',
    value: settings.schedule.active_window_enabled,
    onChange: (on) => {
      void ctx.updateSettings({
        schedule: { ...settings.schedule, active_window_enabled: on },
      });
    },
  });

  if (settings.schedule.active_window_enabled) {
    host.field({
      kind: 'text',
      label: 'Active window start',
      value: settings.schedule.active_window_start,
      placeholder: 'HH:MM',
      onChange: (v) => {
        void ctx.updateSettings({
          schedule: { ...settings.schedule, active_window_start: v },
        });
      },
      validate: (v) => (HHMM_REGEX.test(v) ? null : 'Expected HH:MM (24-hour).'),
    });

    host.field({
      kind: 'text',
      label: 'Active window end',
      value: settings.schedule.active_window_end,
      placeholder: 'HH:MM',
      onChange: (v) => {
        void ctx.updateSettings({
          schedule: { ...settings.schedule, active_window_end: v },
        });
      },
      validate: (v) => (HHMM_REGEX.test(v) ? null : 'Expected HH:MM (24-hour).'),
    });
  }
}
