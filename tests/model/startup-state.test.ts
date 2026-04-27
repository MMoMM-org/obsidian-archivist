import { describe, it, expect } from 'vitest';
import { StartupState, freshStartupReport } from '../../src/model/StartupState';

describe('StartupState', () => {
  it('covers all ROB-008 crash-recovery variants', () => {
    const values = Object.values(StartupState);
    for (const k of [
      'HEALTHY',
      'FRESH_FOLDER',
      'INDEX_MISSING',
      'HEAD_STALE',
      'HEAD_POINTS_TO_MISSING',
      'SNAPSHOT_INDEX_STALE',
      'DEVICE_CONFLICT',
      'AUTH_MISSING',
      'FOLDER_UNREACHABLE',
    ]) {
      expect(values).toContain(k);
    }
  });

  it('freshStartupReport defaults to HEALTHY with no flags', () => {
    const r = freshStartupReport();
    expect(r.state).toBe(StartupState.HEALTHY);
    expect(r.stale_gc_lock).toBe(false);
    expect(r.notes).toEqual([]);
  });
});
