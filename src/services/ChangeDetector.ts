// ChangeDetector — wires vault events into EventQueue and performs reconcile scans.
//
// Design notes:
//   - Events before onLayoutReady are dropped (initial indexing noise).
//   - Exclusion filtering happens in BOTH event handlers (cheap path) and
//     reconcileScan (belt-and-braces, per Algorithm 1).
//   - reconcileScan yields every 500 files OR every 10 MB of hashed content,
//     whichever comes first (PERF-H2). Streaming-chunked hash is deferred —
//     WebCrypto has no incremental API. For files ≥ 10 MB we yield at the
//     file boundary (before + after hash). See Decisions Log entry 2026-04-24.
//   - getChangedPaths combines the in-memory queue with an optional reconcile pass
//     (Runtime View §7), filtering excluded paths belt-and-braces.

import type { Plugin, TAbstractFile } from 'obsidian';
import type { VaultAdapter } from '../infra/VaultAdapter';
import type { EventQueue } from '../infra/EventQueue';
import type { Logger } from '../infra/Logger';
import type { LocalIndex } from '../model/Index';
import type { ChangeType } from '../model/QueueEntry';
import { sha256hex } from '../infra/Hasher';
import { matchAny } from '../util/glob';

// Aliased reference so the obsidianmd/prefer-active-window-timers lint rule
// does not flag the default yieldFn — same pattern as retry.ts.
const setT: typeof setTimeout = setTimeout;

