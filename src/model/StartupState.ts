// Unified startup-state enum (ROB-008).
// Populated by ArchivistPlugin.startup() (Phase 5 T5.5) and consumed by
// the scheduler FSM (Phase 7). The enum lives here so Phase-2 primitives
// can reference it without a circular dep on the plugin entry point.

export enum StartupState {
  HEALTHY = 'HEALTHY',
  FRESH_FOLDER = 'FRESH_FOLDER',
  INDEX_MISSING = 'INDEX_MISSING',
  HEAD_STALE = 'HEAD_STALE',
  HEAD_POINTS_TO_MISSING = 'HEAD_POINTS_TO_MISSING',
  SNAPSHOT_INDEX_STALE = 'SNAPSHOT_INDEX_STALE',
  DEVICE_CONFLICT = 'DEVICE_CONFLICT',
  AUTH_MISSING = 'AUTH_MISSING',
  FOLDER_UNREACHABLE = 'FOLDER_UNREACHABLE',
}

export interface StartupReport {
  state: StartupState;
  stale_gc_lock: boolean;
  notes: string[];
}

export function freshStartupReport(state: StartupState = StartupState.HEALTHY): StartupReport {
  return { state, stale_gc_lock: false, notes: [] };
}
