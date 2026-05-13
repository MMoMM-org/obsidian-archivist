// Self-tests for the SecretStorage mock in obsidian-mock.ts.
// Pins the observed Obsidian behaviour (probed on macOS 2026-05-13, see ADR-21
// Verified Behavior in solution.md) so the production tests can trust the
// fixture instead of re-asserting these semantics each time.

import { beforeEach, describe, expect, it } from 'vitest';

import { App, SecretStorage } from '../fixtures/obsidian-mock';

describe('obsidian-mock SecretStorage', () => {
  let ss: SecretStorage;

  beforeEach(() => {
    ss = new SecretStorage();
  });

  describe('round-trip', () => {
    it('returns null for a never-set id', () => {
      expect(ss.getSecret('archivist-never-set')).toBeNull();
    });

    it('round-trips a set value', () => {
      ss.setSecret('archivist-dropbox-tokens', 'hello-world');
      expect(ss.getSecret('archivist-dropbox-tokens')).toBe('hello-world');
    });

    it('lists ids that have been set', () => {
      ss.setSecret('archivist-a', 'x');
      ss.setSecret('archivist-b', 'y');
      expect(ss.listSecrets().sort()).toEqual(['archivist-a', 'archivist-b']);
    });

    it('overwrites a value with a subsequent set', () => {
      ss.setSecret('archivist-x', 'first');
      ss.setSecret('archivist-x', 'second');
      expect(ss.getSecret('archivist-x')).toBe('second');
    });
  });

  describe('clear semantics (Q2 — ADR-21)', () => {
    // Pinned by the 2026-05-13 macOS probe: setSecret(id, '') does NOT remove
    // the id; getSecret returns the literal ''; listSecrets still contains it.
    // TokenStore.load() must therefore treat '' as "absent" just like null.

    it('setSecret(id, "") leaves the id present and returns "" on read', () => {
      ss.setSecret('archivist-dropbox-tokens', 'token-value');
      ss.setSecret('archivist-dropbox-tokens', '');
      expect(ss.getSecret('archivist-dropbox-tokens')).toBe('');
    });

    it('id remains in listSecrets after clearing to ""', () => {
      ss.setSecret('archivist-dropbox-tokens', 'token-value');
      ss.setSecret('archivist-dropbox-tokens', '');
      expect(ss.listSecrets()).toContain('archivist-dropbox-tokens');
    });

    it('an id never set returns null, not ""', () => {
      // Disambiguates "cleared but present" from "never existed".
      ss.setSecret('archivist-present', '');
      expect(ss.getSecret('archivist-present')).toBe('');
      expect(ss.getSecret('archivist-absent')).toBeNull();
    });
  });

  describe('id constraint (obsidian.d.ts:5478)', () => {
    // Per the SecretStorage jsdoc: "Lowercase alphanumeric ID with optional
    // dashes" — the mock enforces this so a typo can't silently pass tests
    // and then fail in real Obsidian.

    it.each([
      'archivist',
      'archivist-dropbox-tokens',
      'a',
      'a-b',
      'archivist-123',
      '123-archivist',
    ])('accepts %s', (id) => {
      expect(() => ss.setSecret(id, 'x')).not.toThrow();
    });

    it.each([
      ['empty', ''],
      ['leading dash', '-archivist'],
      ['uppercase', 'Archivist'],
      ['underscore', 'archivist_tokens'],
      ['space', 'archivist tokens'],
      ['dot', 'archivist.tokens'],
      ['slash', 'archivist/tokens'],
    ])('rejects %s (%s)', (_label, id) => {
      expect(() => ss.setSecret(id, 'x')).toThrow(/Invalid secret id/);
    });
  });

  describe('_reset test helper', () => {
    it('clears all secrets', () => {
      ss.setSecret('archivist-a', 'x');
      ss.setSecret('archivist-b', 'y');
      ss._reset();
      expect(ss.listSecrets()).toEqual([]);
      expect(ss.getSecret('archivist-a')).toBeNull();
    });
  });

  describe('App wiring', () => {
    it('exposes a fresh SecretStorage on each App instance', () => {
      const a = new App();
      const b = new App();
      a.secretStorage.setSecret('archivist-x', 'from-a');
      expect(b.secretStorage.getSecret('archivist-x')).toBeNull();
    });
  });
});
