// T6.6 — 35-day synthetic retention soak test.
//
// Validates that the combined retention pipeline (evaluateTiers + augmentWithAncestors)
// produces correct results over a realistic 35-day snapshot history.
//
// Cadence design:
//   Full:  weekly, every Monday at 03:00 local. Day 0 of soak = Monday 2026-03-23.
//          Week boundaries: day 0 (2026-03-23), 7 (2026-03-30), 14 (2026-04-06),
//                           21 (2026-04-13), 28 (2026-04-20). → 5 Fulls total.
//   Inc:   every 15 min during a 2-hour active window 08:00-10:00 local.
//          = 8 Incs per active day × 35 days = 280 Incs total.
//          Each Inc chains from the most recent preceding snapshot.
//   Total: 5 Fulls + 280 Incs = 285 snapshots. Well within 200-400 target range.
//
// Vault model:
//   20 synthetic files. Each Inc's blob_hashes is the set of new hashes introduced
//   since its parent (simulating ~5 random file edits per active day).
//   Hash format: `hash-${createdAt}-${filePath}` (deterministic, no actual hashing).
//
// now = 2026-04-27T23:59:59.000Z (end of soak window, ~4 days after last snapshot).
//
// ---------------------------------------------------------------------------
// PRD-derived expected keep count (math documented below)
// ---------------------------------------------------------------------------
//
// Default settings:
//   never_prune_window_days: 14
//   recent_hours: 24
//   daily_days: 30
//   monthly_years: 3
//
// Step 1 — evaluateTiers (tier-only, no chain promotion yet):
//
//   Never-prune window (age <= 14d): now - 14d = 2026-04-13T23:59:59Z
//     Snapshots created on or after 2026-04-13 (day 21 onwards):
//       Fulls on days 21 (2026-04-13) and 28 (2026-04-20) = 2 Fulls
//       Incs on days 21-34 = 14 days × 8 = 112 Incs
//       Incs on day 35 (2026-04-27): 8 incs (08:00-09:45) — but now=23:59:59 same day,
//         so these are within 24h (recent_hours) AND within 14d window
//       Total snapshots age <= 14d: 2 + 112 + 8 = 122. BUT day 21 starts at 03:00
//       and falls exactly on the boundary (14d before now=2026-04-27T23:59:59Z means
//       cutoff = 2026-04-13T23:59:59Z; day 21 Full is at 2026-04-13T03:00Z — OUTSIDE).
//       Recalculate: day 22 (2026-04-14) to day 35 (2026-04-27) = 14 calendar days.
//       Day 21 Full (2026-04-13 03:00) is 14d + ~21h before now → OUTSIDE never-prune.
//       Days 22-35: 14 days × 8 incs = 112 Incs; day 28 Full (2026-04-20) = 1 Full.
//       Recent (24h): now - 24h = 2026-04-26T23:59:59Z; incs on day 35 (2026-04-27 08:00-09:45)
//         fall within never-prune already; no net new additions from recent tier.
//       Never-prune keeps: 112 Incs + 1 Full = 113.
//
//   Daily tier (last 30 days): cutoff = now - 30d = 2026-03-28T23:59:59Z
//     Days with snapshots on/after 2026-03-28: day 5 (2026-03-27 is outside; 2026-03-28
//       is day 5+1=day 6 from soak start 2026-03-23 if we count Mon as day 0).
//     Actually: soak starts 2026-03-23 (day 0). Day N = 2026-03-23 + N days.
//     daily cutoff = 2026-03-28T23:59:59Z = day 5.xxx → days 6-35 = 30 full days.
//     Each of the 30 days (6..35) has 8 Incs (and possibly a Full on day 7, 14, 21, 28).
//     Daily tier keeps the NEWEST snapshot per local calendar day = 1 per day = 30 snapshots.
//     The newest snapshot each day is the Inc at 09:45 (last of the 8 Incs that day).
//     On Full days (day 7, 14, 21, 28), the Inc at 09:45 is newer than the Full at 03:00,
//     so the Inc is kept by daily (Full is not, unless it is also in never-prune).
//     Days 1-5 have snapshots outside the daily window → not kept by daily.
//
//   Monthly tier (last 36 months): cutoff month = 2023-04
//     All snapshots in March 2026 and April 2026 fall within this window.
//     March 2026: newest snapshot = last Inc on day 8 (2026-03-31 09:45).
//       day 8 = 2026-03-31. This is also within daily window (day 6-35 range includes day 8).
//     April 2026: newest snapshot = last Inc on day 35 (2026-04-27 09:45).
//       Already kept by daily + never-prune.
//     No net new additions from monthly (both already covered by daily or never-prune).
//
//   Tier-only kept total: union of all tiers.
//     Never-prune adds: 113
//     Daily adds: 30 day-newest-incs (days 6-35). Some overlap with never-prune (days 22-35 = 14).
//     Net new from daily beyond never-prune: days 6-21 = 16 days × 1 newest = 16.
//     Monthly: no net new (already covered).
//     Tier-only total: 113 + 16 = 129.
//
//   NOTE: days 6-21 daily: the daily winner is the newest Inc of the day (09:45).
//     Days 7, 14, 21 are Full days. Full is at 03:00; Inc 09:45 wins the daily bucket.
//     So daily does NOT directly keep any Fulls (except day 0 Full which is outside daily).
//
// Step 2 — augmentWithAncestors (chain promotion):
//   For every kept Inc, we walk back to its Full ancestor and add all intermediaries.
//   Kept Incs after tier evaluation: 16 Incs from daily (days 6-21) + 112 Incs from
//     never-prune (days 22-35) = 128 Incs. Plus 1 Full from never-prune (day 28).
//
//   Chain structure:
//     Chain 1: Full(d0) ← Inc(d0,1st) ← ... ← Inc(d7,8th) ← ... ← Inc(d6,8th)
//       Wait — each week's Full starts a new chain. Between Fulls, Incs chain linearly.
//       Chain 1: Full(day 0) → 8 Incs/day × 7 days = 56 Incs (days 0-6 active window)
//                               Wait, day 0 is a Monday with a Full at 03:00.
//                               Day 0 active window 08:00-10:00 produces 8 Incs,
//                               all chaining from Full(day 0). Then days 1-6: 8 Incs/day
//                               chaining from each other.
//       Chain 2: Full(day 7) → covers days 7-13 (7 × 8 = 56 Incs, plus Full).
//       Chain 3: Full(day 14) → covers days 14-20.
//       Chain 4: Full(day 21) → covers days 21-27.
//       Chain 5: Full(day 28) → covers days 28-34.
//       Day 35 Incs chain from last Inc of day 34 → through chain 5.
//
//   Daily winners for days 6-21 needing chain promotion:
//     Day 6 (Incs chain back to Full(day 0)): keeps Full(day 0) + ALL 8×6+8×1=56 incs? No.
//       Walk from day 6's last Inc back to Full: day 6 last Inc → ... → Full(day 0).
//       This chain has: day 6 (8 incs) + day 5 (8) + day 4 (8) + day 3 (8) + day 2 (8)
//       + day 1 (8) + day 0 (8 incs) = 7×8=56 Incs in chain 1, all promoted.
//       But only the day 6 09:45 Inc is tier-kept; walking back adds ALL 55 ancestors
//       plus Full(day 0) = 57 new snapshots added.
//     Actually, augmentWithAncestors walks the chain for EACH tier-kept id.
//     For day 7's daily winner (09:45 Inc): walks back through 8×1=8 Incs of day 7
//       then hits Full(day 7) → stops. Adds 7 Incs (before the day-7 09:45) + Full(day 7).
//     For day 6's daily winner: walks through days 6..0 → Full(day 0): 7×8=56 Incs + Full(day 0).
//     For days 8-13 daily winners: walks to Full(day 7), adding all intermediate Incs.
//     For days 14-20 daily winners: walks to Full(day 14).
//     For day 21's daily winner: walks to Full(day 21).
//     For days 22-27 never-prune Incs: each has its own walk. But all walk to Full(day 21).
//       The walk from day 27 last Inc visits ALL Incs from day 27 back to day 21's Inc(09:45)
//       plus day 21 Full. Day 21 Full is thus promoted.
//     For days 28-35 never-prune Incs: they walk back to Full(day 28).
//
//   After augmentation, the kept set contains:
//     - All 5 Fulls (each is reached by at least one kept Inc's chain walk)
//     - All 280 Incs (all are on the ancestor path of some tier-kept snapshot)
//
//   Wait, are ALL 280 Incs kept? Let's check:
//     Days 1-5 Incs (days 1,2,3,4,5 = 5×8 = 40 Incs): are any of these on the ancestor
//     path of a tier-kept snapshot?
//     The daily winner on day 6 (last Inc of day 6) chains back through day 5 last Inc, ...,
//     day 5 first Inc, day 4 last Inc, ..., day 0 Incs, Full(day 0).
//     So YES: days 1-5 Incs ARE on the ancestor path of the day 6 daily winner.
//     Day 0 Incs (8 incs) are also on that path.
//     So after augmentation, ALL 285 snapshots are kept.
//
//   Hmm, but wait: day 0 Incs are on day 0 (2026-03-23). The daily tier window only
//   covers days 6-35 (cutoff 2026-03-28T23:59:59Z). Day 0 ends at 2026-03-23T23:59:59Z,
//   which is BEFORE the daily cutoff. So day 0 Incs are NOT directly kept by any tier.
//   But they ARE on the ancestor chain of day 6's daily winner. So they get promoted.
//
//   Expected after augmentation: 285 (all snapshots). But let me double-check:
//   Are days 1-5 Incs needed by any kept snapshot?
//   Day 6 daily winner walks: Inc(d6,t8) → Inc(d6,t7) → ... → Inc(d6,t1) → Inc(d5,t8)
//     → Inc(d5,t7) → ... → Inc(d0,t1) → Full(d0).
//   Yes, all 56 Incs in chain 1 are on that path. And the day 6 winner is tier-kept.
//   So all 5+5 = 10 "dead zone" (days 1-5) × 8 = 40 Incs get promoted.
//   Plus all days 6-35 Incs (30 × 8 = 240) and all 5 Fulls → 40+240+5 = 285.
//
//   HOWEVER, this only holds if day 6's daily winner is the ONLY tier-kept snapshot
//   in chain 1. If day 5's Incs are ALSO tier-kept (e.g., by never-prune or daily),
//   they don't need promotion — but they're counted regardless.
//   Result: all 285 snapshots kept.
//
//   Tolerance ±1 for PRD: expected = 285.
//
// Performance gate: evaluateTiers on 285 snapshots must complete in < 100ms.
//
// Blob bound: total unique blob_hashes across kept snapshots ≤ 20 × kept_count.
//   (Conservative; real uniqueness is much lower due to CAS dedup, but the test only
//   validates the bound, not actual dedup efficiency.)

