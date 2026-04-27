// StatusTooltip — pure formatter for the status-bar / ribbon hover text.
//
// Goal: give the user a live diagnostic at a glance. The interesting case
// is QUIET_WAIT after an edit — the countdown should restart from the full
// quiet_after_event_minutes, which is direct evidence that the change was
// detected. Same idea for READY with a queued change: "next inc in N min"
// proves the queue grew.

import type { FSMState } from '../services/SchedulerFSM';
import type { BackupProgressSnapshot } from '../services/BackupProgress';

export interface StatusTooltipInput {
  state: FSMState;
  /** Epoch-ms when GRACE expires; null unless state === 'GRACE'. */
  graceEndAt: number | null;
  /** Epoch-ms when QUIET_WAIT expires; null unless state === 'QUIET_WAIT'. */
  quietWaitEndAt: number | null;
  /** Epoch-ms when the inc-interval cooldown ends; null on first inc after a full. */
  nextIncEligibleAt: number | null;
  /** Epoch-ms of the next scheduled full backup (always defined). */
  nextScheduledFullAt: number;
  /** Pending vault events waiting to be folded into an inc. */
  queueSize: number;
  /** Current time, injectable for tests. */
  now: number;
  /**
   * Live backup progress (phase + counts). Only consulted when state is
   * BACKUP_RUNNING; null at all other times. Tests omit it freely.
   */
  progress?: BackupProgressSnapshot | null;
}

/** Round up to whole minutes, with a 1-min floor so we never show "0 min". */
function minutesUntil(ts: number, now: number): number {
  const diff = ts - now;
  if (diff <= 0) return 0;
  return Math.max(1, Math.ceil(diff / 60_000));
}

function formatPhaseLabel(phase: BackupProgressSnapshot['phase']): string {
  switch (phase) {
    case 'reading':
      return 'reading';
    case 'uploading':
      return 'uploading';
    case 'committing':
      return 'committing';
  }
}

function formatHHmm(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatStatusTooltip(input: StatusTooltipInput): string {
  switch (input.state) {
    case 'LOADING':
      return 'Archivist — starting up';

    case 'GRACE': {
      if (input.graceEndAt === null) return 'Archivist — starting up';
      const m = minutesUntil(input.graceEndAt, input.now);
      return m === 0
        ? 'Archivist — eligible now'
        : `Archivist — eligible in ${m} min`;
    }

    case 'QUIET_WAIT': {
      if (input.quietWaitEndAt === null) return 'Archivist — waiting for activity to settle';
      const m = minutesUntil(input.quietWaitEndAt, input.now);
      return m === 0
        ? 'Archivist — backup pending'
        : `Archivist — next backup in ~${m} min`;
    }

    case 'READY': {
      // Queue empty → no inc due, only the next scheduled full matters.
      if (input.queueSize === 0) {
        return `Archivist — idle, next full at ${formatHHmm(input.nextScheduledFullAt)}`;
      }
      // Queue non-empty → show inc countdown. null means "first inc, eligible now".
      if (input.nextIncEligibleAt === null || input.nextIncEligibleAt <= input.now) {
        return 'Archivist — inc backup pending';
      }
      const m = minutesUntil(input.nextIncEligibleAt, input.now);
      return `Archivist — next inc in ${m} min`;
    }

    case 'BACKUP_RUNNING': {
      const p = input.progress ?? null;
      if (p === null) return 'Archivist — backing up…';
      const phaseLabel = formatPhaseLabel(p.phase);
      // total === 0 means "phase started but the count is trivially zero"
      // (e.g. inc with deletes-only — no read/upload work). Show the phase
      // verb without a misleading "0/0" suffix.
      if (p.total <= 0) return `Archivist — ${phaseLabel}…`;
      return `Archivist — ${phaseLabel} ${p.current}/${p.total}`;
    }

    case 'PASSIVE':
      return 'Archivist — paused (another device backs up)';

    case 'ERROR':
      return 'Archivist — last backup failed';

    case 'AUTH_LOST':
      return 'Archivist — reconnect Dropbox';
  }
}
