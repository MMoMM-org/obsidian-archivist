import { describe, it, expect } from 'vitest';
import {
  isSnapshotIndex,
  parseSnapshotIndex,
  type SnapshotIndex,
} from '../../src/model/SnapshotIndex';
import { ConfigError } from '../../src/model/Errors';

const valid: SnapshotIndex = {
  schema_version: '1.0',
  last_updated_at: '2026-04-23T03:05:00Z',
  snapshots: [
    {
      id: '2026-04-23T03-00-full',
      type: 'full',
      parent_id: null,
      created_at: '2026-04-23T03:00:00Z',
      device_id: 'dev-1',
      blob_hashes: ['a'.repeat(64), 'b'.repeat(64)],
    },
    {
      id: '2026-04-23T03-15-inc',
      type: 'inc',
      parent_id: '2026-04-23T03-00-full',
      created_at: '2026-04-23T03:15:00Z',
      device_id: 'dev-1',
      blob_hashes: [],
    },
  ],
};

describe('SnapshotIndex', () => {
  it('round-trips valid fixture', () => {
    const round = JSON.parse(JSON.stringify(valid));
    expect(isSnapshotIndex(round)).toBe(true);
    expect(parseSnapshotIndex(round)).toEqual(valid);
  });

  it.each([
    ['schema_version wrong', (m: Record<string, unknown>) => (m.schema_version = '1.1'), 'schema_version'],
    ['snapshots not array', (m: Record<string, unknown>) => (m.snapshots = {}), 'snapshots'],
    ['entry missing id', (m: Record<string, unknown>) => (((m.snapshots as unknown[])[0] as Record<string, unknown>).id = undefined), 'snapshots[0].id'],
    ['entry wrong type', (m: Record<string, unknown>) => (((m.snapshots as unknown[])[0] as Record<string, unknown>).type = 'daily'), 'snapshots[0].type'],
    ['blob_hashes not string[]', (m: Record<string, unknown>) => (((m.snapshots as unknown[])[0] as Record<string, unknown>).blob_hashes = [1, 2]), 'snapshots[0].blob_hashes'],
  ])('rejects: %s', (_label, mutate, field) => {
    const bad = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    mutate(bad);
    expect(isSnapshotIndex(bad)).toBe(false);
    try {
      parseSnapshotIndex(bad);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain(field);
    }
  });
});
