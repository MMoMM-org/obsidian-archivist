// EventQueue — append-only event queue with committed_through cursor.
//
// Backed by PluginStore for all persistence. ROB-003 write serialization
// is handled at the PluginStore layer (its enqueueWrite promise chain).
// EventQueue adds its own opQueue to serialize in-memory state mutations,
// preventing lost-update races between concurrent enqueue / advanceCursor calls.
//
// Dedup rule: entries with the same (path, type) — and for renames, also
// prev_path — whose observed_at timestamps are within 1 second of the most
// recent matching entry still in the queue are dropped at enqueue time.

import type { PluginStore } from './PluginStore';
import type { EventQueue as EventQueueData, QueueEntry } from '../model/QueueEntry';

const DEDUP_WINDOW_MS = 1000;

export class EventQueue {
  private state: EventQueueData = { schema_version: '1.0', committed_through: null, entries: [] };
  private initialized = false;
  private opQueue: Promise<void> = Promise.resolve();

  constructor(private readonly pluginStore: PluginStore) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    this.state = await this.pluginStore.loadQueue();
    this.initialized = true;
  }

  async enqueue(entry: Omit<QueueEntry, 'id'>): Promise<void> {
    const id = crypto.randomUUID();
    const full: QueueEntry = { id, ...entry };
    this.opQueue = this.opQueue.then(() => this.applyEnqueue(full));
    return this.opQueue;
  }

  peekSince(cursor: string | null): QueueEntry[] {
    if (cursor === null) return [...this.state.entries];
    return this.state.entries.filter((e) => e.observed_at > cursor);
  }

  async advanceCursor(ts: string): Promise<void> {
    this.opQueue = this.opQueue.then(() => this.applyAdvanceCursor(ts));
    return this.opQueue;
  }

  committedThrough(): string | null {
    return this.state.committed_through;
  }

  // ---- Private mutators (run inside opQueue) --------------------------------

  private async applyEnqueue(entry: QueueEntry): Promise<void> {
    if (this.isDuplicate(entry)) return;
    this.state = { ...this.state, entries: [...this.state.entries, entry] };
    await this.pluginStore.saveQueue(this.state);
  }

  private async applyAdvanceCursor(ts: string): Promise<void> {
    this.state = { ...this.state, committed_through: ts };
    await this.pluginStore.saveQueue(this.state);
  }

  private isDuplicate(entry: QueueEntry): boolean {
    const entryMs = new Date(entry.observed_at).getTime();
    return this.state.entries.some((existing) => {
      if (existing.path !== entry.path) return false;
      if (existing.type !== entry.type) return false;
      if (entry.type === 'rename' && existing.prev_path !== entry.prev_path) return false;
      const existingMs = new Date(existing.observed_at).getTime();
      return Math.abs(entryMs - existingMs) < DEDUP_WINDOW_MS;
    });
  }
}
