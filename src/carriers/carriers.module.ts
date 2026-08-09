import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CARRIERS } from './carrier.interface';
import { DemoCarrier } from './demo.carrier';
import { DhlCarrier } from './dhl.carrier';

/**
 * Registers the carrier adapters.
 *
 * Order matters: DHL is tried first so a real tracking number reaches the real
 * carrier, and the demo adapter only claims DEMO-prefixed numbers. Adding a
 * carrier means adding one file and one entry here — nothing downstream
 * changes, which is the payoff for normalising at the adapter.
 */
@Module({
  providers: [
    DhlCarrier,
    DemoCarrier,
    {
      provide: CARRIERS,
      inject: [DhlCarrier, DemoCarrier],
      useFactory: (dhl: DhlCarrier, demo: DemoCarrier) => [dhl, demo],
    },
  ],
  exports: [CARRIERS, DhlCarrier],
})
export class CarriersModule {}
