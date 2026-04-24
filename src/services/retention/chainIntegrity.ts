import type { Logger } from '../../infra/Logger';

/**
 * Minimal snapshot shape required for chain-integrity walking.
 * Accepts any object with id, type, and parent_id — callers need not
 * construct full SnapshotIndexEntry objects (useful for tests and
 * composable use by RetentionService).
 */
export interface ChainSnapshot {
  id: string;
  type: 'full' | 'inc';
  parent_id: string | null;
}

/**
 * Pass 2 of the retention algorithm: transitive chain-integrity augmentation.
 *
 * For each snapshot in `tierKept`, walks ancestor chain up to and including
 * the nearest Full snapshot, adding every visited id to the result set.
 *
 * Contract:
 * - Must terminate for any input including cycles, self-references, and
 *   missing-parent edges.
 * - A missing parent manifest is a chain-break: the orphan referrer is kept
 *   (already in chainKeep) and `logger.warn('chain_broken', {...})` is called
 *   once per orphan referrer. If no logger is provided the warning is swallowed.
 * - Snapshots in `tierKept` whose id is not present in `snapshots` are silently
 *   skipped (no parent map entry → walk cannot start).
 * - This function is pure with respect to its inputs; it never mutates them.
 *
 * @param tierKept  Set of snapshot ids that survived the tier-retention pass.
 * @param snapshots Full snapshot list for the device (used to build parent map).
 * @param logger    Optional logger; only `warn` is used (chain_broken events).
 * @returns         Augmented keep set including all transitive ancestors.
 */
export function augmentWithAncestors(
  tierKept: ReadonlySet<string>,
  snapshots: ReadonlyArray<ChainSnapshot>,
  logger?: Logger,
): Set<string> {
  const parent = new Map<string, string | null>();
  const typeById = new Map<string, 'full' | 'inc'>();

  for (const s of snapshots) {
    parent.set(s.id, s.parent_id);
    typeById.set(s.id, s.type);
  }

  const chainKeep = new Set<string>();
  const warnedOrphans = new Set<string>();

  for (const startId of tierKept) {
    if (!typeById.has(startId)) continue;

    const visited = new Set<string>();
    let cur: string | null = startId;

    while (cur !== null) {
      if (visited.has(cur)) break; // cycle guard (ROB-009)
      visited.add(cur);
      chainKeep.add(cur);

      if (typeById.get(cur) === 'full') break; // stop at Full (inclusive)

      const rawParent: string | null | undefined = parent.get(cur);
      const nextParentId: string | null = rawParent !== undefined ? rawParent : null;

      if (nextParentId !== null && !typeById.has(nextParentId)) {
        // Missing parent — chain break
        const missingId: string = nextParentId;
        const referrerId: string = cur;
        if (!warnedOrphans.has(referrerId)) {
          warnedOrphans.add(referrerId);
          logger?.warn('chain_broken', { missing_parent_id: missingId, referrer_id: referrerId });
        }
        break;
      }

      cur = nextParentId;
    }
  }

  return chainKeep;
}
