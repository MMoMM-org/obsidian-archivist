import { ArchivistError, RateLimitError } from '../model/Errors';

// Exponential backoff with full-jitter. Single place that implements the
// ADR retry policy so individual services don't re-invent it.

export interface RetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
  jitter?: boolean;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  isRetryable?: (err: unknown) => boolean;
}

const DEFAULTS = {
  maxAttempts: 5,
  baseMs: 1_000,
  capMs: 60_000,
  jitter: true,
};

function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof ArchivistError) return err.retryable;
  return false;
}

// This helper runs in both the Obsidian renderer and Node test env. We use
// aliased references to setTimeout/clearTimeout so the util stays testable
// outside the plugin context. Window-aware call sites inject their own
// `sleep` via options when popout-window compatibility matters.
const setT: typeof setTimeout = setTimeout;
const clearT: typeof clearTimeout = clearTimeout;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const t = setT(resolve, ms);
    const onAbort = () => {
      clearT(t);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `fn`, retrying on retryable errors with exponential backoff.
 *
 *  - Non-retryable errors surface immediately.
 *  - RateLimitError.retryAfterSeconds overrides the computed backoff.
 *  - AbortSignal cancels the wait; the in-flight promise still runs to
 *    completion (Node has no way to cancel a generic Promise), but no
 *    further attempts are made after abort.
 *  - `jitter: true` (default) applies full-jitter (`random * cap`) per AWS
 *    guidance — smooths thundering-herd retries after a Dropbox 503.
 */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const cfg = { ...DEFAULTS, ...options };
  const sleep = options.sleep ?? defaultSleep;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;
  const rand = () => Math.random();

  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === cfg.maxAttempts) throw err;

      let delay: number;
      if (err instanceof RateLimitError && Number.isFinite(err.retryAfterSeconds)) {
        delay = Math.max(0, err.retryAfterSeconds * 1_000);
      } else {
        const exp = Math.min(cfg.capMs, cfg.baseMs * 2 ** (attempt - 1));
        delay = cfg.jitter ? Math.floor(rand() * exp) : exp;
      }
      await sleep(delay, options.signal);
    }
  }
  // Unreachable: loop either returns or throws.
  throw lastErr;
}
