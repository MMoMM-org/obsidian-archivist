import { describe, it, expect } from 'vitest';
import {
  ArchivistError,
  AuthError,
  NetworkError,
  RateLimitError,
  QuotaExceededError,
  PathError,
  CorruptionError,
  ChainError,
  ConflictError,
  ConfigError,
} from '../../src/model/Errors';

describe('ArchivistError hierarchy', () => {
  it('every subclass is an instanceof ArchivistError and Error', () => {
    const cases: ArchivistError[] = [
      new AuthError('TOKEN_REVOKED', 'revoked', false),
      new NetworkError('NET', 'net', true),
      new RateLimitError('RATE', 'rate', 30),
      new QuotaExceededError('QUOTA', 'q', false),
      new PathError('BAD_PATH', 'p', false),
      new CorruptionError('MANIFEST_CORRUPT', 'c', false),
      new ChainError('CHAIN_BROKEN', 'ch', false),
      new ConflictError('DEVICE_CONFLICT', 'co', false),
      new ConfigError('SCHEMA_INVALID', 'cfg', false),
    ];
    for (const e of cases) {
      expect(e).toBeInstanceOf(ArchivistError);
      expect(e).toBeInstanceOf(Error);
      expect(typeof e.code).toBe('string');
    }
  });

  it('RateLimitError carries retryAfterSeconds and is retryable', () => {
    const err = new RateLimitError('RATE', 'rate', 42);
    expect(err.retryAfterSeconds).toBe(42);
    expect(err.retryable).toBe(true);
  });

  it('name reflects subclass for debugging', () => {
    expect(new AuthError('A', 'a', false).name).toBe('AuthError');
    expect(new ConflictError('B', 'b', false).name).toBe('ConflictError');
  });

  it('stable code field — string, not enum', () => {
    const err = new ConfigError('SCHEMA_INVALID', 'x', false);
    expect(err.code).toBe('SCHEMA_INVALID');
  });

  it('preserves cause when provided', () => {
    const cause = new Error('underlying');
    const err = new NetworkError('NET', 'fail', true, cause);
    expect(err.cause).toBe(cause);
  });
});
