// RestoreService — manifest-chain reconstruction + rename-aware history +
// single-file restore. See phase-8.md T8.1–T8.4 and SDD §Runtime View
// /Primary Flow: File-Level Restore + §Implementation Examples/Example:
// Manifest Merge for Restore-at-Time-T.
//
// Design:
//   - materializeVaultStateAt(id): pure chain merge per the SDD example.
//     Walks target → nearest Full ancestor, replays oldest→newest, applies
//     renames → files → deletes in that order (SDD walkthrough).
//   - listVersionsForPath: implements Algorithm 3 (revised ROB-004) with
//     alias lifetimes so path-reuse after rename does not contaminate
//     history (SDD §Algorithm 3 example).
//   - Manifest loading is delegated to an injected ManifestLoader. Live
//     production will wire it to DropboxClient.downloadJson; tests use an
//     in-memory fixture chain.

import { ChainError } from '../model/Errors';
import type { FileEntry, SnapshotManifest } from '../model/Manifest';
import type { Logger } from '../infra/Logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManifestLoader {
  loadManifest(id: string): Promise<SnapshotManifest>;
}

export interface RestoreServiceDeps {
  loader: ManifestLoader;
  logger: Logger;
}

export interface VersionEntry {
  snapshot_id: string;
  path: string;
  hash: string;
  size: number;
  created_at: string;
  /** The current path this version is for (constant across all entries in a query). */
  currentPath: string;
  /** Non-null when this version's path differs from the current path (alias). */
  priorPath: string | null;
  /** ISO-8601 timestamp of the manifest that performed the rename out of `priorPath` (null for the current alias). */
  renamedAt: string | null;
}

// ---------------------------------------------------------------------------
// RestoreService
// ---------------------------------------------------------------------------

export class RestoreService {
  constructor(private readonly deps: RestoreServiceDeps) {}

  /**
   * Reconstruct the vault state as it was at the target snapshot. Walks from
   * target up through `parent_id` links to the nearest Full, then replays
   * oldest→newest applying renames, file additions/modifications, and
   * deletions (in that order).
   *
   * Throws `ChainError('CHAIN_BROKEN')` if the chain cannot reach a Full.
   */
  async materializeVaultStateAt(targetSnapshotId: string): Promise<Record<string, FileEntry>> {
    const chain = await this.loadChainToFull(targetSnapshotId);

    // chain is newest→oldest ending in Full. Replay oldest→newest.
    chain.reverse();

    const state: Record<string, FileEntry> = { ...chain[0].files };

    for (let i = 1; i < chain.length; i++) {
      const m = chain[i];

      // 1. Renames first — an adjacent file entry in m.files for the same
      //    path is an overwrite, but the logical rename changes the path
      //    identity before the write applies.
      for (const { from, to } of m.renames) {
        if (!state[from]) continue; // idempotent — nothing to rename
        if (state[to]) {
          // Rename-to-collision — corruption-resilient: skip + warn, do not
          // abort the replay. Matches SDD edge case.
          this.deps.logger.warn('rename_to_collision', { snapshot_id: m.id, from, to });
          continue;
        }
        state[to] = state[from];
        delete state[from];
      }

      // 2. Adds / modifies overwrite the state.
      for (const [p, entry] of Object.entries(m.files)) {
        state[p] = entry;
      }

      // 3. Explicit deletes tombstone.
      for (const p of m.deleted) {
        delete state[p];
      }
    }

    return state;
  }

