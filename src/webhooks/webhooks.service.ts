import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { withRetry, RetryableError } from '../resilience/retry';
import type { Shipment } from '../carriers/carrier.interface';

export interface Subscription {
  id: string;
  trackingNumber: string;
  url: string;
  secret: string;
  createdAt: string;
  lastStatus?: string;
}

/**
 * Webhook delivery.
 *
 * Polling a tracking API on a schedule for every shipment a customer cares
 * about is how you exhaust a carrier quota. Webhooks invert it: the consumer
 * registers once and hears about changes.
 *
 * Three details make webhooks trustworthy rather than merely functional:
 *
 * Signing. The receiver has an open endpoint on the internet and no way to
 * know a POST came from us rather than anyone who guessed the URL. An HMAC
 * over the exact body, with a shared secret, gives them a way to check.
 *
 * Timestamps in the signed payload. Without one, an attacker who captures a
 * valid delivery can replay it forever and the signature still verifies. The
 * timestamp is signed alongside the body so a stale replay is detectable.
 *
 * Delivery retries. Receivers go down. A single attempt means a missed status
 * change with no record; retrying with backoff turns most receiver blips into
 * a delayed delivery instead of a lost one.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly subscriptions = new Map<string, Subscription>();
  /** Maps an idempotency key to the subscription it created. */
  private readonly idempotency = new Map<string, string>();
  private readonly deliveryTimeoutMs: number;

  constructor(config: ConfigService) {
    this.deliveryTimeoutMs = Number(
      config.get<string>('WEBHOOK_TIMEOUT_MS', '5000'),
    );
  }

  /**
   * Registers a subscription.
   *
   * Idempotency keys exist because a client that times out on this call has no
   * way to know whether it succeeded. Without a key, their natural retry
   * creates a second subscription and the receiver gets every event twice.
   * With one, the retry returns the original.
   */
  subscribe(
    trackingNumber: string,
    url: string,
    idempotencyKey?: string,
  ): { subscription: Subscription; replayed: boolean } {
    if (idempotencyKey) {
      const existingId = this.idempotency.get(idempotencyKey);
      if (existingId) {
        const existing = this.subscriptions.get(existingId);
        if (existing) return { subscription: existing, replayed: true };
      }
    }

    const subscription: Subscription = {
      id: randomUUID(),
      trackingNumber,
      url,
      // Returned once on creation and never again, so the receiver can verify
      // signatures without us storing anything they could not reproduce.
      secret: randomUUID().replace(/-/g, ''),
      createdAt: new Date().toISOString(),
    };

    this.subscriptions.set(subscription.id, subscription);
    if (idempotencyKey) this.idempotency.set(idempotencyKey, subscription.id);

    return { subscription, replayed: false };
  }

  unsubscribe(id: string): boolean {
    return this.subscriptions.delete(id);
  }

  list(): Subscription[] {
    return [...this.subscriptions.values()];
  }

  forTrackingNumber(trackingNumber: string): Subscription[] {
    return this.list().filter((s) => s.trackingNumber === trackingNumber);
  }

  /**
   * Signs a payload.
   *
   * The timestamp is part of the signed string, not just a header, so it
   * cannot be altered independently of the signature.
   */
  sign(body: string, secret: string, timestamp: number): string {
    return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  }

  /**
   * Verifies a signature, as a receiver would.
   *
   * Included in the service because it is the half most people get wrong, and
   * the README points receivers at it. Two details matter: the comparison is
   * constant-time, because a fast-failing string compare leaks the correct
   * signature a byte at a time; and old timestamps are rejected, because a
   * signature valid forever is a replay waiting to happen.
   */
  verify(
    body: string,
    secret: string,
    timestamp: number,
    signature: string,
    toleranceMs = 300_000,
  ): boolean {
    if (Math.abs(Date.now() - timestamp) > toleranceMs) return false;

    const expected = this.sign(body, secret, timestamp);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');

    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Notifies every subscriber for a shipment whose status has changed. */
  async notifyStatusChange(shipment: Shipment): Promise<void> {
    const subscribers = this.forTrackingNumber(shipment.trackingNumber);

    await Promise.allSettled(
      subscribers
        .filter((s) => s.lastStatus !== shipment.status)
        .map(async (subscription) => {
          await this.deliver(subscription, shipment);
          subscription.lastStatus = shipment.status;
        }),
    );
  }

  private async deliver(subscription: Subscription, shipment: Shipment): Promise<void> {
    const body = JSON.stringify({
      subscriptionId: subscription.id,
      event: 'shipment.status_changed',
      shipment,
    });
    const timestamp = Date.now();
    const signature = this.sign(body, subscription.secret, timestamp);

    try {
      await withRetry(
        async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.deliveryTimeoutMs);

          try {
            const response = await fetch(subscription.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Webhook-Timestamp': String(timestamp),
                'X-Webhook-Signature': signature,
              },
              body,
              signal: controller.signal,
            });

            // A 4xx from the receiver means they rejected the payload; sending
            // it again unchanged will be rejected again.
            if (response.status >= 400 && response.status < 500) {
              this.logger.warn(
                `Receiver ${subscription.url} rejected delivery with ${response.status}`,
              );
              return;
            }

            if (!response.ok) {
              throw new RetryableError(`Receiver returned ${response.status}`);
            }
          } finally {
            clearTimeout(timer);
          }
        },
        { maxAttempts: 3, baseDelayMs: 500 },
      );
    } catch (error) {
      this.logger.error(
        `Gave up delivering to ${subscription.url}: ${(error as Error).message}`,
      );
    }
  }
}
