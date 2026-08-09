import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CarriersModule } from './carriers/carriers.module';
import { HealthModule } from './health/health.module';
import { TrackingModule } from './tracking/tracking.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CarriersModule,
    TrackingModule,
    WebhooksModule,
    HealthModule,
  ],
})
export class AppModule {}