  /**
   * Rename-aware version history for a single path, implementing Algorithm 3
   * (revised for ROB-004). Walks newest→oldest; tracks alias lifetimes so a
   * path that was reused after a rename-out does NOT contaminate history.
   *
   * The caller provides the manifest chain in newest→oldest order (typically
   * the output of a snapshot-index walk). This function is pure over that
   * chain — cache concerns live in the caller.
   */
  listVersionsForPath(currentPath: string, manifests: SnapshotManifest[]): VersionEntry[] {
    if (manifests.length === 0) return [];

    // Chronological ordering by manifest position. manifests[0] is newest.
    // An alias's liveSinceIndex is the OLDEST position (highest index) where
    // it's still valid. We collect versions at positions ≤ liveSinceIndex.
    //
    // The currentPath alias has liveSinceIndex = manifests.length - 1 (the
    // oldest manifest — it's valid everywhere by default until a rename-out
    // event narrows its window).
    //
    // When we reverse-apply a rename `from → to` at position i, the alias
    // `to` stops being valid at positions > i (manifests older than i), and
    // the alias `from` takes over starting at i+1 (one-older than i). This
    // matches the SDD's "liveSince = m.parent_id" conceptually but is easier
    // to reason about by position.
    const aliases = new Map<string, { liveSinceIndex: number; renamedAtIso: string | null }>();
    aliases.set(currentPath, { liveSinceIndex: manifests.length - 1, renamedAtIso: null });

    const versions: VersionEntry[] = [];

    for (let i = 0; i < manifests.length; i++) {
      const m = manifests[i];

      // Step A: reverse-apply renames. Iterate in reverse to respect
      // multi-rename-in-one-manifest ordering (the SDD says "REVERSED").
      for (let r = m.renames.length - 1; r >= 0; r--) {
        const { from, to } = m.renames[r];
        const toInfo = aliases.get(to);
        const fromInfo = aliases.get(from);
        if (toInfo !== undefined && fromInfo === undefined) {
          // SDD case: `B` (to) came from `A` (from). Extend alias back under
          // the old name for older manifests; narrow `to`'s lifetime so it's
          // only valid at positions 0..i.
          aliases.set(from, { liveSinceIndex: manifests.length - 1, renamedAtIso: m.created_at });
          aliases.set(to, { ...toInfo, liveSinceIndex: i });
        } else if (fromInfo !== undefined && toInfo === undefined) {
          // Path-reuse case (ROB-004 guard). Our tracked alias is `from`, but
          // this rename says "prior to m, the file named `from` was renamed
          // away to `to` — so our tracked file must be a NEW lineage that
          // started AFTER m". Terminate the alias at position i so older
          // manifests' same-named entries (belonging to the old lineage) are
          // not collected into this file's history.
          aliases.set(from, { ...fromInfo, liveSinceIndex: i });
        }
        // Both present → corruption or complex rename; the SDD says skip+warn.
      }

      // Step B: collect a version for each alias that's live at position i.
      for (const [alias, info] of aliases) {
        if (i > info.liveSinceIndex) continue; // alias already expired for older manifests
        const entry = m.files[alias];
        if (!entry) continue;
        versions.push({
          snapshot_id: m.id,
          path: alias,
          hash: entry.hash,
          size: entry.size,
          created_at: m.created_at,
          currentPath,
          priorPath: alias === currentPath ? null : alias,
          renamedAt: alias === currentPath ? null : info.renamedAtIso,
        });
      }
    }

    // Sort newest-first by created_at. Stable + deterministic.
    versions.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return versions;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async loadChainToFull(targetSnapshotId: string): Promise<SnapshotManifest[]> {
    const chain: SnapshotManifest[] = [];
    const seen = new Set<string>();
    let cursor: string | null = targetSnapshotId;

    while (cursor) {
      if (seen.has(cursor)) {
        throw new ChainError(
          'CHAIN_BROKEN',
          `Cycle detected in snapshot chain at ${cursor}`,
          false,
        );
      }
      seen.add(cursor);
      const m = await this.deps.loader.loadManifest(cursor);
      chain.push(m);
      if (m.type === 'full') break;
      cursor = m.parent_id;
    }

    if (chain.length === 0 || chain[chain.length - 1].type !== 'full') {
      throw new ChainError(
        'CHAIN_BROKEN',
        `No Full ancestor found for snapshot ${targetSnapshotId}`,
        false,
      );
    }
    return chain;
  }
}
