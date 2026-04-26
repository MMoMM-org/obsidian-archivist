import { describe, it, expect } from 'vitest';
import { createLogger } from '../../src/infra/Logger';
import { ConfigError, NetworkError } from '../../src/model/Errors';

function makeSink() {
  const calls: { level: string; message: string; payload?: unknown }[] = [];
  return {
    calls,
    log: (m: string, p?: unknown) => {
      calls.push({ level: 'log', message: m, payload: p });
    },
    warn: (m: string, p?: unknown) => {
      calls.push({ level: 'warn', message: m, payload: p });
    },
    error: (m: string, p?: unknown) => {
      calls.push({ level: 'error', message: m, payload: p });
    },
  };
}

describe('Logger', () => {
  it('emits without payload when none is given', () => {
    const sink = makeSink();
    const logger = createLogger(() => false, { sink });
    logger.info('op completed');
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toEqual({ level: 'log', message: '[archivist] op completed', payload: undefined });
  });

  it('redacts path-like fields when diagnostic flag is false', () => {
    const sink = makeSink();
    const logger = createLogger(() => false, { sink });
    logger.info('read path', { path: 'Secret/Folder/Note.md' });
    expect(sink.calls[0]!.payload).toEqual({ path: 'Secret/Folder/<redacted>' });
  });

  it('emits path verbatim when diagnostic flag is true', () => {
    const sink = makeSink();
    let flag = false;
    const logger = createLogger(() => flag, { sink });
    flag = true;
    logger.info('read path', { path: 'Secret/Folder/Note.md' });
    expect(sink.calls[0]!.payload).toEqual({ path: 'Secret/Folder/Note.md' });
  });

  it('redacts prev_path on rename events', () => {
    const sink = makeSink();
    const logger = createLogger(() => false, { sink });
    logger.info('renamed', { path: 'new.md', prev_path: 'old.md' });
    expect(sink.calls[0]!.payload).toEqual({ path: '<redacted>', prev_path: '<redacted>' });
  });

  it('redacts arrays of paths', () => {
    const sink = makeSink();
    const logger = createLogger(() => false, { sink });
    logger.info('batch', { path: ['a/b.md', 'c/d.md'] });
    expect(sink.calls[0]!.payload).toEqual({ path: ['a/<redacted>', 'c/<redacted>'] });
  });

  it('normalizes ArchivistError — always exposes code', () => {
    const sink = makeSink();
    const logger = createLogger(() => false, { sink });
    const err = new ConfigError('SCHEMA_INVALID', 'bad', false);
    logger.error('config failed', { error: err });
    const payload = sink.calls[0]!.payload as { error: { code: string; name: string } };
    expect(payload.error.code).toBe('SCHEMA_INVALID');
    expect(payload.error.name).toBe('ConfigError');
  });

  it('includes retryable flag on normalized error', () => {
    const sink = makeSink();
    const logger = createLogger(() => false, { sink });
    const err = new NetworkError('NET', 't', true);
    logger.warn('transient', { error: err });
    const payload = sink.calls[0]!.payload as { error: { retryable: boolean } };
    expect(payload.error.retryable).toBe(true);
  });

  it('leaves non-path scalar payloads intact', () => {
    const sink = makeSink();
    const logger = createLogger(() => false, { sink });
    logger.info('stats', { count: 42, ok: true });
    expect(sink.calls[0]!.payload).toEqual({ count: 42, ok: true });
  });

  it('drops debug entries when diagnostic flag is false', () => {
    const sink = makeSink();
    const logger = createLogger(() => false, { sink });
    logger.debug('quiet detail', { count: 1 });
    expect(sink.calls).toHaveLength(0);
  });

  it('emits debug entries when diagnostic flag is true', () => {
    const sink = makeSink();
    const logger = createLogger(() => true, { sink });
    logger.debug('detail', { path: 'Notes/Secret.md', count: 1 });
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toEqual({
      level: 'log',
      message: '[archivist] detail',
      payload: { path: 'Notes/Secret.md', count: 1 },
    });
  });
});
