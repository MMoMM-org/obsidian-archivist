import { configInvalid } from './Errors';

export type ChangeType = 'create' | 'modify' | 'delete' | 'rename';

export interface QueueEntry {
  id: string;
  type: ChangeType;
  path: string;
  prev_path: string | null;
  observed_at: string;
}

export interface EventQueue {
  schema_version: '1.0';
  committed_through: string | null;
  entries: QueueEntry[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const CHANGE_TYPES: readonly ChangeType[] = ['create', 'modify', 'delete', 'rename'];

export function isQueueEntry(v: unknown): v is QueueEntry {
  if (!isObject(v)) return false;
  if (typeof v.id !== 'string') return false;
  if (!CHANGE_TYPES.includes(v.type as ChangeType)) return false;
  if (typeof v.path !== 'string') return false;
  if (v.prev_path !== null && typeof v.prev_path !== 'string') return false;
  if (typeof v.observed_at !== 'string') return false;
  // rename requires a concrete prev_path — other types must not set one.
  if (v.type === 'rename' && typeof v.prev_path !== 'string') return false;
  if (v.type !== 'rename' && v.prev_path !== null) return false;
  return true;
}

export function isEventQueue(v: unknown): v is EventQueue {
  if (!isObject(v)) return false;
  if (v.schema_version !== '1.0') return false;
  if (v.committed_through !== null && typeof v.committed_through !== 'string') return false;
  if (!Array.isArray(v.entries)) return false;
  return v.entries.every(isQueueEntry);
}

export function parseQueueEntry(raw: unknown): QueueEntry {
  if (!isObject(raw)) throw configInvalid('queue_entry', 'expected object');
  if (typeof raw.id !== 'string') throw configInvalid('queue_entry.id', 'expected string');
  if (!CHANGE_TYPES.includes(raw.type as ChangeType))
    throw configInvalid('queue_entry.type', `expected one of ${CHANGE_TYPES.join('|')}`);
  if (typeof raw.path !== 'string') throw configInvalid('queue_entry.path', 'expected string');
  if (raw.prev_path !== null && typeof raw.prev_path !== 'string')
    throw configInvalid('queue_entry.prev_path', 'expected string or null');
  if (typeof raw.observed_at !== 'string')
    throw configInvalid('queue_entry.observed_at', 'expected string');
  if (raw.type === 'rename' && typeof raw.prev_path !== 'string')
    throw configInvalid('queue_entry.prev_path', 'rename requires prev_path string');
  return raw as unknown as QueueEntry;
}

export function parseEventQueue(raw: unknown): EventQueue {
  if (!isObject(raw)) throw configInvalid('queue', 'expected object');
  if (raw.schema_version !== '1.0')
    throw configInvalid('queue.schema_version', `expected "1.0", got ${JSON.stringify(raw.schema_version)}`);
  if (raw.committed_through !== null && typeof raw.committed_through !== 'string')
    throw configInvalid('queue.committed_through', 'expected string or null');
  if (!Array.isArray(raw.entries)) throw configInvalid('queue.entries', 'expected array');
  raw.entries.forEach((e, i) => {
    try {
      parseQueueEntry(e);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw configInvalid(`queue.entries[${i}]`, msg);
    }
  });
  return raw as unknown as EventQueue;
}

export function emptyEventQueue(): EventQueue {
  return { schema_version: '1.0', committed_through: null, entries: [] };
}
