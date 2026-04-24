// MaintenanceScheduler — async retention runner, decoupled from backup hot path.
//
// ROB-002: scheduleRetentionIfDue() posts the job and returns immediately.
// The caller resumes READY state; retention runs in the background.
// Errors from runRetention are caught, logged, and NOT propagated.
// onunload() cancels any in-flight job via AbortController.

import type { LocalIndex } from '../model/Index';
import type { Logger } from '../infra/Logger';

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type MaintenanceEventType = 'MAINTENANCE_STARTED' | 'MAINTENANCE_DONE' | 'MAINTENANCE_FAILED';

export interface MaintenanceEvent {
  type: MaintenanceEventType;
}

export interface MaintenanceSchedulerDeps {
  /** Injectable retention implementation. Real RetentionService arrives in Phase 6. */
  runRetention: (signal: AbortSignal) => Promise<void>;
  loadIndex: () => Promise<LocalIndex>;
  saveIndex: (index: LocalIndex) => Promise<void>;
  logger: Logger;
  /** Injectable for tests — defaults to Date.now(). */
  now?: () => number;
}

export class MaintenanceScheduler {
  private readonly runRetention: (signal: AbortSignal) => Promise<void>;
  private readonly loadIndex: () => Promise<LocalIndex>;
  private readonly saveIndex: (index: LocalIndex) => Promise<void>;
  private readonly logger: Logger;
  private readonly now: () => number;

  private abortController: AbortController = new AbortController();
  private subscribers: Array<(event: MaintenanceEvent) => void> = [];

  constructor(deps: MaintenanceSchedulerDeps) {
    this.runRetention = deps.runRetention;
    this.loadIndex = deps.loadIndex;
    this.saveIndex = deps.saveIndex;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Subscribe to MAINTENANCE state events. Returns an unsubscribe function. */
  subscribe(cb: (event: MaintenanceEvent) => void): () => void {
    this.subscribers.push(cb);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== cb);
    };
  }

  /**
   * Posts a retention job if last_retention_at > 24h ago.
   * Returns immediately — never blocks the caller (ROB-002).
   */
  async scheduleRetentionIfDue(): Promise<void> {
    const index = await this.loadIndex();
    if (!this.isDue(index.last_retention_at)) return;

    // Post the job without awaiting — caller returns to READY state immediately.
    void this.runJob(index);
  }

  /** Cancel any in-flight maintenance job. */
  onunload(): void {
    this.abortController.abort();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isDue(lastRetentionAt: string | null): boolean {
    if (lastRetentionAt === null) return true;
    const lastMs = new Date(lastRetentionAt).getTime();
    return this.now() - lastMs > RETENTION_INTERVAL_MS;
  }

  private async runJob(index: LocalIndex): Promise<void> {
    this.emit({ type: 'MAINTENANCE_STARTED' });
    const signal = this.abortController.signal;

    try {
      await this.runRetention(signal);
      const updated: LocalIndex = {
        ...index,
        last_retention_at: new Date(this.now()).toISOString(),
      };
      await this.saveIndex(updated);
      this.emit({ type: 'MAINTENANCE_DONE' });
    } catch (err) {
      this.logger.error('maintenance_retention_failed', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
      this.emit({ type: 'MAINTENANCE_FAILED' });
    }
  }

  private emit(event: MaintenanceEvent): void {
    for (const cb of this.subscribers) {
      cb(event);
    }
  }
}
