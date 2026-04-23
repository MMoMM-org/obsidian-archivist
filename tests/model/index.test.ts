import { describe, it, expect } from 'vitest';
import {
  isLocalIndex,
  parseLocalIndex,
  emptyLocalIndex,
  type LocalIndex,
} from '../../src/model/Index';
import { ConfigError } from '../../src/model/Errors';

const valid: LocalIndex = {
  schema_version: '1.0',
  last_full_snapshot_id: '2026-04-22T03-00-full',
  last_inc_snapshot_id: null,
  last_full_commit_at: '2026-04-22T03:00:00Z',
  last_inc_commit_at: null,
  last_retention_at: null,
  index_missing_recovery_required: false,
  files: { 'a.md': { hash: 'b'.repeat(64), size: 10, mtime: 1_700_000_000_000 } },
};

describe('LocalIndex', () => {
  it('empty factory is valid', () => {
    const empty = emptyLocalIndex();
    expect(isLocalIndex(empty)).toBe(true);
    expect(parseLocalIndex(JSON.parse(JSON.stringify(empty)))).toEqual(empty);
  });

  it('round-trips valid fixture', () => {
    const round = JSON.parse(JSON.stringify(valid));
    expect(isLocalIndex(round)).toBe(true);
    expect(parseLocalIndex(round)).toEqual(valid);
  });

  it.each([
    ['missing boolean flag', (m: Record<string, unknown>) => delete m.index_missing_recovery_required, 'index_missing_recovery_required'],
    ['schema_version wrong', (m: Record<string, unknown>) => (m.schema_version = '1.1'), 'schema_version'],
    ['last_retention_at wrong type', (m: Record<string, unknown>) => (m.last_retention_at = 123), 'last_retention_at'],
    ['files is array', (m: Record<string, unknown>) => (m.files = []), 'files'],
    ['file entry malformed', (m: Record<string, unknown>) => ((m.files as Record<string, unknown>)['a.md'] = { hash: 1, size: 1, mtime: 1 }), 'files'],
  ])('rejects: %s', (_label, mutate, field) => {
    const bad = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    mutate(bad);
    expect(isLocalIndex(bad)).toBe(false);
    try {
      parseLocalIndex(bad);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain(field);
    }
  });
});
