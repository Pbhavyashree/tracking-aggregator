import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  Carrier,
  Shipment,
  ShipmentStatus,
  TrackingEvent,
} from './carrier.interface';
import { PermanentError, RetryableError } from '../resilience/retry';

/**
 * Adapter for DHL's Shipment Tracking API.
 *
 * Needs DHL_API_KEY. Without one the adapter reports itself as unable to match
 * anything, so the service falls back to the demo carrier rather than failing
 * — the deployed instance stays useful to someone who has no key.
 *
 * The interesting work here is not the fetch. It is deciding what each failure
 * *means*, because the retry layer above can only act sensibly if this layer
 * classifies honestly:
 *
 *   401/403 → permanent. A bad key will still be bad in 200ms.
 *   404     → permanent. The tracking number does not exist.
 *   429     → retryable, with the carrier's own Retry-After honoured.
 *   5xx     → retryable. Their problem, probably temporary.
 *   network → retryable. Ours or the internet's, also probably temporary.
 *
 * Getting this wrong in either direction is expensive: treating 404 as
 * retryable burns quota on a question already answered, and treating 503 as
 * permanent turns a blip into a user-visible failure.
 */
@Injectable()
export class DhlCarrier implements Carrier {
  readonly name = 'dhl';
  private readonly logger = new Logger(DhlCarrier.name);
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('DHL_API_KEY');
    this.baseUrl = config.get<string>(
      'DHL_BASE_URL',
      'https://api-eu.dhl.com/track/shipments',
    );
    this.timeoutMs = Number(config.get<string>('CARRIER_TIMEOUT_MS', '5000'));
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  matches(trackingNumber: string): boolean {
    if (!this.configured) return false;
    // DHL numbers are 10-20 digits, or JJD-prefixed for parcel Germany.
    return /^(JJD)?\d{10,20}$/i.test(trackingNumber);
  }

  async track(trackingNumber: string): Promise<Shipment> {
    const url = `${this.baseUrl}?trackingNumber=${encodeURIComponent(trackingNumber)}`;
    const response = await this.fetchWithTimeout(url);

    if (!response.ok) {
      throw this.classify(response);
    }

    const body = (await response.json()) as DhlResponse;
    const shipment = body.shipments?.[0];

    if (!shipment) {
      throw new PermanentError(`No shipment found for ${trackingNumber}`, 404);
    }

    return this.normalise(trackingNumber, shipment);
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    // Without a timeout a hung carrier connection holds our request open
    // indefinitely, and the caller's timeout fires instead of ours — meaning
    // we never get to retry or record the failure.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(url, {
        headers: { 'DHL-API-Key': this.apiKey!, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new RetryableError(`DHL did not respond within ${this.timeoutMs}ms`);
      }
      throw new RetryableError(`Could not reach DHL: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private classify(response: Response): Error {
    const { status } = response;

    if (status === 404) {
      return new PermanentError('Tracking number not found', 404);
    }

    if (status === 401 || status === 403) {
      this.logger.error(`DHL rejected our credentials with ${status}`);
      return new PermanentError('DHL rejected the API key', status);
    }

    if (status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      return new RetryableError(
        'DHL rate limit reached',
        retryAfter ? Number(retryAfter) * 1000 : undefined,
      );
    }

    if (status >= 500) {
      return new RetryableError(`DHL returned ${status}`);
    }

    return new PermanentError(`DHL returned ${status}`, status);
  }

  /** Maps DHL's vocabulary onto ours. */
  private normalise(trackingNumber: string, shipment: DhlShipment): Shipment {
    const events: TrackingEvent[] = (shipment.events ?? []).map((event) => ({
      status: this.mapStatus(event.statusCode),
      description: event.description ?? event.status ?? 'Status update',
      location: event.location?.address?.addressLocality,
      timestamp: event.timestamp,
      carrierStatusCode: event.statusCode,
    }));

    return {
      trackingNumber,
      carrier: this.name,
      status: this.mapStatus(shipment.status?.statusCode),
      estimatedDelivery: shipment.estimatedTimeOfDelivery,
      events,
      retrievedAt: new Date().toISOString(),
    };
  }

  private mapStatus(code?: string): ShipmentStatus {
    switch (code?.toLowerCase()) {
      case 'pre-transit':
      case 'pretransit':
        return 'pre_transit';
      case 'transit':
        return 'in_transit';
      case 'out-for-delivery':
        return 'out_for_delivery';
      case 'delivered':
        return 'delivered';
      case 'failure':
      case 'exception':
        return 'exception';
      default:
        // An unmapped code is not an error — carriers add codes without
        // telling anyone. Reporting "unknown" keeps the response valid while
        // carrierStatusCode preserves what they actually said.
        return 'unknown';
    }
  }
}

interface DhlResponse {
  shipments?: DhlShipment[];
}

interface DhlShipment {
  status?: { statusCode?: string };
  estimatedTimeOfDelivery?: string;
  events?: Array<{
    timestamp: string;
    statusCode?: string;
    status?: string;
    description?: string;
    location?: { address?: { addressLocality?: string } };
  }>;
}
