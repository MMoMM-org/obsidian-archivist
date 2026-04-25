// T6.5 — StorageProbe: storage-usage estimation with 15-minute cache and banner thresholds.
//
// Test coverage:
//   1. Sum-across-recursive-listing: 3 files → total_bytes === 600
//   2. Cache honored within TTL: second call does NOT invoke listFolder (spy counts 1)
//   3. Cache invalidated after TTL: now() advances past 15 min → listFolder called again
//   4. Force bypass: estimateUsage({ force: true }) re-fetches even within TTL
//   5. Banner at warn threshold (80%): limit=100 MB, total=80 MB → banner==='warn'
//   6. Banner at 100%: total=100 MB, limit=100 MB → banner==='exceeded'
//   7. Banner below warn threshold: total=50 MB, limit=100 MB → banner==='ok'
//   8. Missing-size entry skipped: logger.warn with code storage_probe_missing_size
//   9. listFolder failure propagates: NetworkError thrown → estimateUsage propagates
//  10. measured_at reflects measurement time, not cache-hit time

import { describe, expect, it, vi } from 'vitest';
import { StorageProbe } from '../../src/services/StorageProbe';
import type { StorageUsageReport } from '../../src/services/StorageProbe';
import type { ListFolderEntry } from '../../src/infra/DropboxClient';
import type { Logger } from '../../src/infra/Logger';
import { NetworkError } from '../../src/model/Errors';
import { DEFAULT_SETTINGS } from '../../src/model/Settings';
import type { PluginSettings } from '../../src/model/Settings';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

function makeEntries(sizes: Array<number | undefined>): ListFolderEntry[] {
  return sizes.map((size, i) => {
    const entry: ListFolderEntry = {
      tag: 'file',
      path: `my-vault/file${i}.md`,
    };
    if (size !== undefined) entry.size = size;
    return entry;
  });
}

function makeSettings(overrides?: {
  storage_hard_limit_gb?: number;
  storage_warn_at_percent?: number;
}): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    retention: {
      ...DEFAULT_SETTINGS.retention,
      storage_hard_limit_gb: overrides?.storage_hard_limit_gb ?? 200,
      storage_warn_at_percent: overrides?.storage_warn_at_percent ?? 80,
    },
  };
}

function makeDropbox(entries: ListFolderEntry[]) {
  return {
    listFolder: vi.fn().mockResolvedValue(entries),
  };
}

function makePluginStore(settings: PluginSettings = makeSettings()) {
  return {
    loadSettings: vi.fn().mockResolvedValue(settings),
  };
}

function makeLogger(): Logger & { warnCalls: Array<[string, unknown]> } {
  const warnCalls: Array<[string, unknown]> = [];
  return {
    warnCalls,
    info: vi.fn(),
    warn: vi.fn((msg: string, payload?: unknown) => {
      warnCalls.push([msg, payload]);
    }),
    error: vi.fn(),
  };
}

const VAULT_PREFIX = 'my-vault';
const DEFAULT_NOW = new Date('2026-04-24T12:00:00.000Z');

