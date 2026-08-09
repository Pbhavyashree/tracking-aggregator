import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, IsUrl, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { WebhooksService } from './webhooks.service';

export class SubscribeDto {
  @ApiProperty({ example: 'DEMO12345' })
  @IsString()
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9-]+$/)
  trackingNumber: string;

  @ApiProperty({ example: 'https://example.com/hooks/shipments' })
  // require_protocol matters: without it "not-a-url" validates as a bare
  // hostname and we would happily POST deliveries into the void.
  // require_tld stays off so a developer can point at localhost.
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  url: string;
}

@ApiTags('webhooks')
@Controller('api/v1/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Subscribe to status changes',
    description:
      'Returns a secret used to verify delivery signatures. It is shown once and not retrievable later.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Retrying a timed-out request with the same key returns the original subscription instead of creating a second one.',
  })
  subscribe(
    @Body() dto: SubscribeDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const { subscription, replayed } = this.webhooks.subscribe(
      dto.trackingNumber,
      dto.url,
      idempotencyKey,
    );
    return { ...subscription, replayed };
  }

  @Get()
  @ApiOperation({ summary: 'List subscriptions' })
  list() {
    // Secrets are never returned after creation.
    return this.webhooks.list().map(({ secret, ...rest }) => rest);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancel a subscription' })
  unsubscribe(@Param('id') id: string) {
    this.webhooks.unsubscribe(id);
  }
}
