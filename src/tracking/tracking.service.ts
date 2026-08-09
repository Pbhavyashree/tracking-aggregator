import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CARRIERS, type Carrier, type Shipment } from '../carriers/carrier.interface';
import { CircuitBreaker, CircuitOpenError } from '../resilience/circuit-breaker';
import { RateLimitExceededError, TokenBucket } from '../resilience/rate-limiter';
import { PermanentError, withRetry } from '../resilience/retry';

interface CacheEntry {
  shipment: Shipment;
  expiresAt: number;
}

/**
 * Resolves a tracking number to a normalised shipment.
 *
 * The order the protections are applied in is deliberate and is most of the
 * design:
 *
 *   1. cache        — a cached answer costs nothing, so check before anything
 *                     that consumes quota or time.
 *   2. rate limiter — refuse locally before spending a carrier call. Being
 *                     told off by someone else's 429 is a worse way to learn
 *                     your own limits.
 *   3. circuit      — if the carrier is known to be down, fail immediately
 *                     rather than starting a retry sequence that will only
 *                     end in the same failure three backoffs later.
 *   4. retry        — innermost, so a transient blip is absorbed without the
 *                     caller seeing it.
 *
 * Putting retry outside the circuit breaker would be the common mistake: each
 * retry would be counted as a separate failure, tripping the breaker three
 * times faster than intended and turning one bad request into an outage for
 * everyone.
 */
@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly cacheTtlMs: number;

  constructor(
    @Inject(CARRIERS) private readonly carriers: Carrier[],
    config: ConfigService,
  ) {
    // Tracking data changes on the order of hours, not seconds. A short TTL
    // still absorbs the common case of a user refreshing a page repeatedly.
    this.cacheTtlMs = Number(config.get<string>('CACHE_TTL_MS', '60000'));

    const perSecond = Number(config.get<string>('CARRIER_RATE_LIMIT_PER_SECOND', '5'));
    for (const carrier of carriers) {
      this.breakers.set(
        carrier.name,
        new CircuitBreaker(carrier.name, { failureThreshold: 5, cooldownMs: 30_000 }),
      );
      this.buckets.set(
        carrier.name,
        new TokenBucket({ tokensPerSecond: perSecond, burstCapacity: perSecond * 2 }),
      );
    }
  }

  async track(trackingNumber: string): Promise<Shipment> {
    const carrier = this.carrierFor(trackingNumber);

    const cached = this.fromCache(trackingNumber);
    if (cached) return cached;

    this.buckets.get(carrier.name)!.consume();

    const breaker = this.breakers.get(carrier.name)!;
    const shipment = await breaker.execute(() =>
      withRetry(() => carrier.track(trackingNumber), {
        maxAttempts: 3,
        baseDelayMs: 200,
      }),
    );

    this.cache.set(trackingNumber, {
      shipment,
      expiresAt: Date.now() + this.cacheTtlMs,
    });

    return shipment;
  }

  /** Resolves several numbers at once, isolating failures per shipment. */
  async trackMany(
    trackingNumbers: string[],
  ): Promise<Array<{ trackingNumber: string; shipment?: Shipment; error?: string }>> {
    // allSettled rather than all: one unknown tracking number in a batch of
    // twenty should not discard the nineteen that resolved.
    const results = await Promise.allSettled(
      trackingNumbers.map((number) => this.track(number)),
    );

    return results.map((result, index) => {
      const trackingNumber = trackingNumbers[index];
      if (result.status === 'fulfilled') {
        return { trackingNumber, shipment: result.value };
      }
      return { trackingNumber, error: this.describe(result.reason) };
    });
  }

  private carrierFor(trackingNumber: string): Carrier {
    const carrier = this.carriers.find((c) => c.matches(trackingNumber));
    if (!carrier) {
      throw new NotFoundException(
        `No carrier recognises the format of "${trackingNumber}"`,
      );
    }
    return carrier;
  }

  private fromCache(trackingNumber: string): Shipment | null {
    const entry = this.cache.get(trackingNumber);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(trackingNumber);
      return null;
    }

    return entry.shipment;
  }

  private describe(error: unknown): string {
    if (error instanceof CircuitOpenError) return error.message;
    if (error instanceof RateLimitExceededError) return error.message;
    if (error instanceof PermanentError) return error.message;
    if (error instanceof Error) return error.message;
    return 'Unknown error';
  }

  /** Carrier health, surfaced so operators can see which are degraded. */
  carrierStatus() {
    return this.carriers.map((carrier) => ({
      ...this.breakers.get(carrier.name)!.snapshot(),
      tokensAvailable: this.buckets.get(carrier.name)!.available,
    }));
  }
}
