/**
 * Retry with exponential backoff and full jitter.
 *
 * Carrier APIs fail transiently — a 503 during their deploy, a dropped
 * connection, a timeout under load. Retrying is obvious. Retrying *well* is
 * where the details are:
 *
 * Backoff is exponential because retrying immediately against a struggling
 * service adds load to the thing already failing.
 *
 * Jitter is full rather than none, because without it every client that
 * failed at the same moment retries at the same moment. A carrier recovering
 * from an outage then gets a synchronised thundering herd and falls over
 * again. Full jitter spreads retries across the whole window.
 *
 * Only some failures are retried. A 400 means the request was wrong and will
 * be wrong again; a 404 means the tracking number does not exist. Retrying
 * either wastes the caller's time and the carrier's quota. A 429 is retried
 * but honours Retry-After when the carrier sends one, because guessing when
 * you have been told the answer is rude.
 */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected in tests so they do not spend real seconds sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests to make jitter deterministic. */
  random?: () => number;
}

export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

export class PermanentError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PermanentError';
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 200,
    maxDelayMs = 5000,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // A permanent failure will not become a different answer on retry.
      if (error instanceof PermanentError) throw error;

      if (attempt === maxAttempts) break;

      await sleep(delayFor(attempt, error, { baseDelayMs, maxDelayMs, random }));
    }
  }

  throw lastError;
}

function delayFor(
  attempt: number,
  error: unknown,
  opts: { baseDelayMs: number; maxDelayMs: number; random: () => number },
): number {
  // The carrier told us when to come back; believe it.
  if (error instanceof RetryableError && error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, opts.maxDelayMs);
  }

  const exponential = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
  // Full jitter: anywhere in [0, exponential], not exponential ± a wobble.
  return Math.floor(opts.random() * exponential);
}