function makeProbe(opts: {
  entries?: ListFolderEntry[];
  settings?: PluginSettings;
  now?: () => Date;
  cacheTtlMs?: number;
  logger?: Logger;
  dropbox?: ReturnType<typeof makeDropbox>;
}) {
  const dropbox = opts.dropbox ?? makeDropbox(opts.entries ?? makeEntries([100, 200, 300]));
  const pluginStore = makePluginStore(opts.settings ?? makeSettings());
  const logger = opts.logger ?? makeLogger();

  const probe = new StorageProbe({
    dropbox: dropbox as never,
    pluginStore,
    vaultPrefix: VAULT_PREFIX,
    logger,
    now: opts.now ?? (() => DEFAULT_NOW),
    cacheTtlMs: opts.cacheTtlMs,
  });

  return { probe, dropbox, pluginStore, logger };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StorageProbe.estimateUsage', () => {
  it('sums bytes across all file entries in a recursive listing', async () => {
    const { probe } = makeProbe({ entries: makeEntries([100, 200, 300]) });
    const report = await probe.estimateUsage();
    expect(report.total_bytes).toBe(600);
  });

  it('returns a well-formed StorageUsageReport', async () => {
    const { probe } = makeProbe({ entries: makeEntries([100]) });
    const report = await probe.estimateUsage();
    expect(report).toMatchObject<Partial<StorageUsageReport>>({
      total_bytes: expect.any(Number),
      limit_bytes: expect.any(Number),
      percent_used: expect.any(Number),
      banner: expect.stringMatching(/^ok|warn|exceeded$/),
      measured_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('calls listFolder with { recursive: true } and the archivist root path', async () => {
    const { probe, dropbox } = makeProbe({ entries: [] });
    await probe.estimateUsage();
    expect(dropbox.listFolder).toHaveBeenCalledWith(
      'my-vault',
      { recursive: true },
    );
  });

  it('honors cache within TTL — listFolder called only once on second call', async () => {
    const { probe, dropbox } = makeProbe({ entries: makeEntries([100, 200, 300]) });
    await probe.estimateUsage();
    await probe.estimateUsage();
    expect(dropbox.listFolder).toHaveBeenCalledTimes(1);
  });

  it('invalidates cache after TTL expires', async () => {
    let nowMs = DEFAULT_NOW.getTime();
    const { probe, dropbox } = makeProbe({
      entries: makeEntries([100]),
      cacheTtlMs: 5 * 60 * 1000, // 5 minutes for test speed
      now: () => new Date(nowMs),
    });

    await probe.estimateUsage();
    // Advance time past TTL
    nowMs += 6 * 60 * 1000;
    await probe.estimateUsage();
    expect(dropbox.listFolder).toHaveBeenCalledTimes(2);
  });

  it('bypasses cache when force: true even within TTL', async () => {
    const { probe, dropbox } = makeProbe({ entries: makeEntries([100]) });
    await probe.estimateUsage();
    await probe.estimateUsage({ force: true });
    expect(dropbox.listFolder).toHaveBeenCalledTimes(2);
  });

  it('returns banner=warn when usage is at exactly the warn threshold', async () => {
    const entries = makeEntries([80 * MB]);
    const settings = makeSettings({ storage_hard_limit_gb: 100 / 1024, storage_warn_at_percent: 80 });
    const { probe } = makeProbe({ entries, settings });
    const report = await probe.estimateUsage();
    expect(report.banner).toBe('warn');
    expect(report.percent_used).toBeCloseTo(80, 1);
  });

  it('returns banner=exceeded when usage is at 100%', async () => {
    const entries = makeEntries([100 * MB]);
    const settings = makeSettings({ storage_hard_limit_gb: 100 / 1024, storage_warn_at_percent: 80 });
    const { probe } = makeProbe({ entries, settings });
    const report = await probe.estimateUsage();
    expect(report.banner).toBe('exceeded');
    expect(report.percent_used).toBeCloseTo(100, 1);
  });

  it('returns banner=ok when usage is below warn threshold', async () => {
    const entries = makeEntries([50 * MB]);
    const settings = makeSettings({ storage_hard_limit_gb: 100 / 1024, storage_warn_at_percent: 80 });
    const { probe } = makeProbe({ entries, settings });
    const report = await probe.estimateUsage();
    expect(report.banner).toBe('ok');
    expect(report.percent_used).toBeCloseTo(50, 1);
  });

  it('skips entries without a numeric size and logs a warning', async () => {
    const logger = makeLogger();
    // One entry has no size, two have sizes
    const entries = makeEntries([undefined, 100, 200]);
    const { probe } = makeProbe({ entries, logger });
    const report = await probe.estimateUsage();
    expect(report.total_bytes).toBe(300);
    const warnCall = logger.warnCalls.find(([msg]) => msg === 'storage_probe_missing_size');
    expect(warnCall).toBeDefined();
  });

  it('propagates listFolder errors to the caller', async () => {
    const dropbox = {
      listFolder: vi.fn().mockRejectedValue(new NetworkError('NETWORK_ERROR', 'DNS failure', true)),
    };
    const { probe } = makeProbe({ dropbox });
    await expect(probe.estimateUsage()).rejects.toBeInstanceOf(NetworkError);
  });

  it('measured_at reflects the measurement time, not the cache-hit time', async () => {
    const t1 = new Date('2026-04-24T12:00:00.000Z');
    const t2 = new Date('2026-04-24T12:05:00.000Z');
    let callCount = 0;
    const nowFn = () => (callCount++ === 0 ? t1 : t2);

    const { probe } = makeProbe({
      entries: makeEntries([100]),
      cacheTtlMs: 60 * 60 * 1000, // 1 hour — won't expire
      now: nowFn,
    });

    const first = await probe.estimateUsage();
    const cached = await probe.estimateUsage(); // cache hit
    // Both should report t1's ISO string (the measurement time)
    expect(first.measured_at).toBe(t1.toISOString());
    expect(cached.measured_at).toBe(t1.toISOString());
  });

  it('computes limit_bytes from storage_hard_limit_gb', async () => {
    const settings = makeSettings({ storage_hard_limit_gb: 2 });
    const { probe } = makeProbe({ entries: makeEntries([0]), settings });
    const report = await probe.estimateUsage();
    expect(report.limit_bytes).toBe(2 * GB);
  });

  it('returns banner=ok and percent_used=0 when storage_hard_limit_gb is 0 (unconfigured)', async () => {
    const settings = makeSettings({ storage_hard_limit_gb: 0, storage_warn_at_percent: 80 });
    const entries = makeEntries([500 * MB]); // non-zero usage, but limit is unconfigured
    const { probe } = makeProbe({ entries, settings });
    const report = await probe.estimateUsage();
    expect(report.banner).toBe('ok');
    expect(report.percent_used).toBe(0);
    expect(report.limit_bytes).toBe(0);
  });

  it('skips folder and deleted entries (only sums file entries)', async () => {
    const entries: ListFolderEntry[] = [
      { tag: 'file', path: 'my-vault/file.md', size: 500 },
      { tag: 'folder', path: 'my-vault/subdir' },
      { tag: 'deleted', path: 'my-vault/old.md' },
    ];
    const { probe } = makeProbe({ entries });
    const report = await probe.estimateUsage();
    expect(report.total_bytes).toBe(500);
  });
});
