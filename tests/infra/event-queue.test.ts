// T4.3 — EventQueue: append-only queue with committed_through cursor,
// 1-second dedup window, promise-chained writes via PluginStore.
//
// Tests verify:
//   - init() primes in-memory cache from PluginStore
//   - enqueue() generates an id and persists
//   - peekSince(cursor) filters by strict observed_at > cursor
//   - peekSince(null) returns all entries
//   - advanceCursor() persists + committedThrough() reflects new value
//   - Dedup: same (path, type) within 1s → duplicate dropped
//   - Dedup: same (path, type) after 1s → both kept
//   - Dedup: different type same path → both kept
//   - Dedup: rename requires matching prev_path to dedup
//   - Crash survival: fresh EventQueue over same PluginStore state has all entries
//   - Concurrency (ROB-003): 10 enqueue + 10 advanceCursor via Promise.all stays consistent

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/infra/Logger';
import { PluginStore } from '../../src/infra/PluginStore';
import { EventQueue } from '../../src/infra/EventQueue';
import type { QueueEntry } from '../../src/model/QueueEntry';

// ---------------------------------------------------------------------------
// Helpers — re-use the fake adapter / plugin / logger pattern from plugin-store.test.ts
// ---------------------------------------------------------------------------

type FakeAdapter = {
  files: Map<string, string>;
  read: (p: string) => Promise<string>;
  write: (p: string, data: string) => Promise<void>;
  exists: (p: string) => Promise<boolean>;
  remove: (p: string) => Promise<void>;
};

