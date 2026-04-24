// T6.2 — augmentWithAncestors: transitive chain-integrity pass (SDD/ADR-16).
//
// Test coverage:
//   - Linear chain: Full ← Inc-A ← Inc-B; tierKept={Inc-B} → {Full, Inc-A, Inc-B}
//   - Forked chain: Full ← Inc-A ← Inc-B; Full ← Inc-A ← Inc-C; tierKept={Inc-B} → {Full, Inc-A, Inc-B} (C not included)
//   - Multi-hop (6 snapshots); tierKept={tip} → walks all the way to the Full
//   - Missing parent: Inc-Z.parent_id="missing-parent-id"; tierKept={Inc-Z} → {Inc-Z} + logger.warn('chain_broken')
//   - Cycle (3-node A→B→C→A): terminates, returns conservative keep-set {A,B,C}
//   - Self-cycle (A→A): terminates, returns {A}
//   - Orphan Full (not tier-kept, no descendants tier-kept): pruned (not in result)
//   - Empty tierKept → empty result

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/infra/Logger';
import { augmentWithAncestors } from '../../../src/services/retention/chainIntegrity';
import type { ChainSnapshot } from '../../../src/services/retention/chainIntegrity';
import { ChainError } from '../../../src/model/Errors';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function snap(id: string, type: 'full' | 'inc', parent_id: string | null): ChainSnapshot {
  return { id, type, parent_id };
}

function makeMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Linear chain
// ---------------------------------------------------------------------------

describe('augmentWithAncestors — linear chain', () => {
  // Full-F ← Inc-A ← Inc-B (parent_id points to parent)
  const snapshots = [
    snap('Full-F', 'full', null),
    snap('Inc-A', 'inc', 'Full-F'),
    snap('Inc-B', 'inc', 'Inc-A'),
  ];

  it('tierKept={Inc-B} → result contains Full-F, Inc-A, Inc-B', () => {
    const result = augmentWithAncestors(new Set(['Inc-B']), snapshots);
    expect(result).toEqual(new Set(['Full-F', 'Inc-A', 'Inc-B']));
  });

  it('tierKept={Inc-A} → result contains Full-F, Inc-A (not Inc-B)', () => {
    const result = augmentWithAncestors(new Set(['Inc-A']), snapshots);
    expect(result).toEqual(new Set(['Full-F', 'Inc-A']));
  });

  it('tierKept={Full-F} → result contains only Full-F (stops at full type)', () => {
    const result = augmentWithAncestors(new Set(['Full-F']), snapshots);
    expect(result).toEqual(new Set(['Full-F']));
  });
});

// ---------------------------------------------------------------------------
// Forked chain
// ---------------------------------------------------------------------------

describe('augmentWithAncestors — forked chain', () => {
  // Full-F ← Inc-A ← Inc-B
  //                 ← Inc-C
  const snapshots = [
    snap('Full-F', 'full', null),
    snap('Inc-A', 'inc', 'Full-F'),
    snap('Inc-B', 'inc', 'Inc-A'),
    snap('Inc-C', 'inc', 'Inc-A'),
  ];

  it('tierKept={Inc-B} → {Full-F, Inc-A, Inc-B} — Inc-C not included (not tier-kept)', () => {
    const result = augmentWithAncestors(new Set(['Inc-B']), snapshots);
    expect(result).toEqual(new Set(['Full-F', 'Inc-A', 'Inc-B']));
  });

  it('tierKept={Inc-B, Inc-C} → {Full-F, Inc-A, Inc-B, Inc-C}', () => {
    const result = augmentWithAncestors(new Set(['Inc-B', 'Inc-C']), snapshots);
    expect(result).toEqual(new Set(['Full-F', 'Inc-A', 'Inc-B', 'Inc-C']));
  });
});

// ---------------------------------------------------------------------------
// Multi-hop chain
// ---------------------------------------------------------------------------

describe('augmentWithAncestors — multi-hop chain', () => {
  // Full-F ← Inc-1 ← Inc-2 ← Inc-3 ← Inc-4 ← Inc-5 (tip)
  const snapshots = [
    snap('Full-F', 'full', null),
    snap('Inc-1', 'inc', 'Full-F'),
    snap('Inc-2', 'inc', 'Inc-1'),
    snap('Inc-3', 'inc', 'Inc-2'),
    snap('Inc-4', 'inc', 'Inc-3'),
    snap('Inc-5', 'inc', 'Inc-4'),
  ];

  it('tierKept={Inc-5} → all 6 snapshots in result', () => {
    const result = augmentWithAncestors(new Set(['Inc-5']), snapshots);
    expect(result).toEqual(new Set(['Full-F', 'Inc-1', 'Inc-2', 'Inc-3', 'Inc-4', 'Inc-5']));
  });
});

