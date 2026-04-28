import { ConfigError, configInvalid } from './Errors';

// Settings schema versions. Add future versions to the union as fields change.
// ROB-006: schema_version is a string literal union — one entry per schema
// shape, not a freewheeling string. Each version introduced here MUST have a
// matching migration in SETTINGS_MIGRATIONS below.
export type SettingsSchemaVersion = '1.0';
export const CURRENT_SETTINGS_SCHEMA: SettingsSchemaVersion = '1.0';

export interface RetentionSettings {
  never_prune_window_days: number;
  recent_hours: number;
  daily_days: number;
  monthly_years: number;
  storage_hard_limit_gb: number;
  storage_warn_at_percent: number;
}

export type FullCadence = 'weekly' | 'biweekly' | 'monthly';
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type IncIntervalMinutes = 5 | 15 | 30 | 60;

export interface ScheduleSettings {
  full_cadence: FullCadence;
  full_day_of_week: DayOfWeek;
  full_time_of_day: string;
  inc_interval_minutes: IncIntervalMinutes;
  active_window_enabled: boolean;
  active_window_start: string;
  active_window_end: string;
  startup_grace_minutes: number;
  quiet_after_event_minutes: number;
}

export interface NotificationSettings {
  preflight_notice_enabled: boolean;
  toast_after_inc: boolean;
  toast_after_full: boolean;
  toast_on_error: boolean;
}

export interface AdvancedSettings {
  reconcile_scan_enabled: boolean;
  exclusion_globs: string[];
  dry_run_mode: boolean;
  vault_prefix: string;
  diagnostic_logging: boolean;
  upload_parallelism: number;
  chunk_size_mb: number;
}

export interface UiSettings {
  preview_plugin_advisory_dismissed: boolean;
}

export interface PluginSettings {
  schema_version: SettingsSchemaVersion;
  retention: RetentionSettings;
  schedule: ScheduleSettings;
  notifications: NotificationSettings;
  advanced: AdvancedSettings;
  ui: UiSettings;
}

export interface SettingsMigration {
  from: SettingsSchemaVersion;
  to: SettingsSchemaVersion;
  migrate: (old: Record<string, unknown>) => Record<string, unknown>;
}

// Forward-migrations run before the type guard. On failure we preserve the raw
// blob as `settings.json.bak` and fall back to DEFAULT_SETTINGS — never
// silently discard user config.
export const SETTINGS_MIGRATIONS: SettingsMigration[] = [
  // Example entry (commented — no real migrations needed yet):
  // { from: '1.0', to: '1.1', migrate: (s) => ({ ...s, schema_version: '1.1' }) }
];

export const DEFAULT_SETTINGS: PluginSettings = {
  schema_version: CURRENT_SETTINGS_SCHEMA,
  retention: {
    never_prune_window_days: 14,
    recent_hours: 24,
    daily_days: 30,
    monthly_years: 3,
    storage_hard_limit_gb: 200,
    storage_warn_at_percent: 80,
  },
  schedule: {
    full_cadence: 'weekly',
    full_day_of_week: 0,
    full_time_of_day: '03:00',
    inc_interval_minutes: 15,
    active_window_enabled: false,
    active_window_start: '08:00',
    active_window_end: '22:00',
    startup_grace_minutes: 10,
    quiet_after_event_minutes: 2,
  },
  notifications: {
    preflight_notice_enabled: true,
    toast_after_inc: false,
    toast_after_full: true,
    toast_on_error: true,
  },
  advanced: {
    reconcile_scan_enabled: true,
    exclusion_globs: [],
    dry_run_mode: false,
    vault_prefix: '',
    diagnostic_logging: false,
    upload_parallelism: 2,
    chunk_size_mb: 8,
  },
  ui: {
    preview_plugin_advisory_dismissed: false,
  },
};

// ---------------------------------------------------------------------------
// Guards

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFullCadence(v: unknown): v is FullCadence {
  return v === 'weekly' || v === 'biweekly' || v === 'monthly';
}

function isDayOfWeek(v: unknown): v is DayOfWeek {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6;
}

function isIncInterval(v: unknown): v is IncIntervalMinutes {
  return v === 5 || v === 15 || v === 30 || v === 60;
}

