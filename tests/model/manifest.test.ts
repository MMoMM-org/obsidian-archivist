import { describe, it, expect } from 'vitest';
import {
  isSnapshotManifest,
  parseSnapshotManifest,
  type SnapshotManifest,
} from '../../src/model/Manifest';
import { ConfigError } from '../../src/model/Errors';

const validManifest: SnapshotManifest = {
  schema_version: '1.0',
  id: '2026-04-23T03-00-full',
  type: 'full',
  parent_id: null,
  device_id: '11111111-2222-3333-4444-555555555555',
  created_at: '2026-04-23T03:00:00Z',
  vault_name: 'My Vault',
  vault_prefix: 'my-vault',
  files: {
    'Notes/hello.md': { hash: 'a'.repeat(64), size: 128, mtime: 1_700_000_000_000 },
  },
  deleted: [],
  renames: [],
  exclusions_applied: ['.trash/**'],
};

describe('SnapshotManifest', () => {
  it('round-trips valid fixture through JSON and guard', () => {
    const round = JSON.parse(JSON.stringify(validManifest));
    expect(isSnapshotManifest(round)).toBe(true);
    const parsed = parseSnapshotManifest(round);
    expect(parsed).toEqual(validManifest);
  });

  it('accepts an inc manifest with deleted + renames', () => {
    const inc: SnapshotManifest = {
      ...validManifest,
      id: '2026-04-23T03-15-inc',
      type: 'inc',
      parent_id: validManifest.id,
      deleted: ['Notes/old.md'],
      renames: [{ from: 'a.md', to: 'b.md' }],
      exclusions_applied: null,
    };
    expect(isSnapshotManifest(inc)).toBe(true);
    expect(parseSnapshotManifest(inc)).toEqual(inc);
  });

  it.each([
    ['missing schema_version', (m: Record<string, unknown>) => delete m.schema_version, 'schema_version'],
    ['wrong schema_version', (m: Record<string, unknown>) => (m.schema_version = '2.0'), 'schema_version'],
    ['bad type', (m: Record<string, unknown>) => (m.type = 'weekly'), 'type'],
    ['non-string id', (m: Record<string, unknown>) => (m.id = 123), 'id'],
    ['files is array', (m: Record<string, unknown>) => (m.files = []), 'files'],
    ['file entry missing hash', (m: Record<string, unknown>) => ((m.files as Record<string, unknown>)['Notes/hello.md'] = { size: 1, mtime: 1 }), 'files'],
    ['deleted not array', (m: Record<string, unknown>) => (m.deleted = 'nope'), 'deleted'],
    ['renames wrong shape', (m: Record<string, unknown>) => (m.renames = [{ from: 'a' }]), 'renames'],
  ])('rejects: %s', (_label, mutate, fieldFragment) => {
    const bad = JSON.parse(JSON.stringify(validManifest)) as Record<string, unknown>;
    mutate(bad);
    expect(isSnapshotManifest(bad)).toBe(false);
    try {
      parseSnapshotManifest(bad);
      throw new Error('expected parseSnapshotManifest to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('SCHEMA_INVALID');
      expect((err as ConfigError).message).toContain(fieldFragment);
    }
  });

  it('rejects non-object input', () => {
    expect(() => parseSnapshotManifest(null)).toThrow(ConfigError);
    expect(() => parseSnapshotManifest('string')).toThrow(ConfigError);
    expect(() => parseSnapshotManifest([])).toThrow(ConfigError);
  });
});
