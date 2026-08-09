import {
  CircuitBreaker,
  CircuitOpenError,
} from './circuit-breaker';
import {
  RateLimitExceededError,
  TokenBucket,
} from './rate-limiter';
import { PermanentError, RetryableError, withRetry } from './retry';

/** Collects sleep durations instead of waiting, so tests run instantly. */
function fakeSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

/** Controllable clock, so time-dependent behaviour is deterministic. */
function fakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('withRetry', () => {
  it('returns immediately when the operation succeeds', async () => {
    const operation = jest.fn().mockResolvedValue('ok');
    const { sleep, delays } = fakeSleep();

    await expect(withRetry(operation, { sleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(delays).toHaveLength(0);
  });

  it('retries a transient failure and succeeds', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new RetryableError('503'))
      .mockResolvedValue('ok');
    const { sleep } = fakeSleep();

    await expect(withRetry(operation, { sleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('gives up after the maximum attempts', async () => {
    const operation = jest.fn().mockRejectedValue(new RetryableError('503'));
    const { sleep } = fakeSleep();

    await expect(withRetry(operation, { sleep, maxAttempts: 3 })).rejects.toThrow('503');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry a permanent failure', async () => {
    // A 404 will still be a 404. Retrying wastes the caller's time and the
    // carrier's quota.
    const operation = jest
      .fn()
      .mockRejectedValue(new PermanentError('unknown tracking number', 404));
    const { sleep, delays } = fakeSleep();

    await expect(withRetry(operation, { sleep })).rejects.toBeInstanceOf(PermanentError);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(delays).toHaveLength(0);
  });

  it('backs off exponentially', async () => {
    const operation = jest.fn().mockRejectedValue(new RetryableError('503'));
    const { sleep, delays } = fakeSleep();

    // random() fixed at 1 so full jitter returns the top of each window,
    // making the exponential shape observable.
    await expect(
      withRetry(operation, {
        sleep,
        random: () => 1,
        maxAttempts: 4,
        baseDelayMs: 100,
      }),
    ).rejects.toThrow();

    expect(delays).toEqual([100, 200, 400]);
  });

  it('caps the delay at maxDelayMs', async () => {
    const operation = jest.fn().mockRejectedValue(new RetryableError('503'));
    const { sleep, delays } = fakeSleep();

    await expect(
      withRetry(operation, {
        sleep,
        random: () => 1,
        maxAttempts: 6,
        baseDelayMs: 1000,
        maxDelayMs: 3000,
      }),
    ).rejects.toThrow();

    expect(Math.max(...delays)).toBeLessThanOrEqual(3000);
  });

  it('applies jitter rather than a fixed schedule', async () => {
    // Without jitter every client that failed together retries together, and
    // the recovering service gets a synchronised herd.
    const operation = jest.fn().mockRejectedValue(new RetryableError('503'));
    const { sleep, delays } = fakeSleep();

    await expect(
      withRetry(operation, {
        sleep,
        random: () => 0.25,
        maxAttempts: 3,
        baseDelayMs: 400,
      }),
    ).rejects.toThrow();

    // 25% of each window, not the full window.
    expect(delays).toEqual([100, 200]);
  });

  it('honours Retry-After when the carrier supplies one', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new RetryableError('429', 1500))
      .mockResolvedValue('ok');
    const { sleep, delays } = fakeSleep();

    await withRetry(operation, { sleep, random: () => 1, baseDelayMs: 100 });

    expect(delays).toEqual([1500]);
  });
});

describe('CircuitBreaker', () => {
  it('passes calls through while closed', async () => {
    const breaker = new CircuitBreaker('dhl');
    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.currentState).toBe('closed');
  });

  it('opens after the failure threshold', async () => {
    const breaker = new CircuitBreaker('dhl', { failureThreshold: 3 });
    const failing = () => Promise.reject(new Error('down'));

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failing)).rejects.toThrow('down');
    }

    expect(breaker.currentState).toBe('open');
  });

  it('fails fast once open, without calling the carrier', async () => {
    const breaker = new CircuitBreaker('dhl', { failureThreshold: 1 });
    const operation = jest.fn().mockRejectedValue(new Error('down'));

    await expect(breaker.execute(operation)).rejects.toThrow('down');
    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(CircuitOpenError);

    // The second call never reached the carrier — that is the point.
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('resets the count on success, so the threshold means consecutive', async () => {
    const breaker = new CircuitBreaker('dhl', { failureThreshold: 3 });
    const fail = () => Promise.reject(new Error('down'));

    await expect(breaker.execute(fail)).rejects.toThrow();
    await expect(breaker.execute(fail)).rejects.toThrow();
    await breaker.execute(async () => 'ok');
    await expect(breaker.execute(fail)).rejects.toThrow();
    await expect(breaker.execute(fail)).rejects.toThrow();

    expect(breaker.currentState).toBe('closed');
  });

  it('moves to half-open after the cooldown', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker('dhl', {
      failureThreshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    });

    await expect(breaker.execute(() => Promise.reject(new Error('down')))).rejects.toThrow();
    expect(breaker.currentState).toBe('open');

    clock.advance(1000);
    expect(breaker.snapshot().state).toBe('half-open');
  });

  it('closes again when the probe succeeds', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker('dhl', {
      failureThreshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    });

    await expect(breaker.execute(() => Promise.reject(new Error('down')))).rejects.toThrow();
    clock.advance(1000);

    await expect(breaker.execute(async () => 'recovered')).resolves.toBe('recovered');
    expect(breaker.currentState).toBe('closed');
  });

  it('reopens and restarts the cooldown when the probe fails', async () => {
    // Otherwise probes hammer a service that is still down.
    const clock = fakeClock();
    const breaker = new CircuitBreaker('dhl', {
      failureThreshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    });

    await expect(breaker.execute(() => Promise.reject(new Error('down')))).rejects.toThrow();
    clock.advance(1000);
    await expect(breaker.execute(() => Promise.reject(new Error('still down')))).rejects.toThrow();

    expect(breaker.currentState).toBe('open');
    clock.advance(500);
    expect(breaker.snapshot().state).toBe('open');
    clock.advance(500);
    expect(breaker.snapshot().state).toBe('half-open');
  });

  it('reports its state for the health endpoint', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker('dhl', {
      failureThreshold: 1,
      cooldownMs: 5000,
      now: clock.now,
    });

    await expect(breaker.execute(() => Promise.reject(new Error('down')))).rejects.toThrow();

    expect(breaker.snapshot()).toEqual({
      carrier: 'dhl',
      state: 'open',
      consecutiveFailures: 1,
      retryAfterMs: 5000,
    });
  });
});