function isHHMM(v: unknown): v is string {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

export function isRetentionSettings(v: unknown): v is RetentionSettings {
  if (!isObject(v)) return false;
  return (
    typeof v.never_prune_window_days === 'number' &&
    typeof v.recent_hours === 'number' &&
    typeof v.daily_days === 'number' &&
    typeof v.monthly_years === 'number' &&
    typeof v.storage_hard_limit_gb === 'number' &&
    typeof v.storage_warn_at_percent === 'number'
  );
}

export function isScheduleSettings(v: unknown): v is ScheduleSettings {
  if (!isObject(v)) return false;
  return (
    isFullCadence(v.full_cadence) &&
    isDayOfWeek(v.full_day_of_week) &&
    isHHMM(v.full_time_of_day) &&
    isIncInterval(v.inc_interval_minutes) &&
    typeof v.active_window_enabled === 'boolean' &&
    isHHMM(v.active_window_start) &&
    isHHMM(v.active_window_end) &&
    typeof v.startup_grace_minutes === 'number' &&
    typeof v.quiet_after_event_minutes === 'number'
  );
}

export function isNotificationSettings(v: unknown): v is NotificationSettings {
  if (!isObject(v)) return false;
  return (
    typeof v.preflight_notice_enabled === 'boolean' &&
    typeof v.toast_after_inc === 'boolean' &&
    typeof v.toast_after_full === 'boolean' &&
    typeof v.toast_on_error === 'boolean'
  );
}

export function isAdvancedSettings(v: unknown): v is AdvancedSettings {
  if (!isObject(v)) return false;
  return (
    typeof v.reconcile_scan_enabled === 'boolean' &&
    isStringArray(v.exclusion_globs) &&
    typeof v.dry_run_mode === 'boolean' &&
    typeof v.vault_prefix === 'string' &&
    typeof v.diagnostic_logging === 'boolean' &&
    typeof v.upload_parallelism === 'number' &&
    typeof v.chunk_size_mb === 'number'
  );
}

export function isUiSettings(v: unknown): v is UiSettings {
  if (!isObject(v)) return false;
  return typeof v.preview_plugin_advisory_dismissed === 'boolean';
}

export function isPluginSettings(v: unknown): v is PluginSettings {
  if (!isObject(v)) return false;
  return (
    v.schema_version === CURRENT_SETTINGS_SCHEMA &&
    isRetentionSettings(v.retention) &&
    isScheduleSettings(v.schedule) &&
    isNotificationSettings(v.notifications) &&
    isAdvancedSettings(v.advanced) &&
    isUiSettings(v.ui)
  );
}

// ---------------------------------------------------------------------------
// Parse + migrate

const KNOWN_VERSIONS: readonly string[] = ['1.0'];

export interface ParseSettingsResult {
  settings: PluginSettings;
  migrated: boolean;
  steps: number;
}

/**
 * Internal options — exposed so tests can simulate future schema versions
 * without mutating the compile-time constants. Production code calls the
 * 1-arg variant; tests pass a custom target + known-versions list to
 * exercise the migration engine faithfully.
 */
export interface ParseSettingsOptions {
  target?: string;
  known?: readonly string[];
  guard?: (v: unknown) => boolean;
}

/**
 * parseSettings applies SETTINGS_MIGRATIONS in order when the stored
 * schema_version is older than the current one, then validates the shape.
 *
 * On failure modes:
 *  - blob is not an object → ConfigError('SCHEMA_INVALID')
 *  - stored version is newer than the plugin knows about →
 *    ConfigError('SCHEMA_INCOMPATIBLE') with an upgrade hint
 *  - a migration throws or the post-migration shape still fails the guard →
 *    ConfigError('SETTINGS_MIGRATION_FAILED'); callers are expected to
 *    preserve the raw blob as `settings.json.bak` and fall back to
 *    DEFAULT_SETTINGS (PluginStore handles that side-effect — the parser
 *    stays pure and throws instead of returning defaults itself, so no
 *    caller silently overwrites user config).
 */
export function parseSettings(
  raw: unknown,
  migrations: SettingsMigration[] = SETTINGS_MIGRATIONS,
  options: ParseSettingsOptions = {},
): ParseSettingsResult {
  if (!isObject(raw)) throw configInvalid('settings', 'expected object');

  const target = options.target ?? CURRENT_SETTINGS_SCHEMA;
  const known = options.known ?? KNOWN_VERSIONS;
  const guard = options.guard ?? isPluginSettings;

  const storedVersion = raw.schema_version;
  if (typeof storedVersion !== 'string')
    throw configInvalid('settings.schema_version', 'expected string');

  if (!known.includes(storedVersion)) {
    if (storedVersion > target) {
      throw new ConfigError(
        'SCHEMA_INCOMPATIBLE',
        `settings schema ${storedVersion} is newer than this plugin understands (${target}). Please upgrade the plugin.`,
        false,
      );
    }
    throw configInvalid('settings.schema_version', `unknown version ${JSON.stringify(storedVersion)}`);
  }

  let current: Record<string, unknown> = { ...raw };
  let steps = 0;
  const maxSteps = known.length + migrations.length + 1;

  while (current.schema_version !== target) {
    const nextHop = migrations.find((m) => m.from === current.schema_version);
    if (!nextHop) {
      throw new ConfigError(
        'SETTINGS_MIGRATION_FAILED',
        `no migration registered from ${String(current.schema_version)}`,
        false,
      );
    }
    try {
      current = nextHop.migrate(current);
    } catch (err) {
      throw new ConfigError(
        'SETTINGS_MIGRATION_FAILED',
        `migration ${nextHop.from} → ${nextHop.to} threw: ${err instanceof Error ? err.message : String(err)}`,
        false,
        err,
      );
    }
    if (current.schema_version !== nextHop.to) {
      throw new ConfigError(
        'SETTINGS_MIGRATION_FAILED',
        `migration ${nextHop.from} → ${nextHop.to} did not set schema_version to ${nextHop.to}`,
        false,
      );
    }
    steps += 1;
    if (steps > maxSteps) {
      throw new ConfigError('SETTINGS_MIGRATION_FAILED', 'migration chain did not terminate', false);
    }
  }

  if (!guard(current)) {
    throw new ConfigError(
      'SETTINGS_MIGRATION_FAILED',
      'post-migration settings shape failed validation',
      false,
    );
  }

  return { settings: current as unknown as PluginSettings, migrated: steps > 0, steps };
}
