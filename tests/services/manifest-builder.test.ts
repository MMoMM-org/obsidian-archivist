// T5.2 — ManifestBuilder: pure functions producing SnapshotManifest for full and inc snapshots.
//
// Test coverage:
//   - buildFullManifest: 3 files → type='full', parent_id=null, files has 3 entries, deleted=[], renames=[]
//   - buildFullManifest: id format from createdAt '2026-04-23T14:00:00.000Z' → '2026-04-23T14-00-full'
//   - buildFullManifest: empty vaultFiles → still valid with files={}
//   - buildFullManifest: missing hash throws
//   - buildFullManifest: exclusionsApplied null by default
//   - buildFullManifest: output passes isSnapshotManifest()
//   - buildIncManifest: modify-only → files has entry, deleted=[], renames=[]
//   - buildIncManifest: delete-only → files={}, deleted=['a.md'], renames=[]
//   - buildIncManifest: rename-only → files={}, renames=[{from,to}], deleted=[]
//   - buildIncManifest: rename + edit same file → files has 'b.md' (not 'a.md'), renames carried through
//   - buildIncManifest: id format matches SNAPSHOT_ID_REGEX with '-inc' suffix
//   - buildIncManifest: output passes isSnapshotManifest()

import { describe, expect, it } from 'vitest';
import { buildFullManifest, buildIncManifest } from '../../src/services/ManifestBuilder';
import type { BuildFullManifestInput, BuildIncManifestInput } from '../../src/services/ManifestBuilder';
import { isSnapshotManifest } from '../../src/model/Manifest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SNAPSHOT_ID_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-(full|inc)$/;

const CREATED_AT_FULL = '2026-04-23T14:00:00.000Z';
const CREATED_AT_INC = '2026-04-23T15:30:00.000Z';
const DEVICE_ID = 'device-abc-123';
const VAULT_NAME = 'MyVault';
const VAULT_PREFIX = 'my-vault';
const PARENT_ID = '2026-04-23T14-00-full';

const THREE_FILES = [
  { path: 'notes/a.md', mtime: 1000, size: 100 },
  { path: 'notes/b.md', mtime: 2000, size: 200 },
  { path: 'daily/2026-04-23.md', mtime: 3000, size: 300 },
];

const THREE_HASHES = new Map([
  ['notes/a.md', 'aaaa0000'],
  ['notes/b.md', 'bbbb1111'],
  ['daily/2026-04-23.md', 'cccc2222'],
]);

function makeFullInput(overrides?: Partial<BuildFullManifestInput>): BuildFullManifestInput {
  return {
    vaultFiles: THREE_FILES,
    hashes: THREE_HASHES,
    vaultName: VAULT_NAME,
    vaultPrefix: VAULT_PREFIX,
    deviceId: DEVICE_ID,
    createdAt: CREATED_AT_FULL,
    ...overrides,
  };
}

