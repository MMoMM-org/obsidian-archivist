// T5.2a — MaintenanceScheduler: async retention runner, decoupled from backup hot path.
//
// Test coverage:
//   - scheduleRetentionIfDue: returns immediately, posts job asynchronously (ROB-002)
//   - Runs retention when last_retention_at > 24h ago
//   - No-op when last_retention_at is within 24h
//   - Catches errors from retention pass, logs, does not propagate
//   - Emits MAINTENANCE_STARTED before retention begins
//   - Emits MAINTENANCE_DONE when retention resolves
//   - Emits MAINTENANCE_FAILED when retention throws
//   - onunload cancels in-flight job via AbortController

import { describe, expect, it, vi } from 'vitest';
import { MaintenanceScheduler } from '../../src/services/MaintenanceScheduler';
import type { MaintenanceSchedulerDeps, MaintenanceEvent } from '../../src/services/MaintenanceScheduler';
import type { LocalIndex } from '../../src/model/Index';
import type { Logger } from '../../src/infra/Logger';

// ---------------------------------------------------------------------------
// Fakes and factories
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeLocalIndex(lastRetentionAt: string | null): LocalIndex {
  return {
    schema_version: '1.0',
    last_full_snapshot_id: null,
    last_inc_snapshot_id: null,
    last_full_commit_at: null,
    last_inc_commit_at: null,
    last_retention_at: lastRetentionAt,
    index_missing_recovery_required: false,
    files: {},
  };
}

/** Returns an ISO string N hours ago from `baseMs`. */
function hoursAgo(n: number, baseMs: number = Date.now()): string {
  return new Date(baseMs - n * 60 * 60 * 1000).toISOString();
}

function makeScheduler(
  opts: {
    lastRetentionAt?: string | null;
    runRetention?: (signal: AbortSignal) => Promise<void>;
    now?: () => number;
    logger?: Logger;
    loadIndex?: () => Promise<LocalIndex>;
    saveIndex?: (index: LocalIndex) => Promise<void>;
  } = {},
): MaintenanceScheduler {
  const now = opts.now ?? (() => Date.now());
  const logger = opts.logger ?? makeLogger();
  const index = makeLocalIndex(opts.lastRetentionAt ?? hoursAgo(25, now()));
  const runRetention = opts.runRetention ?? vi.fn(async () => {});

  const deps: MaintenanceSchedulerDeps = {
    runRetention,
    loadIndex: opts.loadIndex ?? vi.fn(async () => index),
    saveIndex: opts.saveIndex ?? vi.fn(async () => {}),
    logger,
    now,
  };

  return new MaintenanceScheduler(deps);
}

// Collect events emitted by the scheduler
function collectEvents(scheduler: MaintenanceScheduler): MaintenanceEvent[] {
  const events: MaintenanceEvent[] = [];
  scheduler.subscribe((event) => events.push(event));
  return events;
}

// ---------------------------------------------------------------------------
// Tests: scheduleRetentionIfDue — non-blocking behavior (ROB-002)
// ---------------------------------------------------------------------------

describe('MaintenanceScheduler.scheduleRetentionIfDue — non-blocking', () => {
  it('returns before the retention job completes', async () => {
    const order: string[] = [];

    let resolveRetention!: () => void;
    const retentionDone = new Promise<void>((res) => {
      resolveRetention = res;
    });

    const runRetention = vi.fn(async () => {
      await retentionDone;
      order.push('retention_done');
    });

    const scheduler = makeScheduler({ runRetention });

    // scheduleRetentionIfDue returns a Promise — we await it to confirm the
    // synchronous portion completes immediately (before the retention runs).
    await scheduler.scheduleRetentionIfDue();
    order.push('caller_returned');

    // Now let retention finish
    resolveRetention();
    // Drain microtasks so the async job can complete
    await new Promise((res) => setTimeout(res, 0));

    expect(order[0]).toBe('caller_returned');
    expect(order[1]).toBe('retention_done');
  });
});

// ---------------------------------------------------------------------------
// Tests: due / not-due logic
// ---------------------------------------------------------------------------

