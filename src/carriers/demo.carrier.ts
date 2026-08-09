import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import type {
  Carrier,
  Shipment,
  ShipmentStatus,
  TrackingEvent,
} from './carrier.interface';
import { PermanentError, RetryableError } from '../resilience/retry';

/**
 * A deterministic fake carrier.
 *
 * This exists so the deployed demo works for anyone who opens it, without
 * needing a DHL API key. A public demo nobody can run is not a demo.
 *
 * Deterministic rather than random: the same tracking number always returns
 * the same journey, so a link in a README still shows what it showed when it
 * was written. The status derives from a hash of the number.
 *
 * Specific suffixes force particular outcomes, which makes the failure paths
 * demonstrable without waiting for a real carrier to break:
 *   DEMO...NOTFOUND  → 404, and the retry logic correctly does not retry it
 *   DEMO...FLAKY     → fails twice then succeeds, exercising backoff
 *   DEMO...DOWN      → always fails, which trips the circuit breaker
 */
@Injectable()
export class DemoCarrier implements Carrier {
  readonly name = 'demo';

  /** Per-number attempt counter, so FLAKY can recover on the third try. */
  private readonly attempts = new Map<string, number>();

  matches(trackingNumber: string): boolean {
    return /^DEMO[A-Z0-9]{3,}$/i.test(trackingNumber);
  }

  async track(trackingNumber: string): Promise<Shipment> {
    const upper = trackingNumber.toUpperCase();

    if (upper.endsWith('NOTFOUND')) {
      throw new PermanentError(`No shipment found for ${trackingNumber}`, 404);
    }

    if (upper.endsWith('DOWN')) {
      throw new RetryableError('Carrier is unavailable');
    }

    if (upper.endsWith('FLAKY')) {
      const seen = (this.attempts.get(upper) ?? 0) + 1;
      this.attempts.set(upper, seen);
      if (seen < 3) {
        throw new RetryableError(`Carrier returned 503 (attempt ${seen})`);
      }
      this.attempts.delete(upper);
    }

    const status = this.statusFor(upper);
    return {
      trackingNumber,
      carrier: this.name,
      status,
      estimatedDelivery: this.estimatedDelivery(upper, status),
      events: this.eventsFor(upper, status),
      retrievedAt: new Date().toISOString(),
    };
  }

  private hash(trackingNumber: string): number {
    return createHash('sha256').update(trackingNumber).digest().readUInt32BE(0);
  }

  private statusFor(trackingNumber: string): ShipmentStatus {
    const journey: ShipmentStatus[] = [
      'pre_transit',
      'in_transit',
      'in_transit',
      'out_for_delivery',
      'delivered',
      'delivered',
      'exception',
    ];
    return journey[this.hash(trackingNumber) % journey.length];
  }

  private estimatedDelivery(
    trackingNumber: string,
    status: ShipmentStatus,
  ): string | undefined {
    if (status === 'delivered') return undefined;
    const daysOut = (this.hash(trackingNumber) % 4) + 1;
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + daysOut);
    return date.toISOString().slice(0, 10);
  }

  /** Builds the trail of events leading up to the current status. */
  private eventsFor(trackingNumber: string, status: ShipmentStatus): TrackingEvent[] {
    const cities = ['Berlin', 'Hannover', 'Koeln', 'Frankfurt', 'Muenchen'];
    const city = cities[this.hash(trackingNumber) % cities.length];

    if (status === 'exception') {
      return [
        this.event('pre_transit', 'Shipment information received', city, 3),
        this.event('in_transit', 'Processed at sorting centre', city, 2),
        this.event('exception', 'Delivery attempted, recipient not available', city, 0),
      ];
    }

    const trail: Array<[ShipmentStatus, string]> = [
      ['pre_transit', 'Shipment information received'],
      ['in_transit', 'Processed at sorting centre'],
      ['out_for_delivery', 'Out for delivery'],
      ['delivered', 'Delivered to recipient'],
    ];

    const upTo = trail.findIndex(([s]) => s === status);
    const included = trail.slice(0, upTo + 1);

    return included.map(([s, description], index) =>
      this.event(s, description, city, included.length - index - 1),
    );
  }

  private event(
    status: ShipmentStatus,
    description: string,
    location: string,
    daysAgo: number,
  ): TrackingEvent {
    const timestamp = new Date();
    timestamp.setUTCDate(timestamp.getUTCDate() - daysAgo);
    return {
      status,
      description,
      location,
      timestamp: timestamp.toISOString(),
      carrierStatusCode: status.toUpperCase(),
    };
  }
}