// ---------------------------------------------------------------------------
// Missing parent (chain break)
// ---------------------------------------------------------------------------

describe('augmentWithAncestors — missing parent', () => {
  it('orphan referrer is kept, logger.warn called with chain_broken and missing id', () => {
    const snapshots = [
      snap('Inc-Z', 'inc', 'missing-parent-id'),
    ];
    const logger = makeMockLogger();

    const result = augmentWithAncestors(new Set(['Inc-Z']), snapshots, logger);

    expect(result.has('Inc-Z')).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith('chain_broken', expect.objectContaining({
      missing_parent_id: 'missing-parent-id',
      referrer_id: 'Inc-Z',
    }));
  });

  it('without logger — missing parent is swallowed (no throw)', () => {
    const snapshots = [
      snap('Inc-Z', 'inc', 'missing-parent-id'),
    ];

    expect(() => augmentWithAncestors(new Set(['Inc-Z']), snapshots)).not.toThrow();
    const result = augmentWithAncestors(new Set(['Inc-Z']), snapshots);
    expect(result.has('Inc-Z')).toBe(true);
  });

  it('warn logged exactly once per orphan referrer (not per walk step)', () => {
    const snapshots = [
      snap('Inc-Z', 'inc', 'missing-parent-id'),
    ];
    const logger = makeMockLogger();

    augmentWithAncestors(new Set(['Inc-Z']), snapshots, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('payload.error is a ChainError instance with code CHAIN_BROKEN', () => {
    const snapshots = [
      snap('Inc-Z', 'inc', 'missing-parent-id'),
    ];
    const logger = makeMockLogger();

    augmentWithAncestors(new Set(['Inc-Z']), snapshots, logger);

    const [, payload] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { error: unknown }];
    expect(payload.error).toBeInstanceOf(ChainError);
    expect((payload.error as ChainError).code).toBe('CHAIN_BROKEN');
  });
});

// ---------------------------------------------------------------------------
// Cycle guard (ROB-009)
// ---------------------------------------------------------------------------

describe('augmentWithAncestors — cycle guard (ROB-009)', () => {
  it('3-cycle A→B→C→A terminates and returns conservative keep-set {A,B,C}', async () => {
    const snapshots = [
      snap('A', 'inc', 'C'),
      snap('B', 'inc', 'A'),
      snap('C', 'inc', 'B'),
    ];

    const resultPromise = Promise.resolve(augmentWithAncestors(new Set(['A']), snapshots));
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('function did not terminate')), 1000),
    );

    const result = await Promise.race([resultPromise, timeoutPromise]);
    expect(result.has('A')).toBe(true);
    expect(result.has('B')).toBe(true);
    expect(result.has('C')).toBe(true);
  });

  it('self-cycle A→A terminates and returns {A}', async () => {
    const snapshots = [snap('A', 'inc', 'A')];

    const resultPromise = Promise.resolve(augmentWithAncestors(new Set(['A']), snapshots));
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('function did not terminate')), 1000),
    );

    const result = await Promise.race([resultPromise, timeoutPromise]);
    expect(result.has('A')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Orphan Full pruning
// ---------------------------------------------------------------------------

describe('augmentWithAncestors — orphan Full pruning', () => {
  it('Full not tier-kept and no descendant tier-kept → not in result', () => {
    const snapshots = [
      snap('F1', 'full', null),
      snap('F2', 'full', null),
    ];

    const result = augmentWithAncestors(new Set(['F2']), snapshots);

    expect(result.has('F2')).toBe(true);
    expect(result.has('F1')).toBe(false);
  });

  it('Inc whose Full ancestor is not tier-kept still brings in the Full', () => {
    const snapshots = [
      snap('F1', 'full', null),
      snap('Inc-1', 'inc', 'F1'),
    ];

    const result = augmentWithAncestors(new Set(['Inc-1']), snapshots);

    expect(result).toEqual(new Set(['F1', 'Inc-1']));
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('augmentWithAncestors — edge cases', () => {
  it('empty tierKept → empty result', () => {
    const snapshots = [
      snap('Full-F', 'full', null),
      snap('Inc-A', 'inc', 'Full-F'),
    ];

    const result = augmentWithAncestors(new Set(), snapshots);
    expect(result.size).toBe(0);
  });

  it('empty snapshots list → empty result', () => {
    const result = augmentWithAncestors(new Set(['Inc-A']), []);
    expect(result.size).toBe(0);
  });

  it('tierKept id not present in snapshots → treated as chain-broken: id absent from result', () => {
    const snapshots = [snap('Full-F', 'full', null)];

    // 'Ghost-Inc' is not in the snapshot list at all
    const result = augmentWithAncestors(new Set(['Ghost-Inc']), snapshots);
    // The walk cannot start; Ghost-Inc has no parent mapping → nothing to walk
    expect(result.size).toBe(0);
  });
});
