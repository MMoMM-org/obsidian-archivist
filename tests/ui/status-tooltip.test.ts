import { describe, it, expect } from 'vitest';
import { formatStatusTooltip, type StatusTooltipInput } from '../../src/ui/StatusTooltip';

const NOW = new Date('2026-04-26T22:00:00').getTime();

function input(overrides: Partial<StatusTooltipInput>): StatusTooltipInput {
  return {
    state: 'READY',
    graceEndAt: null,
    quietWaitEndAt: null,
    nextIncEligibleAt: null,
    nextScheduledFullAt: NOW + 8 * 60 * 60 * 1000,
    queueSize: 0,
    now: NOW,
    ...overrides,
  };
}

describe('formatStatusTooltip', () => {
  it('LOADING shows starting-up message', () => {
    expect(formatStatusTooltip(input({ state: 'LOADING' }))).toBe('Archivist — starting up');
  });

  it('GRACE shows minutes until eligible', () => {
    const t = formatStatusTooltip(input({
      state: 'GRACE',
      graceEndAt: NOW + 7 * 60_000 + 30_000, // ~7.5 min
    }));
    expect(t).toBe('Archivist — eligible in 8 min');
  });

  it('GRACE never shows 0 min while still in grace (1-min floor)', () => {
    const t = formatStatusTooltip(input({
      state: 'GRACE',
      graceEndAt: NOW + 5_000, // 5 seconds left
    }));
    expect(t).toBe('Archivist — eligible in 1 min');
  });

  it('GRACE shows "eligible now" when timer already elapsed', () => {
    const t = formatStatusTooltip(input({
      state: 'GRACE',
      graceEndAt: NOW - 1_000,
    }));
    expect(t).toBe('Archivist — eligible now');
  });

  it('QUIET_WAIT shows ~minutes until next backup', () => {
    const t = formatStatusTooltip(input({
      state: 'QUIET_WAIT',
      quietWaitEndAt: NOW + 110_000, // ~2 min
    }));
    expect(t).toBe('Archivist — next backup in ~2 min');
  });

  it('QUIET_WAIT countdown restarts after vault activity (timer end shifts forward)', () => {
    // Simulate: timer was 30s away, then resetQuietTimer pushed it back to 2min.
    const before = formatStatusTooltip(input({
      state: 'QUIET_WAIT',
      quietWaitEndAt: NOW + 30_000,
    }));
    const after = formatStatusTooltip(input({
      state: 'QUIET_WAIT',
      quietWaitEndAt: NOW + 120_000,
    }));
    expect(before).toBe('Archivist — next backup in ~1 min');
    expect(after).toBe('Archivist — next backup in ~2 min');
    // Distinct strings prove the user sees a visible reset.
    expect(before).not.toBe(after);
  });

  it('READY with empty queue shows next full clock time', () => {
    const t = formatStatusTooltip(input({
      state: 'READY',
      queueSize: 0,
      nextScheduledFullAt: new Date('2026-04-27T03:00:00').getTime(),
    }));
    expect(t).toBe('Archivist — idle, next full at 03:00');
  });

  it('READY with queued changes shows inc countdown', () => {
    const t = formatStatusTooltip(input({
      state: 'READY',
      queueSize: 3,
      nextIncEligibleAt: NOW + 12 * 60_000,
    }));
    expect(t).toBe('Archivist — next inc in 12 min');
  });

  it('READY with queued changes and overdue interval says "pending"', () => {
    const t = formatStatusTooltip(input({
      state: 'READY',
      queueSize: 3,
      nextIncEligibleAt: NOW - 60_000, // already past
    }));
    expect(t).toBe('Archivist — inc backup pending');
  });

  it('READY with queued changes and null eligibility (first inc) says "pending"', () => {
    const t = formatStatusTooltip(input({
      state: 'READY',
      queueSize: 3,
      nextIncEligibleAt: null,
    }));
    expect(t).toBe('Archivist — inc backup pending');
  });

  it('BACKUP_RUNNING shows running message', () => {
    expect(formatStatusTooltip(input({ state: 'BACKUP_RUNNING' }))).toBe('Archivist — backing up…');
  });

  it('PASSIVE shows paused message', () => {
    expect(formatStatusTooltip(input({ state: 'PASSIVE' }))).toBe(
      'Archivist — paused (another device backs up)',
    );
  });

  it('AUTH_LOST shows reconnect message', () => {
    expect(formatStatusTooltip(input({ state: 'AUTH_LOST' }))).toBe(
      'Archivist — reconnect Dropbox',
    );
  });

  it('ERROR shows last-backup-failed message', () => {
    expect(formatStatusTooltip(input({ state: 'ERROR' }))).toBe(
      'Archivist — last backup failed',
    );
  });

  it('BACKUP_RUNNING with progress shows phase and counts', () => {
    const t = formatStatusTooltip(input({
      state: 'BACKUP_RUNNING',
      progress: { kind: 'full', phase: 'uploading', current: 432, total: 5988, startedAtMs: NOW },
    }));
    expect(t).toBe('Archivist — uploading 432/5988');
  });

  it('BACKUP_RUNNING with progress total=0 shows phase verb only (no misleading 0/0)', () => {
    const t = formatStatusTooltip(input({
      state: 'BACKUP_RUNNING',
      progress: { kind: 'inc', phase: 'committing', current: 0, total: 0, startedAtMs: NOW },
    }));
    expect(t).toBe('Archivist — committing…');
  });

  it('BACKUP_RUNNING falls back to generic copy when progress is null', () => {
    const t = formatStatusTooltip(input({
      state: 'BACKUP_RUNNING',
      progress: null,
    }));
    expect(t).toBe('Archivist — backing up…');
  });
});
