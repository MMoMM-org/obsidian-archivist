import { describe, it, expect } from 'vitest';
import { retry } from '../../src/util/retry';
import { NetworkError, PathError, RateLimitError } from '../../src/model/Errors';

function captureSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe('retry', () => {
  it('returns the first success without sleeping', async () => {
    const { delays, sleep } = captureSleep();
    const result = await retry(async () => 42, { sleep });
    expect(result).toBe(42);
    expect(delays).toEqual([]);
  });

  it('surfaces non-retryable errors immediately', async () => {
    const { delays, sleep } = captureSleep();
    const fn = async () => {
      throw new PathError('BAD_PATH', 'nope', false);
    };
    await expect(retry(fn, { sleep })).rejects.toBeInstanceOf(PathError);
    expect(delays).toEqual([]);
  });

  it('retries retryable errors up to maxAttempts with no jitter', async () => {
    const { delays, sleep } = captureSleep();
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new NetworkError('NET', 'transient', true);
    };
    await expect(
      retry(fn, { sleep, jitter: false, maxAttempts: 4, baseMs: 1_000, capMs: 60_000 }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toBe(4);
    expect(delays).toEqual([1_000, 2_000, 4_000]); // no sleep after the last failure
  });

  it('caps backoff at capMs', async () => {
    const { delays, sleep } = captureSleep();
    const fn = async () => {
      throw new NetworkError('NET', 't', true);
    };
    await expect(
      retry(fn, { sleep, jitter: false, maxAttempts: 5, baseMs: 10_000, capMs: 20_000 }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(delays).toEqual([10_000, 20_000, 20_000, 20_000]);
  });

  it('honors RateLimitError.retryAfterSeconds over computed backoff', async () => {
    const { delays, sleep } = captureSleep();
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw new RateLimitError('RATE', 'slow down', 3);
      return 'ok';
    };
    const result = await retry(fn, { sleep, jitter: false });
    expect(result).toBe('ok');
    expect(delays).toEqual([3_000]);
  });

  it('stops retrying when the abort signal fires', async () => {
    const { delays, sleep } = captureSleep();
    const controller = new AbortController();
    const fn = async () => {
      throw new NetworkError('NET', 't', true);
    };
    controller.abort();
    await expect(retry(fn, { sleep, signal: controller.signal })).rejects.toSatisfy(
      (e: unknown) => (e as { name?: string }).name === 'AbortError',
    );
    expect(delays).toEqual([]);
  });
});
