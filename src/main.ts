import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Maps the resilience errors onto sensible HTTP semantics, so a caller can
  // tell "slow down" from "this is broken" from "that does not exist".
  app.useGlobalFilters(new HttpExceptionFilter());

  const config = new DocumentBuilder()
    .setTitle('Shipment Tracking Aggregator')
    .setDescription(
      'One API across carriers, with the integration patterns that keep it standing when a carrier does not: retries with jitter, circuit breaking, rate limiting, caching, idempotency and signed webhooks.',
    )
    .setVersion('1.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  const port = Number(process.env.PORT ?? 3000);
  // A visitor who opens the bare URL should land somewhere useful, not on a
  // 404 that reads like the service is broken.
  app.getHttpAdapter().get('/', (_req: unknown, res: { redirect: (url: string) => void }) =>
    res.redirect('/docs'),
  );
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`Listening on ${port}, docs at /docs`);
}

void bootstrap();
