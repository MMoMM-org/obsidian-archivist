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

  it("id equals 'obsidian-archivist'", () => {
    expect(manifest.id).toBe('obsidian-archivist');
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

  it('has authorUrl pointing at MMoMM-org', () => {
    expect(typeof manifest.authorUrl).toBe('string');
    expect(manifest.authorUrl as string).toContain('MMoMM-org');
  });

  it('description mentions backup and Dropbox', () => {
    const d = String(manifest.description ?? '').toLowerCase();
    expect(d).toContain('backup');
    expect(d).toContain('dropbox');
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
