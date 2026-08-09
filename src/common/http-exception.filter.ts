import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { CircuitOpenError } from '../resilience/circuit-breaker';
import { RateLimitExceededError } from '../resilience/rate-limiter';
import { PermanentError, RetryableError } from '../resilience/retry';
/**
 * Translates internal failures into HTTP the caller can act on.
 *
 * The distinction matters: 429 with Retry-After tells a client to back off and
 * when to return; 503 tells them the carrier is down and this is not their
 * fault. Collapsing both into 500 tells them nothing and invites a retry storm.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof RateLimitExceededError) {
      response
        .status(HttpStatus.TOO_MANY_REQUESTS)
        .header('Retry-After', String(Math.ceil(exception.retryAfterMs / 1000)))
        .json({ statusCode: 429, message: exception.message });
      return;
    }

    if (exception instanceof CircuitOpenError) {
      response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .header('Retry-After', String(Math.ceil(exception.retryAfterMs / 1000)))
        .json({ statusCode: 503, message: exception.message });
      return;
    }

    if (exception instanceof PermanentError) {
      const status = exception.status ?? HttpStatus.BAD_GATEWAY;
      response.status(status).json({ statusCode: status, message: exception.message });
      return;
    }

   // Retries exhausted: the carrier is genuinely unavailable. 502 says the
    // upstream failed; 500 would wrongly claim the fault is ours.
    if (exception instanceof RetryableError) {
      response
        .status(HttpStatus.BAD_GATEWAY)
        .json({ statusCode: 502, message: `Carrier unavailable: ${exception.message}` });
      return;
    }
    
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json(exception.getResponse());
      return;
    }

    this.logger.error('Unhandled error', exception as Error);
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ statusCode: 500, message: 'Internal server error' });
  }
}
