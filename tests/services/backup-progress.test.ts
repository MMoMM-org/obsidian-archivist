// BackupProgress — observable phase + counter tracker the StatusBar tooltip
// reads from. Throttling matters: a 5k-file vault triggers ~1250 advance()
// calls during upload; the tracker must collapse them to ~4 notifications/sec
// so the status bar doesn't repaint per-batch.

import { describe, expect, it } from 'vitest';

import { createBackupProgressTracker } from '../../src/services/BackupProgress';

describe('BackupProgressTracker', () => {
  it('start_initialises_snapshot_with_kind_and_zeroed_phase', () => {
    const tracker = createBackupProgressTracker({ now: () => 1_000 });
    tracker.start({ kind: 'full' });
    const s = tracker.getSnapshot();
    expect(s).toEqual({
      kind: 'full',
      phase: 'reading',
      current: 0,
      total: 0,
      startedAtMs: 1_000,
    });
  });

  it('end_clears_snapshot_back_to_null', () => {
    const tracker = createBackupProgressTracker();
    tracker.start({ kind: 'inc' });
    tracker.setPhase('uploading', 10);
    tracker.advance(3);
    tracker.end();
    expect(tracker.getSnapshot()).toBeNull();
  });

  it('setPhase_force_flushes_subscribers_even_inside_throttle_window', () => {
    let nowMs = 1_000;
    const tracker = createBackupProgressTracker({
      now: () => nowMs,
      notifyThrottleMs: 500,
    });
    let calls = 0;
    tracker.subscribe(() => { calls += 1; });

    tracker.start({ kind: 'full' });            // force, calls = 1
    tracker.setPhase('uploading', 5);           // force, calls = 2 (no time elapsed)
    expect(calls).toBe(2);
  });

  it('advance_throttles_repeated_calls_within_the_window', () => {
    let nowMs = 1_000;
    const tracker = createBackupProgressTracker({
      now: () => nowMs,
      notifyThrottleMs: 500,
    });
    let calls = 0;
    tracker.subscribe(() => { calls += 1; });

    tracker.start({ kind: 'inc' });             // force fire, calls = 1
    tracker.setPhase('uploading', 100);         // force fire, calls = 2

    // 5 advances within 100ms — throttle should suppress all but the first.
    tracker.advance(1);                         // throttled (lastNotifyMs just set)
    tracker.advance(1);
    tracker.advance(1);
    tracker.advance(1);
    tracker.advance(1);
    expect(calls).toBe(2);

    // Jump past the throttle window — next advance fires.
    nowMs += 600;
    tracker.advance(1);
    expect(calls).toBe(3);

    // Snapshot reflects all advances regardless of notification throttling.
    expect(tracker.getSnapshot()?.current).toBe(6);
  });

  it('subscribe_returns_unsubscribe_that_stops_future_notifications', () => {
    const tracker = createBackupProgressTracker();
    let calls = 0;
    const unsub = tracker.subscribe(() => { calls += 1; });

    tracker.start({ kind: 'full' });
    expect(calls).toBe(1);

    unsub();
    tracker.setPhase('uploading', 3);
    tracker.end();
    expect(calls).toBe(1);
  });

  it('advance_before_start_or_after_end_is_a_noop', () => {
    const tracker = createBackupProgressTracker();
    tracker.advance(5);                          // before start
    expect(tracker.getSnapshot()).toBeNull();

    tracker.start({ kind: 'full' });
    tracker.end();
    tracker.advance(5);                          // after end
    expect(tracker.getSnapshot()).toBeNull();
  });

  it('advance_with_zero_or_negative_delta_is_a_noop', () => {
    const tracker = createBackupProgressTracker();
    tracker.start({ kind: 'inc' });
    tracker.setPhase('uploading', 10);
    tracker.advance(0);
    tracker.advance(-3);
    expect(tracker.getSnapshot()?.current).toBe(0);
  });
});
