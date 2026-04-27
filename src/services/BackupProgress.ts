// BackupProgress — observable progress reporter for the BackupService.
//
// BackupService writes (start / setPhase / advance / end). UI surfaces
// (StatusBar tooltip, ribbon tooltip) read via getSnapshot() and refresh on
// subscribe(cb) firing. Decoupled so tests + future surfaces (notice, modal)
// can plug in without BackupService growing more dependencies.
//
// Throttling: advance() during the upload phase fires once per uploaded batch
// (every 4 files at default parallelism). For a 5k-file vault that's ~1250
// updates. We collapse them to one subscriber notification per
// `notifyThrottleMs` (default 250 ms) so the status bar repaints at most ~4
// times/second regardless of upload throughput. Phase changes and end()
// always force-flush so the tooltip never lags a phase boundary.

export type BackupKind = 'full' | 'inc';
export type BackupPhase = 'reading' | 'uploading' | 'committing';

export interface BackupProgressSnapshot {
  kind: BackupKind;
  phase: BackupPhase;
  current: number;
  total: number;
  startedAtMs: number;
}

export interface BackupProgressReporter {
  start(input: { kind: BackupKind }): void;
  setPhase(phase: BackupPhase, total: number): void;
  advance(delta: number): void;
  end(): void;
}

export interface BackupProgressTracker extends BackupProgressReporter {
  getSnapshot(): BackupProgressSnapshot | null;
  /** Returns an unsubscribe function. */
  subscribe(cb: () => void): () => void;
}

export interface BackupProgressOptions {
  notifyThrottleMs?: number;
  now?: () => number;
}

export function createBackupProgressTracker(
  opts: BackupProgressOptions = {},
): BackupProgressTracker {
  const throttleMs = opts.notifyThrottleMs ?? 250;
  const now = opts.now ?? Date.now;

  let snapshot: BackupProgressSnapshot | null = null;
  let lastNotifyMs = 0;
  const subscribers = new Set<() => void>();

  const notify = (force: boolean): void => {
    const t = now();
    if (!force && t - lastNotifyMs < throttleMs) return;
    lastNotifyMs = t;
    // Snapshot the subscriber set so unsubscribe-during-notify doesn't trip
    // the iteration. Plain Set.forEach skips items removed mid-iteration but
    // that behaviour is implementation-defined in older runtimes.
    for (const cb of Array.from(subscribers)) cb();
  };

  return {
    start(input) {
      snapshot = {
        kind: input.kind,
        phase: 'reading',
        current: 0,
        total: 0,
        startedAtMs: now(),
      };
      notify(true);
    },
    setPhase(phase, total) {
      if (!snapshot) return;
      snapshot = { ...snapshot, phase, current: 0, total };
      notify(true);
    },
    advance(delta) {
      if (!snapshot || delta <= 0) return;
      snapshot = { ...snapshot, current: snapshot.current + delta };
      notify(false);
    },
    end() {
      snapshot = null;
      lastNotifyMs = 0;
      notify(true);
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
  };
}
