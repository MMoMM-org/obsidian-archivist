// DiagnosticsModal — "Show diagnostics" palette command (#143).
//
// Why it exists: backup and scheduling problems (a weekly FULL that never
// runs, a chain that grows until the depth cap forces a FULL, a manifest
// cache that keeps missing) are invisible in the UI and only partly visible
// in the console. This modal shows the state behind them in one place and
// lets the user copy it into a bug report.
//
// Metadata only (Constitution L2): snapshot ids, timestamps, counts and
// settings values — no file contents, no vault paths, no error messages
// (those can carry paths; the error code is enough to route a report).
//
// Same split as ErrorDetailsModal: the report is built by a pure function and
// rendered through a ModalHandle, so tests run without Obsidian.

import { Modal, type App } from 'obsidian';
import { makeContentElHandle, type ModalHandle } from './ConfirmRestoreModal';
import { captureFocus } from './focus';
import { S } from './strings';
import type { SnapshotIndexEntry } from '../model/SnapshotIndex';
import type { BackupProgressSnapshot } from '../services/BackupProgress';
import type { PluginSettings } from '../model/Settings';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiagnosticsInput {
  generatedAt: number;
  pluginVersion: string;
  fsmState: string;
  lastFull: { id: string | null; commitAt: string | null };
  lastInc: { id: string | null; commitAt: string | null };
  nextScheduledFullAt: number;
  catchupPending: boolean;
  skippedCycleAt: number | null;
  lastError: { code: string; kind: 'inc' | 'full'; at: number } | null;
  /** Remote snapshot index entries, or null when the index could not be loaded. */
  snapshots: SnapshotIndexEntry[] | null;
  manifestCache: { cached: number; max: number; hits: number; misses: number };
  progress: BackupProgressSnapshot | null;
  settings: Pick<PluginSettings, 'schedule' | 'retention' | 'advanced'>;
}

export interface DiagnosticsModalOpts {
  input: DiagnosticsInput;
  onCopy: (report: string) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Incremental snapshots between `startId` and its FULL ancestor, read from the
 * snapshot index (no Dropbox calls). `complete: false` when a link is missing
 * from the index, so the count is a lower bound.
 */
export function chainDepthFromIndex(
  snapshots: SnapshotIndexEntry[],
  startId: string | null,
): { depth: number; complete: boolean } {
  if (startId === null) return { depth: 0, complete: true };
  const byId = new Map(snapshots.map((s) => [s.id, s] as const));
  const seen = new Set<string>();
  let depth = 0;
  let cursor: string | null = startId;
  while (cursor !== null) {
    const entry = byId.get(cursor);
    if (!entry || seen.has(cursor)) return { depth, complete: false };
    if (entry.type === 'full') return { depth, complete: true };
    seen.add(cursor);
    depth += 1;
    cursor = entry.parent_id;
  }
  return { depth, complete: false };
}

function iso(epochMs: number | null): string {
  return epochMs === null ? 'none' : new Date(epochMs).toISOString();
}

function snapshotLine(ref: { id: string | null; commitAt: string | null }): string {
  if (ref.id === null) return 'none';
  return ref.commitAt ? `${ref.id} (committed ${ref.commitAt})` : ref.id;
}

export function buildDiagnosticsReport(input: DiagnosticsInput): string {
  const { schedule, retention, advanced } = input.settings;
  const lines = [
    '[archivist] diagnostics',
    `generated: ${iso(input.generatedAt)}`,
    `plugin version: ${input.pluginVersion}`,
    '',
    '# Backup state',
    `scheduler state: ${input.fsmState}`,
    `last full: ${snapshotLine(input.lastFull)}`,
    `last inc: ${snapshotLine(input.lastInc)}`,
  ];

  if (input.snapshots) {
    const chain = chainDepthFromIndex(input.snapshots, input.lastInc.id ?? input.lastFull.id);
    lines.push(`chain depth since last full: ${chain.depth}${chain.complete ? '' : ' (incomplete — link missing in index)'}`);
  } else {
    lines.push('chain depth since last full: unknown (snapshot index not loaded)');
  }

  lines.push(
    `next scheduled full: ${iso(input.nextScheduledFullAt)}`,
    `catch-up pending: ${input.catchupPending ? 'yes' : 'no'}`,
    `skipped cycle: ${iso(input.skippedCycleAt)}`,
    `last error: ${input.lastError ? `${input.lastError.code} (${input.lastError.kind}, ${iso(input.lastError.at)})` : 'none'}`,
  );

  const p = input.progress;
  lines.push(
    `running backup: ${p ? `${p.kind}, ${p.phase} ${p.current}/${p.total}, started ${iso(p.startedAtMs)}` : 'none'}`,
    '',
    '# Snapshots',
  );
  if (input.snapshots) {
    const fulls = input.snapshots.filter((s) => s.type === 'full').length;
    const blobRefs = input.snapshots.reduce((n, s) => n + s.blob_hashes.length, 0);
    lines.push(
      `snapshots: ${input.snapshots.length} (full ${fulls}, inc ${input.snapshots.length - fulls})`,
      `blob hash references in index: ${blobRefs}`,
    );
  } else {
    lines.push('snapshots: unknown (snapshot index not loaded)');
  }
  const mc = input.manifestCache;
  lines.push(
    `manifest cache: ${mc.cached}/${mc.max} cached, ${mc.hits} hits, ${mc.misses} misses`,
    '',
    '# Settings',
    `full backup: ${schedule.full_cadence}, day ${schedule.full_day_of_week}, ${schedule.full_time_of_day}`,
    `incremental interval: ${schedule.inc_interval_minutes} min`,
    `retention: keep newest ${retention.always_keep_n}, recent ${retention.recent_hours} h, never-prune ${retention.never_prune_window_days} d, daily ${retention.daily_days} d, monthly ${retention.monthly_years} y`,
    `upload parallelism: ${advanced.upload_parallelism}`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Pure rendering — exercised directly by tests
// ---------------------------------------------------------------------------

export function renderDiagnosticsContent(handle: ModalHandle, opts: DiagnosticsModalOpts): void {
  const report = buildDiagnosticsReport(opts.input);
  handle.setTitle(S.DIAGNOSTICS_TITLE);
  handle.setBody(S.DIAGNOSTICS_INTRO);
  for (const line of report.split('\n').slice(1)) {
    if (line !== '') handle.addLine(line);
  }
  handle.addButton(S.DIAGNOSTICS_COPY, false, () => {
    void opts.onCopy(report);
  });
  handle.addButton(S.DIAGNOSTICS_CLOSE, true, () => handle.close());
  handle.onKeydown((key) => {
    if (key === 'Escape') handle.close();
  });
}

// ---------------------------------------------------------------------------
// DiagnosticsModal — Obsidian Modal subclass
// ---------------------------------------------------------------------------

export class DiagnosticsModal extends Modal {
  private triggerEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly opts: DiagnosticsModalOpts,
  ) {
    super(app);
  }

  onOpen(): void {
    this.triggerEl = captureFocus(activeDocument);
    const handle = makeContentElHandle(this.contentEl, this.modalEl, () => {
      this.triggerEl?.focus();
      this.close();
    });
    renderDiagnosticsContent(handle, this.opts);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
