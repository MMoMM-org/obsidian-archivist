// SnapshotIndexStore — ADR-20 lightweight metadata cache over Dropbox.
//
// snapshot_index.json lives at `Apps/Archivist/<VAULT_PREFIX>/snapshot_index.json`.
// Writes are serialized via a promise chain (same pattern as PluginStore.enqueueWrite,
// ROB-003) so concurrent append calls never interleave partial JSON.

import { CorruptionError, PathError } from '../model/Errors';
import { parseSnapshotIndex } from '../model/SnapshotIndex';
import type { SnapshotIndex, SnapshotIndexEntry } from '../model/SnapshotIndex';
import type { SnapshotManifest } from '../model/Manifest';
import { snapshotIndexPath } from '../util/paths';
import type { DropboxClient } from '../infra/DropboxClient';

export interface SnapshotIndexStoreOptions {
  dropbox: DropboxClient;
  vaultPrefix: string;
  /** Injectable for tests — defaults to new Date().toISOString(). */
  now?: () => string;
}

export class SnapshotIndexStore {
  private readonly dropbox: DropboxClient;
  private readonly path: string;
  private readonly now: () => string;

  /** Promise-chain for serialized writes (ROB-003). */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: SnapshotIndexStoreOptions) {
    this.dropbox = opts.dropbox;
    this.path = snapshotIndexPath(opts.vaultPrefix);
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Downloads and parses the index. Returns null if missing; throws CorruptionError on bad data. */
  async read(): Promise<SnapshotIndex | null> {
    try {
      const raw = await this.dropbox.downloadJson<unknown>(this.path);
      try {
        return parseSnapshotIndex(raw);
      } catch (err) {
        throw new CorruptionError(
          'SNAPSHOT_INDEX_INVALID',
          'snapshot_index.json failed schema validation',
          false,
          err,
        );
      }
    } catch (err) {
      if (err instanceof PathError && err.code === 'PATH_NOT_FOUND') return null;
      throw err;
    }
  }

  /** Appends an entry to the index and persists. Serialized via write queue. */
  append(entry: SnapshotIndexEntry): Promise<void> {
    return this.enqueue(async () => {
      const index = (await this.readOrEmpty());
      index.snapshots.push(entry);
      index.last_updated_at = this.now();
      await this.dropbox.uploadJson(this.path, index);
    });
  }

  // NOT serialized via writeQueue — caller must ensure no concurrent append is in-flight.
  /** Removes the entry with the given id and persists. No-op if id not present. */
  async remove(id: string): Promise<void> {
    const index = await this.read();
    if (!index) return;
    const before = index.snapshots.length;
    index.snapshots = index.snapshots.filter((s) => s.id !== id);
    if (index.snapshots.length === before) return;
    index.last_updated_at = this.now();
    await this.dropbox.uploadJson(this.path, index);
  }

  /** Rebuilds the index from a list of manifests. Overwrites any existing index. */
  rebuild(manifests: SnapshotManifest[]): Promise<void> {
    const entries = manifests.map(manifestToIndexEntry);
    return this.rebuildFromEntries(entries);
  }

  /**
   * Like {@link rebuild} but accepts pre-extracted index entries. Lets
   * callers (e.g. RepairService) downloading and processing manifests in
   * batches discard each manifest's `files` map after computing its
   * blob_hashes — important when a vault has many large manifests
   * (hundreds of MB worth of file maps in the worst case).
   */
  rebuildFromEntries(entries: SnapshotIndexEntry[]): Promise<void> {
    return this.enqueue(async () => {
      const index: SnapshotIndex = {
        schema_version: '1.0',
        last_updated_at: this.now(),
        snapshots: entries.slice(),
      };
      await this.dropbox.uploadJson(this.path, index);
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(task);
    const recovered = next.catch(() => undefined);
    this.writeQueue = recovered;
    return next;
  }

  private async readOrEmpty(): Promise<SnapshotIndex> {
    const existing = await this.read();
    if (existing) return existing;
    return {
      schema_version: '1.0',
      last_updated_at: this.now(),
      snapshots: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueHashes(manifest: SnapshotManifest): string[] {
  const seen = new Set<string>();
  for (const entry of Object.values(manifest.files)) {
    seen.add(entry.hash);
  }
  return Array.from(seen);
}

/** Extract the index-row shape from a manifest. Public via rebuild() but
 * also exported for the streaming variant in RepairService. */
export function manifestToIndexEntry(m: SnapshotManifest): SnapshotIndexEntry {
  return {
    id: m.id,
    type: m.type,
    parent_id: m.parent_id,
    created_at: m.created_at,
    device_id: m.device_id,
    blob_hashes: uniqueHashes(m),
  };
}