function makeIncInput(overrides?: Partial<BuildIncManifestInput>): BuildIncManifestInput {
  return {
    parentId: PARENT_ID,
    changes: [],
    deleted: [],
    renames: [],
    vaultName: VAULT_NAME,
    vaultPrefix: VAULT_PREFIX,
    deviceId: DEVICE_ID,
    createdAt: CREATED_AT_INC,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildFullManifest
// ---------------------------------------------------------------------------

describe('buildFullManifest', () => {
  it('produces type=full, parent_id=null, schema_version=1.0', () => {
    const manifest = buildFullManifest(makeFullInput());
    expect(manifest.type).toBe('full');
    expect(manifest.parent_id).toBeNull();
    expect(manifest.schema_version).toBe('1.0');
  });

  it('files map covers every input file with correct hash/size/mtime', () => {
    const manifest = buildFullManifest(makeFullInput());
    expect(Object.keys(manifest.files)).toHaveLength(3);
    expect(manifest.files['notes/a.md']).toEqual({ hash: 'aaaa0000', size: 100, mtime: 1000 });
    expect(manifest.files['notes/b.md']).toEqual({ hash: 'bbbb1111', size: 200, mtime: 2000 });
    expect(manifest.files['daily/2026-04-23.md']).toEqual({ hash: 'cccc2222', size: 300, mtime: 3000 });
  });

  it('deleted=[] and renames=[] for full snapshot', () => {
    const manifest = buildFullManifest(makeFullInput());
    expect(manifest.deleted).toEqual([]);
    expect(manifest.renames).toEqual([]);
  });

  it('carries vault_name, vault_prefix, device_id, created_at', () => {
    const manifest = buildFullManifest(makeFullInput());
    expect(manifest.vault_name).toBe(VAULT_NAME);
    expect(manifest.vault_prefix).toBe(VAULT_PREFIX);
    expect(manifest.device_id).toBe(DEVICE_ID);
    expect(manifest.created_at).toBe(CREATED_AT_FULL);
  });

  it('id format: replaces : with - in time portion, strips fractional+tz, appends -full', () => {
    const manifest = buildFullManifest(makeFullInput());
    expect(manifest.id).toBe('2026-04-23T14-00-full');
  });

  it('id matches SNAPSHOT_ID_REGEX', () => {
    const manifest = buildFullManifest(makeFullInput());
    expect(manifest.id).toMatch(SNAPSHOT_ID_REGEX);
  });

  it('empty vaultFiles → files={}, still valid', () => {
    const manifest = buildFullManifest(makeFullInput({ vaultFiles: [], hashes: new Map() }));
    expect(manifest.files).toEqual({});
    expect(manifest.type).toBe('full');
  });

  it('missing hash for a vaultFile → throws', () => {
    const badHashes = new Map([['notes/a.md', 'aaaa0000']]); // missing b.md and daily
    expect(() => buildFullManifest(makeFullInput({ hashes: badHashes }))).toThrow();
  });

  it('exclusionsApplied defaults to null when omitted', () => {
    const manifest = buildFullManifest(makeFullInput());
    expect(manifest.exclusions_applied).toBeNull();
  });

  it('exclusionsApplied is preserved when provided', () => {
    const manifest = buildFullManifest(makeFullInput({ exclusionsApplied: ['*.tmp', '.DS_Store'] }));
    expect(manifest.exclusions_applied).toEqual(['*.tmp', '.DS_Store']);
  });

  it('output passes isSnapshotManifest()', () => {
    const manifest = buildFullManifest(makeFullInput());
    expect(isSnapshotManifest(manifest)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildIncManifest
// ---------------------------------------------------------------------------

describe('buildIncManifest', () => {
  it('type=inc, parent_id points at parentId, schema_version=1.0', () => {
    const manifest = buildIncManifest(makeIncInput());
    expect(manifest.type).toBe('inc');
    expect(manifest.parent_id).toBe(PARENT_ID);
    expect(manifest.schema_version).toBe('1.0');
  });

  it('modify-only: one change → files has entry, deleted=[], renames=[]', () => {
    const manifest = buildIncManifest(makeIncInput({
      changes: [{ type: 'modify', path: 'notes/a.md', hash: 'newhash', size: 150, mtime: 9999 }],
    }));
    expect(manifest.files['notes/a.md']).toEqual({ hash: 'newhash', size: 150, mtime: 9999 });
    expect(manifest.deleted).toEqual([]);
    expect(manifest.renames).toEqual([]);
  });

  it('delete-only: deleted=[a.md] → files={}, deleted=[a.md], renames=[]', () => {
    const manifest = buildIncManifest(makeIncInput({ deleted: ['a.md'] }));
    expect(manifest.files).toEqual({});
    expect(manifest.deleted).toEqual(['a.md']);
    expect(manifest.renames).toEqual([]);
  });

  it('rename-only: renames=[{from,to}] → files={}, renames=[{from,to}], deleted=[]', () => {
    const manifest = buildIncManifest(makeIncInput({
      renames: [{ from: 'a.md', to: 'b.md' }],
    }));
    expect(manifest.files).toEqual({});
    expect(manifest.renames).toEqual([{ from: 'a.md', to: 'b.md' }]);
    expect(manifest.deleted).toEqual([]);
  });

  it('rename + edit same file: change.path=b.md AND rename {from:a.md,to:b.md} → files has b.md only', () => {
    const manifest = buildIncManifest(makeIncInput({
      changes: [{ type: 'modify', path: 'b.md', hash: 'eeeee', size: 50, mtime: 5000 }],
      renames: [{ from: 'a.md', to: 'b.md' }],
    }));
    expect(manifest.files['b.md']).toEqual({ hash: 'eeeee', size: 50, mtime: 5000 });
    expect(manifest.files['a.md']).toBeUndefined();
    expect(manifest.renames).toEqual([{ from: 'a.md', to: 'b.md' }]);
  });

  it('id format matches SNAPSHOT_ID_REGEX with -inc suffix', () => {
    const manifest = buildIncManifest(makeIncInput());
    expect(manifest.id).toMatch(SNAPSHOT_ID_REGEX);
    expect(manifest.id).toMatch(/-inc$/);
  });

  it('id: createdAt 2026-04-23T15:30:00.000Z → 2026-04-23T15-30-inc', () => {
    const manifest = buildIncManifest(makeIncInput());
    expect(manifest.id).toBe('2026-04-23T15-30-inc');
  });

  it('no changes/renames/deletes → empty arrays (still valid)', () => {
    const manifest = buildIncManifest(makeIncInput());
    expect(manifest.files).toEqual({});
    expect(manifest.deleted).toEqual([]);
    expect(manifest.renames).toEqual([]);
  });

  it('exclusionsApplied defaults to null', () => {
    const manifest = buildIncManifest(makeIncInput());
    expect(manifest.exclusions_applied).toBeNull();
  });

  it('mixed: create + delete + rename in same inc', () => {
    const manifest = buildIncManifest(makeIncInput({
      changes: [
        { type: 'create', path: 'new.md', hash: 'newfilehash', size: 10, mtime: 1 },
        { type: 'modify', path: 'c.md', hash: 'chash', size: 20, mtime: 2 },
      ],
      deleted: ['old.md'],
      renames: [{ from: 'x.md', to: 'y.md' }],
    }));
    expect(Object.keys(manifest.files)).toHaveLength(2);
    expect(manifest.files['new.md']).toBeDefined();
    expect(manifest.files['c.md']).toBeDefined();
    expect(manifest.deleted).toEqual(['old.md']);
    expect(manifest.renames).toEqual([{ from: 'x.md', to: 'y.md' }]);
  });

  it('output passes isSnapshotManifest()', () => {
    const manifest = buildIncManifest(makeIncInput({
      changes: [{ type: 'modify', path: 'z.md', hash: 'zhash', size: 5, mtime: 10 }],
    }));
    expect(isSnapshotManifest(manifest)).toBe(true);
  });
});