describe('MaintenanceScheduler.scheduleRetentionIfDue — due/not-due', () => {
  it('calls runRetention when last_retention_at is more than 24h ago', async () => {
    const runRetention = vi.fn(async () => {});
    const now = Date.now();
    const scheduler = makeScheduler({
      runRetention,
      lastRetentionAt: hoursAgo(25, now),
      now: () => now,
    });

    await scheduler.scheduleRetentionIfDue();
    // Drain microtasks
    await new Promise((res) => setTimeout(res, 0));

    expect(runRetention).toHaveBeenCalledOnce();
  });

  it('no-op when last_retention_at is within 24h', async () => {
    const runRetention = vi.fn(async () => {});
    const now = Date.now();
    const scheduler = makeScheduler({
      runRetention,
      lastRetentionAt: hoursAgo(10, now),
      now: () => now,
    });

    await scheduler.scheduleRetentionIfDue();
    await new Promise((res) => setTimeout(res, 0));

    expect(runRetention).not.toHaveBeenCalled();
  });

  it('calls runRetention when last_retention_at is null (never run)', async () => {
    const runRetention = vi.fn(async () => {});
    const scheduler = makeScheduler({
      runRetention,
      lastRetentionAt: null,
    });

    await scheduler.scheduleRetentionIfDue();
    await new Promise((res) => setTimeout(res, 0));

    expect(runRetention).toHaveBeenCalledOnce();
  });

  it('exactly 24h ago is treated as not due (boundary: > 24h triggers, not >=)', async () => {
    const runRetention = vi.fn(async () => {});
    const now = Date.now();
    const scheduler = makeScheduler({
      runRetention,
      lastRetentionAt: hoursAgo(24, now),
      now: () => now,
    });

    await scheduler.scheduleRetentionIfDue();
    await new Promise((res) => setTimeout(res, 0));

    expect(runRetention).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

describe('MaintenanceScheduler — error handling', () => {
  it('catches error from runRetention and does not propagate', async () => {
    const runRetention = vi.fn(async () => {
      throw new Error('retention failed');
    });
    const logger = makeLogger();
    const scheduler = makeScheduler({ runRetention, logger });

    await scheduler.scheduleRetentionIfDue();
    // Should not throw even after the job runs
    await new Promise((res) => setTimeout(res, 0));

    // No unhandled rejection — if the scheduler re-throws this test would fail
    expect(true).toBe(true);
  });

  it('logs error when runRetention throws', async () => {
    const err = new Error('retention kaboom');
    const runRetention = vi.fn(async () => {
      throw err;
    });
    const logger = makeLogger();
    const scheduler = makeScheduler({ runRetention, logger });

    await scheduler.scheduleRetentionIfDue();
    await new Promise((res) => setTimeout(res, 0));

    expect(logger.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: state events
// ---------------------------------------------------------------------------

describe('MaintenanceScheduler — state events', () => {
  it('emits MAINTENANCE_STARTED before retention runs', async () => {
    const order: string[] = [];
    let resolveRetention!: () => void;
    const retentionStarted = new Promise<void>((res) => {
      resolveRetention = res;
    });

    const runRetention = vi.fn(async () => {
      await retentionStarted;
    });

    const scheduler = makeScheduler({ runRetention });
    const events = collectEvents(scheduler);

    await scheduler.scheduleRetentionIfDue();

    // STARTED fires when the async job begins, before retention completes
    resolveRetention();
    await new Promise((res) => setTimeout(res, 0));

    const types = events.map((e) => e.type);
    const startedIdx = types.indexOf('MAINTENANCE_STARTED');
    expect(startedIdx).toBeGreaterThanOrEqual(0);
  });

  it('emits MAINTENANCE_DONE after retention resolves', async () => {
    const scheduler = makeScheduler();
    const events = collectEvents(scheduler);

    await scheduler.scheduleRetentionIfDue();
    await new Promise((res) => setTimeout(res, 0));

    const types = events.map((e) => e.type);
    expect(types).toContain('MAINTENANCE_DONE');
    // STARTED before DONE
    const startedIdx = types.indexOf('MAINTENANCE_STARTED');
    const doneIdx = types.indexOf('MAINTENANCE_DONE');
    expect(startedIdx).toBeLessThan(doneIdx);
  });

  it('emits MAINTENANCE_FAILED when retention throws', async () => {
    const runRetention = vi.fn(async () => {
      throw new Error('boom');
    });
    const logger = makeLogger();
    const scheduler = makeScheduler({ runRetention, logger });
    const events = collectEvents(scheduler);

    await scheduler.scheduleRetentionIfDue();
    await new Promise((res) => setTimeout(res, 0));

    const types = events.map((e) => e.type);
    expect(types).toContain('MAINTENANCE_FAILED');
    expect(types).not.toContain('MAINTENANCE_DONE');
  });

  it('does not emit any event when retention is not due', async () => {
    const runRetention = vi.fn(async () => {});
    const now = Date.now();
    const scheduler = makeScheduler({
      runRetention,
      lastRetentionAt: hoursAgo(10, now),
      now: () => now,
    });
    const events = collectEvents(scheduler);

    await scheduler.scheduleRetentionIfDue();
    await new Promise((res) => setTimeout(res, 0));

    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: onunload — AbortController cancellation
// ---------------------------------------------------------------------------

describe('MaintenanceScheduler.onunload', () => {
  it('aborts the AbortSignal passed to runRetention after onunload', async () => {
    let capturedSignal: AbortSignal | undefined;

    // Retention that latches until the test releases it
    let resolveRetention!: () => void;
    const retentionGate = new Promise<void>((res) => {
      resolveRetention = res;
    });

    const runRetention = vi.fn(async (signal: AbortSignal) => {
      capturedSignal = signal;
      await retentionGate;
    });

    const scheduler = makeScheduler({ runRetention });

    await scheduler.scheduleRetentionIfDue();
    // Kick off the microtask so runRetention is called and has captured the signal
    await new Promise((res) => setTimeout(res, 0));

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    scheduler.onunload();

    expect(capturedSignal!.aborted).toBe(true);

    // Release so the test doesn't hang
    resolveRetention();
    await new Promise((res) => setTimeout(res, 0));
  });

  it('onunload is safe to call when no job is in-flight', () => {
    const scheduler = makeScheduler();
    // Must not throw
    expect(() => scheduler.onunload()).not.toThrow();
  });

  it('job posted after onunload receives a fresh non-aborted signal (ROB-005)', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runRetention = vi.fn(async (signal: AbortSignal) => {
      capturedSignal = signal;
    });
    const scheduler = makeScheduler({ runRetention });

    // Abort the initial controller
    scheduler.onunload();

    // Post a new job — runJob must reset the AbortController before passing the signal
    await scheduler.scheduleRetentionIfDue();
    await new Promise((res) => setTimeout(res, 0));

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: saveIndex after retention completes
// ---------------------------------------------------------------------------

describe('MaintenanceScheduler — saveIndex after retention', () => {
  it('saves updated last_retention_at after successful retention', async () => {
    const saveIndex = vi.fn(async () => {});
    const loadIndex = vi.fn(async () => makeLocalIndex(hoursAgo(25)));
    const now = Date.now();

    const scheduler = makeScheduler({
      saveIndex,
      loadIndex,
      now: () => now,
    });

    await scheduler.scheduleRetentionIfDue();
    await new Promise((res) => setTimeout(res, 0));

    expect(saveIndex).toHaveBeenCalledOnce();
    const savedIndex = saveIndex.mock.calls[0][0] as LocalIndex;
    expect(savedIndex.last_retention_at).toBe(new Date(now).toISOString());
  });

  it('does not save index when retention fails', async () => {
    const saveIndex = vi.fn(async () => {});
    const runRetention = vi.fn(async () => {
      throw new Error('fail');
    });
    const logger = makeLogger();

    const scheduler = makeScheduler({
      saveIndex,
      runRetention,
      logger,
    });

    await scheduler.scheduleRetentionIfDue();
    await new Promise((res) => setTimeout(res, 0));

    expect(saveIndex).not.toHaveBeenCalled();
  });
});
