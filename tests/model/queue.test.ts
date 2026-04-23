import { describe, it, expect } from 'vitest';
import {
  isQueueEntry,
  isEventQueue,
  parseQueueEntry,
  parseEventQueue,
  emptyEventQueue,
  type QueueEntry,
  type EventQueue,
} from '../../src/model/QueueEntry';
import { ConfigError } from '../../src/model/Errors';

const entry: QueueEntry = {
  id: 'aaaa-bbbb',
  type: 'modify',
  path: 'Notes/a.md',
  prev_path: null,
  observed_at: '2026-04-23T03:00:00Z',
};

const renameEntry: QueueEntry = {
  id: 'cccc-dddd',
  type: 'rename',
  path: 'Notes/b.md',
  prev_path: 'Notes/a.md',
  observed_at: '2026-04-23T03:01:00Z',
};

const queue: EventQueue = {
  schema_version: '1.0',
  committed_through: null,
  entries: [entry, renameEntry],
};

describe('QueueEntry + EventQueue', () => {
  it('empty queue factory parses back', () => {
    const e = emptyEventQueue();
    expect(isEventQueue(e)).toBe(true);
    expect(parseEventQueue(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  it('round-trips populated queue', () => {
    const round = JSON.parse(JSON.stringify(queue));
    expect(isEventQueue(round)).toBe(true);
    expect(parseEventQueue(round)).toEqual(queue);
  });

  it('rejects rename without prev_path', () => {
    const bad = { ...entry, type: 'rename' as const };
    expect(isQueueEntry(bad)).toBe(false);
    expect(() => parseQueueEntry(bad)).toThrow(ConfigError);
  });

  it.each([
    ['bad type', { ...entry, type: 'sneeze' }, 'queue_entry.type'],
    ['non-string path', { ...entry, path: 42 }, 'queue_entry.path'],
    ['prev_path wrong', { ...entry, prev_path: 0 }, 'queue_entry.prev_path'],
    ['missing id', { ...entry, id: undefined }, 'queue_entry.id'],
  ])('rejects entry: %s', (_l, bad, field) => {
    expect(isQueueEntry(bad)).toBe(false);
    try {
      parseQueueEntry(bad);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain(field);
    }
  });

  it('reports index of bad entry inside queue', () => {
    const bad = { ...queue, entries: [entry, { ...entry, type: 'oops' }] };
    try {
      parseEventQueue(bad);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ConfigError).message).toContain('queue.entries[1]');
    }
  });
});
