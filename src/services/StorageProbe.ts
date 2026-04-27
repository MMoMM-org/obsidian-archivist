// StorageProbe — estimates Archivist's storage footprint on Dropbox.
//
// Design (T6.5 / Phase 6):
//   - Calls listFolder with { recursive: true } on the archivist root.
//   - Sums .size of all file-tagged entries; skips folders, deleted, and
//     entries with no numeric size (logs a warning per missing entry).
//   - Result is cached in-memory for cacheTtlMs (default 15 minutes).
//   - Banner thresholds from RetentionSettings:
//       ≥ storage_warn_at_percent → 'warn'
//       ≥ 100% of limit → 'exceeded'
//       otherwise → 'ok'
//   - Consumers: SettingsTab (Phase 10) and RibbonIcon (Phase 7).
//
// References: PRD/F2 AC-5; SDD/Acceptance Criteria — storage_warn; plan phase-6.md T6.5.

import type { DropboxClient } from '../infra/DropboxClient';
import type { Logger } from '../infra/Logger';
import type { PluginSettings } from '../model/Settings';
import { vaultRoot } from '../util/paths';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface StorageUsageReport {
  total_bytes: number;
  limit_bytes: number;
  percent_used: number;     // 0..100+
  banner: 'ok' | 'warn' | 'exceeded';
  measured_at: string;      // ISO-8601 from the measurement, not the cache hit
}

export interface PluginStoreLike {
  loadSettings(): Promise<PluginSettings>;
}

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const BYTES_PER_GB = 1024 * 1024 * 1024;

interface CachedReport {
  report: StorageUsageReport;
  measured_at_ms: number;
}

// ---------------------------------------------------------------------------
// StorageProbe
// ---------------------------------------------------------------------------

export class StorageProbe {
  private readonly dropbox: DropboxClient;
  private readonly pluginStore: PluginStoreLike;
  private readonly vaultPrefix: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private cache: CachedReport | null = null;

  constructor(deps: {
    dropbox: DropboxClient;
    pluginStore: PluginStoreLike;
    vaultPrefix: string;
    logger: Logger;
    now?: () => Date;
    cacheTtlMs?: number;
  }) {
    this.dropbox = deps.dropbox;
    this.pluginStore = deps.pluginStore;
    this.vaultPrefix = deps.vaultPrefix;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
    this.cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  async estimateUsage(opts?: { force?: boolean }): Promise<StorageUsageReport> {
    if (!opts?.force && this.isCacheValid()) {
      return this.cache!.report;
    }

    const report = await this.measure();
    this.cache = { report, measured_at_ms: this.now().getTime() };
    return report;
  }

  // ---- Private ---------------------------------------------------------------

  private isCacheValid(): boolean {
    if (!this.cache) return false;
    const ageMs = this.now().getTime() - this.cache.measured_at_ms;
    return ageMs < this.cacheTtlMs;
  }

  private async measure(): Promise<StorageUsageReport> {
    const settings = await this.pluginStore.loadSettings();
    const { storage_hard_limit_gb, storage_warn_at_percent } = settings.retention;
    const limit_bytes = storage_hard_limit_gb * BYTES_PER_GB;

    const root = vaultRoot(this.vaultPrefix);
    const entries = await this.dropbox.listFolder(root, { recursive: true });

    const total_bytes = this.sumEntries(entries);
    // limit_bytes === 0 means "unconfigured / unlimited": treat as 0% used so
    // the banner stays 'ok' and we never emit a spurious warn/exceeded.
    const percent_used = limit_bytes > 0 ? (total_bytes / limit_bytes) * 100 : 0;
    const banner = computeBanner(percent_used, storage_warn_at_percent);
    const measured_at = this.now().toISOString();

    return { total_bytes, limit_bytes, percent_used, banner, measured_at };
  }

  private sumEntries(entries: Awaited<ReturnType<DropboxClient['listFolder']>>): number {
    let total = 0;
    for (const entry of entries) {
      if (entry.tag !== 'file') continue;
      if (typeof entry.size === 'number') {
        total += entry.size;
      } else {
        this.logger.warn('storage_probe_missing_size', { path: entry.path });
      }
    }
    return total;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function computeBanner(
  percentUsed: number,
  warnAtPercent: number,
): StorageUsageReport['banner'] {
  if (percentUsed >= 100) return 'exceeded';
  if (percentUsed >= warnAtPercent) return 'warn';
  return 'ok';
}
