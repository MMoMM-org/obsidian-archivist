// Release metadata guard (spec 002, T3.3 — PRD F5). Pins the Obsidian version
// floor in manifest.json and protects the historical versions.json entries that
// let users on older Obsidian keep a compatible plugin release.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')) as Record<string, unknown>;
}

// Frozen snapshot of every versions.json entry released before spec 002.
// This is a PREFIX check, not strict equality: version-bump.mjs appends one
// entry per release, so new entries after the snapshot are expected. What must never happen is a hand edit,
// removal or reordering of an already-released entry — Obsidian relies on
// these to serve older Obsidian builds a compatible plugin version.
const RELEASED_BEFORE_SPEC_002: ReadonlyArray<readonly [string, string]> = [
  ['0.1.0', '1.5.0'],
  ['0.1.1', '1.5.0'],
  ['0.2.0', '1.5.0'],
  ['0.2.1', '1.5.0'],
  ['0.2.2', '1.5.0'],
  ['0.2.3', '1.5.0'],
  ['0.3.0', '1.5.0'],
  ['0.4.0', '1.5.0'],
  ['0.4.1', '1.5.0'],
  ['0.5.0', '1.5.0'],
  ['0.6.0', '1.5.0'],
  ['0.6.1', '1.5.0'],
  ['0.6.2', '1.5.0'],
  ['0.6.3', '1.5.0'],
  ['0.6.4', '1.5.0'],
  ['0.6.5', '1.5.0'],
  ['0.7.0', '1.5.0'],
  ['0.7.1', '1.5.0'],
  ['0.7.2', '1.5.0'],
  ['0.7.3', '1.5.0'],
  ['0.7.4', '1.5.0'],
  ['0.7.5', '1.5.0'],
  ['0.7.6', '1.5.0'],
  ['0.7.7', '1.5.0'],
  ['0.7.8', '1.5.0'],
  ['0.7.9', '1.5.0'],
  ['0.8.0', '1.11.4'],
  ['0.8.1', '1.11.4'],
  ['0.8.2', '1.11.4'],
  ['0.8.3', '1.11.4'],
  ['0.9.0', '1.11.4'],
  ['0.9.1', '1.11.4'],
  ['0.10.0', '1.11.4'],
  ['0.11.0', '1.11.4'],
  ['0.11.1', '1.11.4'],
  ['0.11.2', '1.11.4'],
  ['0.11.3', '1.11.4'],
  ['0.11.4', '1.11.4'],
  ['0.11.5', '1.11.4'],
  ['0.11.6', '1.11.4'],
  ['0.11.7', '1.11.4'],
];

const SEMVER = /^\d+\.\d+\.\d+$/;

describe('release metadata', () => {
  it('declares Obsidian 1.14.4 as the minimum app version', () => {
    expect(readJson('manifest.json').minAppVersion).toBe('1.14.4');
  });

  it('keeps every released versions.json entry unchanged', () => {
    const versions = readJson('versions.json');
    for (const [pluginVersion, appVersion] of RELEASED_BEFORE_SPEC_002) {
      expect(versions[pluginVersion], pluginVersion).toBe(appVersion);
    }
  });

  it('keeps the released entries in their original relative order', () => {
    const snapshotKeys = new Set(RELEASED_BEFORE_SPEC_002.map(([key]) => key));
    const presentInOrder = Object.keys(readJson('versions.json')).filter((key) => snapshotKeys.has(key));
    expect(presentInOrder).toEqual(RELEASED_BEFORE_SPEC_002.map(([key]) => key));
  });

  it('maps only semver plugin versions to semver app versions', () => {
    for (const [pluginVersion, appVersion] of Object.entries(readJson('versions.json'))) {
      expect(pluginVersion).toMatch(SEMVER);
      expect(appVersion).toMatch(SEMVER);
    }
  });
});