function makeFakeAdapter(): FakeAdapter {
  const files = new Map<string, string>();
  return {
    files,
    read: async (p) => {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    write: async (p, data) => {
      files.set(p, data);
    },
    exists: async (p) => files.has(p),
    remove: async (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`) as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }
      files.delete(p);
    },
  };
}

type FakePlugin = {
  manifest: { id: string; dir: string };
  app: { vault: { adapter: FakeAdapter; configDir: string } };
  _data: unknown;
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
};

function makePlugin(adapter: FakeAdapter): FakePlugin {
  return {
    manifest: { id: 'obsidian-archivist', dir: '.obsidian/plugins/obsidian-archivist' },
    app: { vault: { adapter, configDir: '.obsidian' } },
    _data: null,
    async loadData() {
      return this._data;
    },
    async saveData(d: unknown) {
      this._data = d;
    },
  };
}

function makeTestLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makePluginStore(adapter: FakeAdapter): PluginStore {
  const plugin = makePlugin(adapter);
  const logger = makeTestLogger();
  return new PluginStore(plugin as never, logger);
}

function makeEventQueue(adapter: FakeAdapter): EventQueue {
  return new EventQueue(makePluginStore(adapter));
}

const QUEUE_PATH = '.obsidian/plugins/obsidian-archivist/pending_changes.json';

function makeEntry(
  overrides: Partial<Omit<QueueEntry, 'id'>> & Pick<Omit<QueueEntry, 'id'>, 'type' | 'path'>,
): Omit<QueueEntry, 'id'> {
  return {
    prev_path: null,
    observed_at: '2026-04-24T10:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: init()
// ---------------------------------------------------------------------------

describe('EventQueue.init()', () => {
  it('primes the in-memory cache from PluginStore when storage has entries', async () => {
    const adapter = makeFakeAdapter();
    const store = makePluginStore(adapter);

    // Seed storage with an existing queue
    await store.saveQueue({
      schema_version: '1.0',
      committed_through: '2026-04-24T09:00:00.000Z',
      entries: [
        {
          id: 'existing-1',
          type: 'create',
          path: 'notes/a.md',
          prev_path: null,
          observed_at: '2026-04-24T09:30:00.000Z',
        },
      ],
    });

    const queue = new EventQueue(store);
    await queue.init();

    const entries = queue.peekSince(null);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('existing-1');
    expect(queue.committedThrough()).toBe('2026-04-24T09:00:00.000Z');
  });

  it('starts empty when storage has no queue file', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    expect(queue.peekSince(null)).toHaveLength(0);
    expect(queue.committedThrough()).toBeNull();
  });

  it('is idempotent — multiple init() calls do not duplicate entries', async () => {
    const adapter = makeFakeAdapter();
    const store = makePluginStore(adapter);

    await store.saveQueue({
      schema_version: '1.0',
      committed_through: null,
      entries: [
        {
          id: 'e1',
          type: 'modify',
          path: 'notes/b.md',
          prev_path: null,
          observed_at: '2026-04-24T10:00:00.000Z',
        },
      ],
    });

    const queue = new EventQueue(store);
    await queue.init();
    await queue.init();

    expect(queue.peekSince(null)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: enqueue()
// ---------------------------------------------------------------------------

describe('EventQueue.enqueue()', () => {
  it('generates a UUID id and appends to in-memory cache', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    await queue.enqueue(makeEntry({ type: 'create', path: 'notes/foo.md' }));

    const entries = queue.peekSince(null);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('persists the entry to pending_changes.json', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    await queue.enqueue(makeEntry({ type: 'create', path: 'notes/foo.md' }));

    expect(adapter.files.has(QUEUE_PATH)).toBe(true);
    const persisted = JSON.parse(adapter.files.get(QUEUE_PATH)!);
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0].path).toBe('notes/foo.md');
  });

  it('appends multiple entries in order', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    await queue.enqueue(makeEntry({ type: 'create', path: 'a.md', observed_at: '2026-04-24T10:00:00.000Z' }));
    await queue.enqueue(makeEntry({ type: 'modify', path: 'b.md', observed_at: '2026-04-24T10:05:00.000Z' }));

    const entries = queue.peekSince(null);
    expect(entries).toHaveLength(2);
    expect(entries[0].path).toBe('a.md');
    expect(entries[1].path).toBe('b.md');
  });
});

// ---------------------------------------------------------------------------
// Tests: peekSince()
// ---------------------------------------------------------------------------

describe('EventQueue.peekSince()', () => {
  it('returns all entries when cursor is null', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    await queue.enqueue(makeEntry({ type: 'create', path: 'a.md', observed_at: '2026-04-24T10:00:00.000Z' }));
    await queue.enqueue(makeEntry({ type: 'modify', path: 'b.md', observed_at: '2026-04-24T11:00:00.000Z' }));

    expect(queue.peekSince(null)).toHaveLength(2);
  });

  it('returns only entries with observed_at strictly greater than cursor', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    const cursor = '2026-04-24T10:00:00.000Z';
    await queue.enqueue(makeEntry({ type: 'create', path: 'a.md', observed_at: '2026-04-24T09:00:00.000Z' }));
    await queue.enqueue(makeEntry({ type: 'modify', path: 'b.md', observed_at: cursor })); // equal — excluded
    await queue.enqueue(makeEntry({ type: 'delete', path: 'c.md', observed_at: '2026-04-24T11:00:00.000Z' }));

    const result = queue.peekSince(cursor);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('c.md');
  });

  it('is in-memory — does not perform I/O', async () => {
    const adapter = makeFakeAdapter();
    const readSpy = vi.spyOn(adapter, 'read');
    const queue = makeEventQueue(adapter);
    await queue.init();
    await queue.enqueue(makeEntry({ type: 'create', path: 'x.md' }));

    readSpy.mockClear();
    queue.peekSince(null);

    expect(readSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: advanceCursor()
// ---------------------------------------------------------------------------

describe('EventQueue.advanceCursor()', () => {
  it('sets committedThrough() to the given timestamp', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    await queue.advanceCursor('2026-04-24T12:00:00.000Z');

    expect(queue.committedThrough()).toBe('2026-04-24T12:00:00.000Z');
  });

  it('persists the cursor to pending_changes.json', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    await queue.advanceCursor('2026-04-24T12:00:00.000Z');

    const persisted = JSON.parse(adapter.files.get(QUEUE_PATH)!);
    expect(persisted.committed_through).toBe('2026-04-24T12:00:00.000Z');
  });

  it('does NOT remove entries older than cursor', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    await queue.enqueue(makeEntry({ type: 'create', path: 'old.md', observed_at: '2026-04-24T09:00:00.000Z' }));
    await queue.advanceCursor('2026-04-24T12:00:00.000Z');

    // All entries still present in-memory
    expect(queue.peekSince(null)).toHaveLength(1);
    // On-disk also retains entries
    const persisted = JSON.parse(adapter.files.get(QUEUE_PATH)!);
    expect(persisted.entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: committedThrough()
// ---------------------------------------------------------------------------

describe('EventQueue.committedThrough()', () => {
  it('returns null before any advanceCursor call', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    expect(queue.committedThrough()).toBeNull();
  });

  it('reflects the most recent advanceCursor value', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    await queue.advanceCursor('2026-04-24T10:00:00.000Z');
    await queue.advanceCursor('2026-04-24T11:00:00.000Z');

    expect(queue.committedThrough()).toBe('2026-04-24T11:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Tests: deduplication
// ---------------------------------------------------------------------------

describe('EventQueue deduplication', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a second enqueue with same (path, type) within 1 second', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    vi.setSystemTime(new Date('2026-04-24T10:00:00.000Z'));
    await queue.enqueue(makeEntry({ type: 'modify', path: 'notes/a.md', observed_at: '2026-04-24T10:00:00.000Z' }));

    // 500ms later — within the 1s window
    vi.setSystemTime(new Date('2026-04-24T10:00:00.500Z'));
    await queue.enqueue(makeEntry({ type: 'modify', path: 'notes/a.md', observed_at: '2026-04-24T10:00:00.500Z' }));

    expect(queue.peekSince(null)).toHaveLength(1);
    const persisted = JSON.parse(adapter.files.get(QUEUE_PATH)!);
    expect(persisted.entries).toHaveLength(1);
  });

  it('keeps both entries when same (path, type) arrive ≥1000ms apart', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    vi.setSystemTime(new Date('2026-04-24T10:00:00.000Z'));
    await queue.enqueue(makeEntry({ type: 'modify', path: 'notes/a.md', observed_at: '2026-04-24T10:00:00.000Z' }));

    // Exactly 1000ms later — NOT a duplicate
    vi.setSystemTime(new Date('2026-04-24T10:00:01.000Z'));
    await queue.enqueue(makeEntry({ type: 'modify', path: 'notes/a.md', observed_at: '2026-04-24T10:00:01.000Z' }));

    expect(queue.peekSince(null)).toHaveLength(2);
  });

  it('keeps both entries when same path but different type', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    vi.setSystemTime(new Date('2026-04-24T10:00:00.000Z'));
    await queue.enqueue(makeEntry({ type: 'create', path: 'notes/a.md', observed_at: '2026-04-24T10:00:00.000Z' }));
    await queue.enqueue(makeEntry({ type: 'modify', path: 'notes/a.md', observed_at: '2026-04-24T10:00:00.000Z' }));

    expect(queue.peekSince(null)).toHaveLength(2);
  });

  it('deduplicates rename entries only when prev_path also matches', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    vi.setSystemTime(new Date('2026-04-24T10:00:00.000Z'));
    await queue.enqueue({
      type: 'rename',
      path: 'notes/b.md',
      prev_path: 'notes/a.md',
      observed_at: '2026-04-24T10:00:00.000Z',
    });

    // Same path+type+prev_path within 1s → duplicate
    vi.setSystemTime(new Date('2026-04-24T10:00:00.200Z'));
    await queue.enqueue({
      type: 'rename',
      path: 'notes/b.md',
      prev_path: 'notes/a.md',
      observed_at: '2026-04-24T10:00:00.200Z',
    });

    expect(queue.peekSince(null)).toHaveLength(1);
  });

  it('keeps both rename entries when prev_path differs', async () => {
    const adapter = makeFakeAdapter();
    const queue = makeEventQueue(adapter);
    await queue.init();

    vi.setSystemTime(new Date('2026-04-24T10:00:00.000Z'));
    await queue.enqueue({
      type: 'rename',
      path: 'notes/b.md',
      prev_path: 'notes/a.md',
      observed_at: '2026-04-24T10:00:00.000Z',
    });

    // Same path+type but different prev_path → NOT a duplicate
    vi.setSystemTime(new Date('2026-04-24T10:00:00.200Z'));
    await queue.enqueue({
      type: 'rename',
      path: 'notes/b.md',
      prev_path: 'notes/other.md',
      observed_at: '2026-04-24T10:00:00.200Z',
    });

    expect(queue.peekSince(null)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: crash survival
// ---------------------------------------------------------------------------

describe('EventQueue crash survival', () => {
  it('fresh EventQueue over same PluginStore state has all enqueued entries', async () => {
    const adapter = makeFakeAdapter();
    const store = makePluginStore(adapter);

    const queue1 = new EventQueue(store);
    await queue1.init();
    await queue1.enqueue(makeEntry({ type: 'create', path: 'a.md', observed_at: '2026-04-24T10:00:00.000Z' }));
    await queue1.enqueue(makeEntry({ type: 'modify', path: 'b.md', observed_at: '2026-04-24T10:01:00.000Z' }));
    // Simulate crash: advanceCursor never called

    // Reload from same store (which uses the same underlying adapter)
    const queue2 = new EventQueue(store);
    await queue2.init();

    // Both entries must survive
    const entries = queue2.peekSince(queue2.committedThrough());
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.path).sort()).toEqual(['a.md', 'b.md']);
  });
});

// ---------------------------------------------------------------------------
// Tests: concurrency (ROB-003)
// ---------------------------------------------------------------------------

describe('EventQueue concurrency (ROB-003)', () => {
  it('10 concurrent enqueue + 10 advanceCursor preserves all entries and final cursor', async () => {
    const adapter = makeFakeAdapter();
    const store = makePluginStore(adapter);
    const queue = new EventQueue(store);
    await queue.init();

    // Build 10 distinct entries (different paths to avoid dedup)
    const enqueueOps = Array.from({ length: 10 }, (_, i) =>
      queue.enqueue(
        makeEntry({ type: 'create', path: `notes/file-${i}.md`, observed_at: `2026-04-24T10:00:${String(i).padStart(2, '0')}.000Z` }),
      ),
    );

    // Build 10 advanceCursor calls with distinct timestamps
    const cursors = Array.from({ length: 10 }, (_, i) => `2026-04-24T09:00:${String(i).padStart(2, '0')}.000Z`);
    const advanceOps = cursors.map((ts) => queue.advanceCursor(ts));

    await Promise.all([...enqueueOps, ...advanceOps]);

    // Every enqueued entry must appear exactly once on disk
    const persisted = JSON.parse(adapter.files.get(QUEUE_PATH)!);
    expect(persisted.entries).toHaveLength(10);
    const paths = new Set(persisted.entries.map((e: QueueEntry) => e.path));
    expect(paths.size).toBe(10);

    // committedThrough must be one of the submitted cursor values
    expect(cursors).toContain(queue.committedThrough());

    // In-memory and on-disk cursor must agree
    expect(persisted.committed_through).toBe(queue.committedThrough());
  });
});
