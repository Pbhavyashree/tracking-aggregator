import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TrackManyDto } from './dto/track.dto';
import { TrackingService } from './tracking.service';

@ApiTags('tracking')
@Controller('api/v1/tracking')
export class TrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Get(':trackingNumber')
  @ApiOperation({
    summary: 'Track one shipment',
    description:
      'Routes to whichever carrier recognises the number format and returns a normalised result.',
  })
  @ApiResponse({ status: 404, description: 'No carrier recognises this format' })
  @ApiResponse({ status: 429, description: 'Carrier rate limit reached' })
  @ApiResponse({ status: 503, description: 'Carrier circuit is open' })
  track(@Param('trackingNumber') trackingNumber: string) {
    return this.tracking.track(trackingNumber);
  }

  @Post('batch')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Track several shipments',
    description:
      'Failures are isolated per shipment: one bad number does not discard the rest.',
  })
  trackMany(@Body() dto: TrackManyDto) {
    return this.tracking.trackMany(dto.trackingNumbers);
  }

  @Get('carriers/status')
  @ApiOperation({ summary: 'Circuit and rate limit state per carrier' })
  carrierStatus() {
    return this.tracking.carrierStatus();
  }
}
