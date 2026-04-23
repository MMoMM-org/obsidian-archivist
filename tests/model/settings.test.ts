import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  isPluginSettings,
  parseSettings,
  type SettingsMigration,
} from '../../src/model/Settings';
import { ConfigError } from '../../src/model/Errors';

describe('Settings — guards', () => {
  it('DEFAULT_SETTINGS passes isPluginSettings', () => {
    expect(isPluginSettings(DEFAULT_SETTINGS)).toBe(true);
  });

  it('round-trips DEFAULT_SETTINGS through JSON', () => {
    const round = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    const { settings, migrated } = parseSettings(round);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(migrated).toBe(false);
  });

  it.each([
    ['invalid full_cadence', (s: Record<string, unknown>) => ((s.schedule as Record<string, unknown>).full_cadence = 'hourly')],
    ['full_day_of_week out of range', (s: Record<string, unknown>) => ((s.schedule as Record<string, unknown>).full_day_of_week = 9)],
    ['non-HH:MM time', (s: Record<string, unknown>) => ((s.schedule as Record<string, unknown>).full_time_of_day = '25:99')],
    ['exclusion_globs not strings', (s: Record<string, unknown>) => ((s.advanced as Record<string, unknown>).exclusion_globs = [1, 2])],
    ['missing advanced block', (s: Record<string, unknown>) => delete s.advanced],
  ])('isPluginSettings rejects: %s', (_l, mutate) => {
    const bad = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Record<string, unknown>;
    mutate(bad);
    expect(isPluginSettings(bad)).toBe(false);
  });
});

describe('Settings — migration engine (simulated schema bumps)', () => {
  // Simulate a world where CURRENT_SETTINGS_SCHEMA has advanced to '1.2' and
  // two migrations exist. Tests use the options hook so we can exercise the
  // migration engine without altering the real compile-time constants.
  const known = ['1.0', '1.1', '1.2'];

  const migrationsHappy: SettingsMigration[] = [
    // v1.0 → v1.1: adds a synthetic `extra` field.
    {
      from: '1.0' as never,
      to: '1.1' as never,
      migrate: (old) => ({ ...old, extra: true, schema_version: '1.1' }),
    },
    // v1.1 → v1.2: renames `extra` → `expanded`.
    {
      from: '1.1' as never,
      to: '1.2' as never,
      migrate: (old) => {
        const next: Record<string, unknown> = { ...old, schema_version: '1.2' };
        if ('extra' in next) {
          next.expanded = next.extra;
          delete next.extra;
        }
        return next;
      },
    },
  ];

  const v12Guard = (v: unknown): boolean =>
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).schema_version === '1.2' &&
    typeof (v as Record<string, unknown>).expanded === 'boolean';

  it('scenario 1: v1.0 blob + v1.0 target → no migration', () => {
    const result = parseSettings(DEFAULT_SETTINGS);
    expect(result.migrated).toBe(false);
    expect(result.steps).toBe(0);
  });

  it('scenario 2: v1.0 blob + v1.1 target → single migration', () => {
    const blob = { schema_version: '1.0' };
    const v11Guard = (v: unknown): boolean =>
      typeof v === 'object' &&
      v !== null &&
      (v as Record<string, unknown>).schema_version === '1.1' &&
      (v as Record<string, unknown>).extra === true;

    const result = parseSettings(blob, [migrationsHappy[0]], {
      target: '1.1',
      known: ['1.0', '1.1'],
      guard: v11Guard,
    });
    expect(result.migrated).toBe(true);
    expect(result.steps).toBe(1);
  });

  it('scenario 3: v1.0 blob + v1.2 target → two migrations in order', () => {
    const blob = { schema_version: '1.0' };
    const result = parseSettings(blob, migrationsHappy, {
      target: '1.2',
      known,
      guard: v12Guard,
    });
    expect(result.migrated).toBe(true);
    expect(result.steps).toBe(2);
    expect((result.settings as unknown as Record<string, unknown>).expanded).toBe(true);
  });

  it('scenario 4: malformed blob that no migration fixes → SETTINGS_MIGRATION_FAILED', () => {
    // A 1.0 blob with a broken migration 1.0 → 1.1 that forgets to set the
    // new required field. Guard rejects; engine reports SETTINGS_MIGRATION_FAILED.
    const blob = { schema_version: '1.0' };
    const broken: SettingsMigration[] = [
      {
        from: '1.0' as never,
        to: '1.1' as never,
        migrate: (old) => ({ ...old, schema_version: '1.1' }),
      },
    ];
    const strictGuard = (v: unknown) => v12Guard(v);
    try {
      parseSettings(blob, broken, { target: '1.1', known: ['1.0', '1.1'], guard: strictGuard });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('SETTINGS_MIGRATION_FAILED');
    }
  });

  it('scenario 5: future-version blob → SCHEMA_INCOMPATIBLE', () => {
    const future = { ...DEFAULT_SETTINGS, schema_version: '9.9' } as unknown as Record<string, unknown>;
    try {
      parseSettings(future);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('SCHEMA_INCOMPATIBLE');
      expect((err as ConfigError).message).toContain('upgrade');
    }
  });

  it('malformed (not object) → SCHEMA_INVALID', () => {
    try {
      parseSettings('not an object');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('SCHEMA_INVALID');
    }
  });

  it('migration that throws surfaces SETTINGS_MIGRATION_FAILED with cause', () => {
    const blob = { schema_version: '1.0' };
    const boom: SettingsMigration[] = [
      {
        from: '1.0' as never,
        to: '1.1' as never,
        migrate: () => {
          throw new Error('kaboom');
        },
      },
    ];
    try {
      parseSettings(blob, boom, { target: '1.1', known: ['1.0', '1.1'], guard: () => true });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('SETTINGS_MIGRATION_FAILED');
      expect((err as ConfigError).message).toContain('kaboom');
    }
  });

  it('missing migration hop → SETTINGS_MIGRATION_FAILED', () => {
    const blob = { schema_version: '1.0' };
    try {
      parseSettings(blob, [], { target: '1.2', known, guard: v12Guard });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('SETTINGS_MIGRATION_FAILED');
      expect((err as ConfigError).message).toContain('no migration registered from 1.0');
    }
  });
});