import { describe, expect, it } from 'vitest';
import type { SnapshotIndexEntry } from '../../src/model/SnapshotIndex';
import type { RetentionSettings } from '../../src/model/Settings';
import { DEFAULT_SETTINGS } from '../../src/model/Settings';
import { evaluateTiers } from '../../src/services/retention/evaluator';
import { augmentWithAncestors } from '../../src/services/retention/chainIntegrity';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VAULT_FILE_COUNT = 20;
const EDITS_PER_DAY = 5;
const SOAK_DAYS = 35;
const INC_INTERVAL_MINUTES = 15;
const ACTIVE_WINDOW_START_HOUR = 8;
const ACTIVE_WINDOW_END_HOUR = 10; // 2-hour window: 08:00-09:45 = 8 incs/day
const INC_PER_DAY = ((ACTIVE_WINDOW_END_HOUR - ACTIVE_WINDOW_START_HOUR) * 60) / INC_INTERVAL_MINUTES;
const FULL_CADENCE_DAYS = 7; // weekly

// Soak starts on 2026-03-23 (Monday). Day 0 = 2026-03-23T00:00:00.000Z.
// now = 2026-04-27T23:59:59.000Z (2 days after last active day = day 35 = 2026-04-27).
const SOAK_ORIGIN = new Date('2026-03-23T00:00:00.000Z');
const SOAK_NOW = new Date('2026-04-27T23:59:59.000Z');
const DEVICE_ID = 'soak-device-001';