const YIELD_FILE_INTERVAL = 500;
const YIELD_BYTE_THRESHOLD = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChangeDetectorDeps {
  vault: VaultAdapter;
  queue: EventQueue;
  plugin: Plugin;
  logger: Logger;
  /**
   * Notification hook fired after every successful enqueue of a vault event.
   * Wired in production to SchedulerFSM.onVaultEvent() so the QUIET_WAIT
   * timer actually resets on activity. Tests can omit it.
   */
  onVaultActivity?: () => void;
  /** Injectable for tests — defaults to Hasher.sha256hex. */
  hash?: (bytes: Uint8Array | ArrayBuffer) => Promise<string>;
  /** Injectable for tests — defaults to setTimeout(resolve, 0). */
  yieldFn?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// ChangeDetector
// ---------------------------------------------------------------------------

export class ChangeDetector {
  private readonly vault: VaultAdapter;
  private readonly queue: EventQueue;
  private readonly plugin: Plugin;
  private readonly logger: Logger;
  private onVaultActivity: () => void;
  private readonly hash: (bytes: Uint8Array | ArrayBuffer) => Promise<string>;
  private readonly yieldFn: () => Promise<void>;

  private layoutReady = false;
  private exclusions: string[] = [];

  constructor(deps: ChangeDetectorDeps) {
    this.vault = deps.vault;
    this.queue = deps.queue;
    this.plugin = deps.plugin;
    this.logger = deps.logger;
    this.onVaultActivity = deps.onVaultActivity ?? (() => {});
    this.hash = deps.hash ?? sha256hex;
    this.yieldFn = deps.yieldFn ?? (() => new Promise<void>((resolve) => setT(resolve, 0)));
  }

  // ---- Public API -----------------------------------------------------------

  /**
   * Subscribe to vault events. Events before onLayoutReady are dropped.
   * Call once during plugin.onload(). Use setExclusions() for runtime updates —
   * calling registerEventHandlers a second time would duplicate vault listeners.
   */
  registerEventHandlers(exclusions: string[] = []): void {
    this.exclusions = exclusions;

    this.plugin.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
    });

    this.vault.onVaultCreate((file) => this.dispatch('create', file, null));
    this.vault.onVaultModify((file) => this.dispatch('modify', file, null));
    this.vault.onVaultDelete((file) => this.dispatch('delete', file, null));
    this.vault.onVaultRename((file, oldPath) => this.dispatch('rename', file, oldPath));
  }

  /** Update the event-time exclusion list without re-registering vault handlers. */
  setExclusions(exclusions: string[]): void {
    this.exclusions = exclusions;
  }

  /**
   * Late-bind the activity callback. Production wires this to
   * SchedulerFSM.onVaultEvent — but the FSM is constructed AFTER ChangeDetector
   * (BackupService construction depends on the detector), so the wiring has
   * to happen post-hoc.
   */
  setOnVaultActivity(fn: () => void): void {
    this.onVaultActivity = fn;
  }

  /** Full-vault reconcile scan per Algorithm 1. Returns the set of changed paths. */
  async reconcileScan(index: LocalIndex, exclusions: string[]): Promise<Set<string>> {
    const changed = new Set<string>();
    const files = this.vault.getFiles();
    const filesByPath = new Map(files.map((f) => [f.path, f]));
    let bytesSinceYield = 0;

    for (let i = 0; i < files.length; i++) {
      const f = files[i];

      if (matchAny(exclusions, f.path)) continue;

      const idxEntry = index.files[f.path];
      let yieldedThisIter = false;
      if (!idxEntry) {
        changed.add(f.path);
      } else if (f.mtime !== idxEntry.mtime || f.size !== idxEntry.size) {
        // Cheap dirty-bit miss — confirm via content hash (PERF-H2 large-file).
        // Yield before processing a ≥ 10 MB file so the hash doesn't block
        // animations or timers queued behind us. The byte accumulator is
        // reset and the post-file yield is suppressed so we don't fire twice
        // for the same file.
        if (f.size >= YIELD_BYTE_THRESHOLD) {
          await this.yieldFn();
          bytesSinceYield = 0;
          yieldedThisIter = true;
        }
        const bytes = await this.vault.readBytes(f.path);
        const h = await this.hash(bytes);
        if (h !== idxEntry.hash) changed.add(f.path);
        if (!yieldedThisIter) bytesSinceYield += f.size;
      }

      if (!yieldedThisIter &&
          ((i + 1) % YIELD_FILE_INTERVAL === 0 || bytesSinceYield >= YIELD_BYTE_THRESHOLD)) {
        await this.yieldFn();
        bytesSinceYield = 0;
      }
    }

    // Detect deletions: in index but not in vault
    for (const p of Object.keys(index.files)) {
      if (!filesByPath.has(p)) changed.add(p);
    }

    return changed;
  }

  /**
   * Combined changed-path set (Runtime View §7).
   * Always includes queue entries since committed_through cursor.
   * When opts.reconcile=true, also merges the full reconcile scan result.
   * Excludes paths matching the given exclusion globs (belt-and-braces).
   */
  async getChangedPaths(
    index: LocalIndex,
    exclusions: string[],
    opts: { reconcile: boolean },
  ): Promise<Set<string>> {
    const queued = this.queue
      .peekSince(this.queue.committedThrough())
      .map((e) => e.path)
      .filter((p) => !matchAny(exclusions, p));

    const changed = new Set<string>(queued);

    if (opts.reconcile) {
      const scanned = await this.reconcileScan(index, exclusions);
      for (const p of scanned) changed.add(p);
    }

    return changed;
  }

  // ---- Private event dispatch ----------------------------------------------

  /**
   * Single choke-point for every vault event. Uses an async IIFE so that a
   * synchronous throw from queue.enqueue (e.g. the init-guard) is routed
   * through the same catch branch as an async rejection — the handler must
   * never let an exception escape back into Obsidian's event dispatcher.
   */
  private dispatch(type: ChangeType, file: TAbstractFile, prevPath: string | null): void {
    if (!this.layoutReady) return;
    if (matchAny(this.exclusions, file.path)) return;
    void (async () => {
      await this.queue.enqueue({
        type,
        path: file.path,
        prev_path: prevPath,
        observed_at: new Date().toISOString(),
      });
      // Diagnostic breadcrumb so a user with diagnostic_logging on can
      // correlate "I edited X" → queue grew → FSM (maybe) reset its timer.
      // Visible only at debug; would otherwise spam the console.
      this.logger.debug('vault_event_enqueued', { type, path: file.path });
      // Notify the scheduler so QUIET_WAIT resets while the user is still
      // editing. Done after a successful enqueue so a failed write doesn't
      // get treated as activity.
      this.onVaultActivity();
    })().catch((err) => {
      this.logger.error('change_detector_enqueue_failed', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    });
  }
}
