import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// __dirname is not available in ESM; derive from import.meta.url.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), 'utf8'));
}

describe('manifest.json', () => {
  const manifest = readJson('manifest.json') as Record<string, unknown>;

  it('is valid JSON', () => {
    expect(manifest).toBeTypeOf('object');
  });

  it('has all required community-plugin fields', () => {
    const required = ['id', 'name', 'version', 'minAppVersion', 'description', 'author', 'isDesktopOnly'];
    for (const key of required) {
      expect(manifest, `missing field "${key}"`).toHaveProperty(key);
    }
  });

  it("id equals 'archivist'", () => {
    expect(manifest.id).toBe('archivist');
  });

  it('version matches package.json (semantic-release single source of truth)', () => {
    // Hard-coded version assertions break on every release because
    // semantic-release bumps both files in lockstep — pin the cross-file
    // consistency check instead so the test stays green across bumps but
    // still catches the case where one file is updated without the other.
    const pkg = readJson('package.json') as Record<string, unknown>;
    expect(typeof pkg.version).toBe('string');
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("minAppVersion equals '1.5.0'", () => {
    expect(manifest.minAppVersion).toBe('1.5.0');
  });

  it('isDesktopOnly is true (mobile deferred post-V1 per ADR-12)', () => {
    expect(manifest.isDesktopOnly).toBe(true);
  });

  it('has authorUrl pointing at the author homepage', () => {
    expect(typeof manifest.authorUrl).toBe('string');
    // Obsidian community-plugin reviewers reject authorUrl values that
    // point at the plugin's GitHub repository — the field must point
    // somewhere about the author themselves (homepage, profile, etc).
    expect(manifest.authorUrl as string).not.toContain('github.com/MMoMM-org/obsidian-archivist');
    expect(manifest.authorUrl as string).toMatch(/^https?:\/\//);
  });

  it('description mentions backup and Dropbox without "Obsidian"', () => {
    // Obsidian reviewers reject descriptions that include "Obsidian" —
    // the community-plugins context already implies it.
    const d = String(manifest.description ?? '');
    expect(d.toLowerCase()).toContain('backup');
    expect(d.toLowerCase()).toContain('dropbox');
    expect(d.toLowerCase()).not.toContain('obsidian');
  });
});

describe('versions.json', () => {
  const versions = readJson('versions.json') as Record<string, string>;

  it('is valid JSON', () => {
    expect(versions).toBeTypeOf('object');
  });

  it("maps 0.1.0 → 1.5.0", () => {
    expect(versions['0.1.0']).toBe('1.5.0');
  });
});