// Vault file paths (20 synthetic files)
const VAULT_FILES: string[] = Array.from({ length: VAULT_FILE_COUNT }, (_, i) =>
  `notes/file-${String(i + 1).padStart(2, '0')}.md`,
);

// ---------------------------------------------------------------------------
// Soak snapshot generator
// ---------------------------------------------------------------------------

interface SoakResult {
  snapshots: SnapshotIndexEntry[];
  fullCount: number;
  incCount: number;
}

/**
 * Generates 35 days of snapshots at realistic cadence:
 *   - Full: weekly (every 7 days starting from day 0, at 03:00).
 *   - Inc: every 15 min during 08:00-10:00 active window each day.
 *
 * Blob hashes: each Inc introduces hashes for EDITS_PER_DAY randomly-selected
 * files (deterministic by day+time index). Each Full introduces hashes for all
 * VAULT_FILE_COUNT files (full content snapshot).
 *
 * Chain: each Inc chains from the most recent preceding snapshot (Full or Inc).
 * Each Full starts a new chain (parent_id = null).
 */
function generateSoakSnapshots(): SoakResult {
  const snapshots: SnapshotIndexEntry[] = [];
  let lastId: string | null = null;
  let snapshotCounter = 0;

  function makeId(type: 'full' | 'inc', dayIndex: number, timeKey: string): string {
    snapshotCounter++;
    return `${type}-d${String(dayIndex).padStart(2, '0')}-${timeKey}-${String(snapshotCounter).padStart(4, '0')}`;
  }

  function isoTs(baseMs: number, extraMs: number): string {
    return new Date(baseMs + extraMs).toISOString();
  }

  for (let day = 0; day < SOAK_DAYS; day++) {
    const dayBaseMs = SOAK_ORIGIN.getTime() + day * 24 * 60 * 60 * 1000;

    // --- Weekly Full at 03:00 ---
    if (day % FULL_CADENCE_DAYS === 0) {
      const createdAt = isoTs(dayBaseMs, 3 * 60 * 60 * 1000); // 03:00
      const id = makeId('full', day, '0300');
      const blobHashes = VAULT_FILES.map((f) => `hash-${createdAt}-${f}`);
      snapshots.push({
        id,
        type: 'full',
        parent_id: null,
        created_at: createdAt,
        device_id: DEVICE_ID,
        blob_hashes: blobHashes,
      });
      lastId = id;
    }

    // --- Incremental snapshots during active window 08:00-09:45 ---
    for (let slot = 0; slot < INC_PER_DAY; slot++) {
      const offsetMs = (ACTIVE_WINDOW_START_HOUR * 60 + slot * INC_INTERVAL_MINUTES) * 60 * 1000;
      const createdAt = isoTs(dayBaseMs, offsetMs);
      const hh = String(Math.floor((ACTIVE_WINDOW_START_HOUR * 60 + slot * INC_INTERVAL_MINUTES) / 60)).padStart(2, '0');
      const mm = String((slot * INC_INTERVAL_MINUTES) % 60).padStart(2, '0');
      const id = makeId('inc', day, `${hh}${mm}`);

      // Deterministic file edits: pick EDITS_PER_DAY files based on day+slot
      const editedFiles: string[] = [];
      for (let e = 0; e < EDITS_PER_DAY; e++) {
        const fileIndex = (day * INC_PER_DAY + slot + e) % VAULT_FILE_COUNT;
        editedFiles.push(VAULT_FILES[fileIndex]);
      }
      const blobHashes = editedFiles.map((f) => `hash-${createdAt}-${f}`);

      snapshots.push({
        id,
        type: 'inc',
        parent_id: lastId,
        created_at: createdAt,
        device_id: DEVICE_ID,
        blob_hashes: blobHashes,
      });
      lastId = id;
    }
  }

  const fullCount = snapshots.filter((s) => s.type === 'full').length;
  const incCount = snapshots.filter((s) => s.type === 'inc').length;
  return { snapshots, fullCount, incCount };
}

