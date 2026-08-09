/**
 * The shape every carrier adapter conforms to.
 *
 * The point of this service is that a caller should not need to know whether a
 * parcel is with DHL, DPD or Hermes. Each carrier returns a different shape,
 * uses different status vocabulary, and disagrees about what a timestamp looks
 * like. Normalising at the adapter boundary keeps that mess in one file per
 * carrier instead of leaking into every consumer.
 */

/**
 * Normalised status vocabulary.
 *
 * Deliberately small. Carriers expose dozens of granular codes ("arrived at
 * sort facility", "processed at export hub") that differ per carrier and per
 * country. Callers almost always want one of these six things, and a union
 * that maps cleanly across carriers is worth more than one preserving every
 * nuance of each.
 */
export type ShipmentStatus =
  | 'pre_transit'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception'
  | 'unknown';

export interface TrackingEvent {
  status: ShipmentStatus;
  description: string;
  location?: string;
  timestamp: string;
  /** The carrier's own code, kept so nothing is lost in normalisation. */
  carrierStatusCode?: string;
}

export interface Shipment {
  trackingNumber: string;
  carrier: string;
  status: ShipmentStatus;
  estimatedDelivery?: string;
  events: TrackingEvent[];
  /** When this was fetched, so callers can judge staleness. */
  retrievedAt: string;
}

export interface Carrier {
  readonly name: string;

  /**
   * Whether this adapter recognises the tracking number format.
   *
   * Lets the service route without asking the caller which carrier to use, and
   * without trying every carrier in turn — which would burn quota on carriers
   * that were never going to match.
   */
  matches(trackingNumber: string): boolean;

  track(trackingNumber: string): Promise<Shipment>;
}

export const CARRIERS = Symbol('CARRIERS');
