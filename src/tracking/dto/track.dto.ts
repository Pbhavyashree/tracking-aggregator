import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, Matches, MaxLength } from 'class-validator';

export class TrackManyDto {
  @ApiProperty({
    example: ['DEMO12345', 'DEMO67890'],
    description: 'Tracking numbers to resolve in one request',
  })
  @IsArray()
  @ArrayMinSize(1)
  // Capped so one caller cannot fan out into hundreds of carrier calls with a
  // single request.
  @ArrayMaxSize(25)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @Matches(/^[A-Za-z0-9-]+$/, {
    each: true,
    message: 'tracking numbers must be alphanumeric',
  })
  trackingNumbers: string[];
}