// ---------------------------------------------------------------------------
// Soak test
// ---------------------------------------------------------------------------

describe('Phase 6 — T6.6: 35-day retention soak', () => {
  // Build the snapshot history once (shared across all sub-tests in this describe).
  const { snapshots, fullCount, incCount } = generateSoakSnapshots();
  const retention: RetentionSettings = DEFAULT_SETTINGS.retention;

  it('snapshot generator produces expected cadence counts', () => {
    // 5 Fulls: days 0, 7, 14, 21, 28
    expect(fullCount).toBe(5);
    // INC_PER_DAY per day × 35 days
    expect(incCount).toBe(INC_PER_DAY * SOAK_DAYS);
    // Total
    expect(snapshots.length).toBe(5 + INC_PER_DAY * SOAK_DAYS);
  });

  it('snapshot chain structure: every Inc has a valid parent_id, every Full has null parent_id', () => {
    const ids = new Set(snapshots.map((s) => s.id));
    for (const s of snapshots) {
      if (s.type === 'full') {
        expect(s.parent_id).toBeNull();
      } else {
        expect(s.parent_id).not.toBeNull();
        expect(ids.has(s.parent_id!)).toBe(true);
      }
    }
  });

  it('evaluateTiers completes in < 100ms for the soak input (performance gate)', () => {
    const start = performance.now();
    evaluateTiers(snapshots, retention, SOAK_NOW);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('kept count (after augmentation) is within ±1 of PRD-derived expectation', () => {
    // PRD math summary (documented in file header):
    //   After augmentWithAncestors, all 285 snapshots are kept because:
    //   - The daily tier's kept snapshot on day 6 walks all the way back to Full(day 0),
    //     pulling in all 56 Incs in chain 1 that predate the daily window.
    //   - Similarly, every chain is fully traversable from a tier-kept snapshot.
    //   - Never-prune keeps 112 Incs + 1 Full directly (days 22-35).
    //   - Daily keeps 30 Incs directly (one newest per day, days 6-35).
    //   - augmentWithAncestors fills in all ancestors → all 5 Fulls + all 280 Incs = 285.
    //
    // Expected: 285. Tolerance: ±1 for bucket edge cases at soak boundary.
    const TOTAL_SNAPSHOTS = 5 + INC_PER_DAY * SOAK_DAYS; // 285
    const PRD_EXPECTED = TOTAL_SNAPSHOTS;

    const tierKept = evaluateTiers(snapshots, retention, SOAK_NOW);
    const chainKept = augmentWithAncestors(tierKept, snapshots);

    expect(chainKept.size).toBeGreaterThanOrEqual(PRD_EXPECTED - 1);
    expect(chainKept.size).toBeLessThanOrEqual(PRD_EXPECTED + 1);
  });

  it('no chain breaks: every kept Inc has its full ancestor chain also kept', () => {
    const tierKept = evaluateTiers(snapshots, retention, SOAK_NOW);
    const chainKept = augmentWithAncestors(tierKept, snapshots);

    // Build parent map for fast lookup
    const parentById = new Map<string, string | null>();
    const typeById = new Map<string, 'full' | 'inc'>();
    for (const s of snapshots) {
      parentById.set(s.id, s.parent_id);
      typeById.set(s.id, s.type);
    }

    let chainBreakCount = 0;

    for (const id of chainKept) {
      const type = typeById.get(id);
      if (type !== 'inc') continue;

      // Walk back to the Full — every node must also be in chainKept
      let cur: string | null = id;
      const visited = new Set<string>();
      while (cur !== null) {
        if (visited.has(cur)) break; // cycle guard
        visited.add(cur);

        if (!chainKept.has(cur)) {
          chainBreakCount++;
          break;
        }

        if (typeById.get(cur) === 'full') break;
        cur = parentById.get(cur) ?? null;
      }
    }

    expect(chainBreakCount).toBe(0);
  });

  it('augmentWithAncestors is idempotent over the augmented set', () => {
    const tierKept = evaluateTiers(snapshots, retention, SOAK_NOW);
    const chainKept1 = augmentWithAncestors(tierKept, snapshots);
    // Running augmentWithAncestors again on the already-augmented set must yield the same size
    const chainKept2 = augmentWithAncestors(chainKept1, snapshots);
    expect(chainKept2.size).toBe(chainKept1.size);
    for (const id of chainKept1) {
      expect(chainKept2.has(id)).toBe(true);
    }
  });

  it('total referenced blob_hashes across kept snapshots is within conservative bound', () => {
    const tierKept = evaluateTiers(snapshots, retention, SOAK_NOW);
    const chainKept = augmentWithAncestors(tierKept, snapshots);

    const keptSnapshots = snapshots.filter((s) => chainKept.has(s.id));
    const uniqueBlobs = new Set<string>();
    for (const s of keptSnapshots) {
      for (const h of s.blob_hashes) {
        uniqueBlobs.add(h);
      }
    }

    // Conservative bound: vault_size × kept_count.
    // Real dedup makes this much lower, but we only assert no explosion.
    const conservativeBound = VAULT_FILE_COUNT * chainKept.size;
    expect(uniqueBlobs.size).toBeLessThanOrEqual(conservativeBound);

    // Sanity: there are actually some blobs (non-trivial history)
    expect(uniqueBlobs.size).toBeGreaterThan(0);
  });

  it('all 5 Fulls are retained after augmentation (each Full is reachable from kept Incs)', () => {
    const tierKept = evaluateTiers(snapshots, retention, SOAK_NOW);
    const chainKept = augmentWithAncestors(tierKept, snapshots);

    const fulls = snapshots.filter((s) => s.type === 'full');
    expect(fulls).toHaveLength(5);
    for (const f of fulls) {
      expect(chainKept.has(f.id)).toBe(true);
    }
  });

  it('never-prune invariant: all snapshots within last 14 days are in chainKept', () => {
    const neverPruneCutoffMs = SOAK_NOW.getTime() - retention.never_prune_window_days * 24 * 60 * 60 * 1000;

    const tierKept = evaluateTiers(snapshots, retention, SOAK_NOW);
    const chainKept = augmentWithAncestors(tierKept, snapshots);

    for (const s of snapshots) {
      if (new Date(s.created_at).getTime() >= neverPruneCutoffMs) {
        expect(chainKept.has(s.id)).toBe(true);
      }
    }
  });
});
