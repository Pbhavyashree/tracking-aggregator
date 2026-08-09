import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TrackingService } from '../tracking/tracking.service';

@ApiTags('operations')
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(private readonly tracking: TrackingService) {}

  @Get('health')
  @ApiOperation({
    summary: 'Liveness',
    description:
      'Deliberately checks no carrier. A carrier outage must not make the platform restart every healthy instance.',
  })
  health() {
    return {
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness, including per-carrier circuit state' })
  ready() {
    const carriers = this.tracking.carrierStatus();
    // Degraded rather than unhealthy: one carrier being down still leaves the
    // service useful for every other carrier, so it should keep taking traffic.
    const allOpen = carriers.length > 0 && carriers.every((c) => c.state === 'open');

    return {
      status: allOpen ? 'degraded' : 'ready',
      carriers,
    };
  }
}
