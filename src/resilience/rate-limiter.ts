/**
 * Token bucket rate limiter.
 *
 * Carriers publish quotas — DHL's tracking API allows a fixed number of calls
 * per unit time, and exceeding it earns a 429 or a suspended key. Waiting to
 * be told off by someone else's API is a poor way to discover your own limits,
 * so the limiter enforces them on our side of the call.
 *
 * Token bucket rather than a fixed window because a fixed window allows twice
 * the intended rate across a boundary: spend the whole allowance at 0:59, and
 * the whole next allowance at 1:01. The bucket refills continuously, so the
 * rate holds over any window you care to measure.
 *
 * Allowing a burst is deliberate. Traffic arrives in clumps, and a limiter
 * that permits no burst at all makes normal usage feel broken while still
 * averaging well below the quota.
 */

export interface RateLimiterOptions {
  /** Sustained rate. */
  tokensPerSecond: number;
  /** Bucket size — how much burst is tolerated. */
  burstCapacity?: number;
  now?: () => number;
}

export class RateLimitExceededError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Rate limit exceeded; retry in ${retryAfterMs}ms`);
    this.name = 'RateLimitExceededError';
  }
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  private readonly tokensPerSecond: number;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.tokensPerSecond = options.tokensPerSecond;
    this.capacity = options.burstCapacity ?? Math.max(1, options.tokensPerSecond);
    this.now = options.now ?? Date.now;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  /** Takes a token, or throws with how long until one is available. */
  consume(count = 1): void {
    this.refill();

    if (this.tokens < count) {
      const shortfall = count - this.tokens;
      throw new RateLimitExceededError(
        Math.ceil((shortfall / this.tokensPerSecond) * 1000),
      );
    }

    this.tokens -= count;
  }

  /** Non-throwing variant, for callers that want to decide themselves. */
  tryConsume(count = 1): boolean {
    try {
      this.consume(count);
      return true;
    } catch {
      return false;
    }
  }

  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = this.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;

    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSeconds * this.tokensPerSecond,
    );
    this.lastRefill = now;
  }
}