describe('TokenBucket', () => {
  it('allows a burst up to capacity', () => {
    const bucket = new TokenBucket({ tokensPerSecond: 10, burstCapacity: 5 });
    for (let i = 0; i < 5; i++) expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it('refills continuously rather than in windows', () => {
    // A fixed window would allow the whole allowance either side of a
    // boundary — twice the intended rate.
    const clock = fakeClock();
    const bucket = new TokenBucket({
      tokensPerSecond: 10,
      burstCapacity: 10,
      now: clock.now,
    });

    for (let i = 0; i < 10; i++) bucket.consume();
    expect(bucket.available).toBe(0);

    clock.advance(500);
    expect(bucket.available).toBe(5);

    clock.advance(500);
    expect(bucket.available).toBe(10);
  });

  it('never refills beyond capacity', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({
      tokensPerSecond: 10,
      burstCapacity: 10,
      now: clock.now,
    });

    clock.advance(60_000);
    expect(bucket.available).toBe(10);
  });

  it('reports how long until a token is available', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({
      tokensPerSecond: 2,
      burstCapacity: 1,
      now: clock.now,
    });

    bucket.consume();

    try {
      bucket.consume();
      fail('expected the bucket to be empty');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitExceededError);
      expect((error as RateLimitExceededError).retryAfterMs).toBe(500);
    }
  });

  it('holds the average rate over a long run', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({
      tokensPerSecond: 10,
      burstCapacity: 10,
      now: clock.now,
    });

    let allowed = 0;
    // Ten seconds, attempting once every 50ms.
    for (let i = 0; i < 200; i++) {
      if (bucket.tryConsume()) allowed += 1;
      clock.advance(50);
    }

    // 10 burst + 10/s for ~10s, with a little slack for the final tick.
    expect(allowed).toBeGreaterThanOrEqual(100);
    expect(allowed).toBeLessThanOrEqual(112);
  });
});
