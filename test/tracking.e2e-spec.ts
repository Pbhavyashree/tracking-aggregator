import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';

describe('Tracking API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('tracks a demo shipment', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/tracking/DEMO12345')
      .expect(200);

    expect(response.body.carrier).toBe('demo');
    expect(response.body.trackingNumber).toBe('DEMO12345');
    expect(Array.isArray(response.body.events)).toBe(true);
  });

  it('returns the same result on repeat, served from cache', async () => {
    const first = await request(app.getHttpServer()).get('/api/v1/tracking/DEMO55555');
    const second = await request(app.getHttpServer()).get('/api/v1/tracking/DEMO55555');

    expect(second.body.retrievedAt).toBe(first.body.retrievedAt);
  });

  it('returns 404 for a format no carrier recognises', async () => {
    await request(app.getHttpServer()).get('/api/v1/tracking/nope').expect(404);
  });

  it('maps an unknown shipment to the carrier status code', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/tracking/DEMO11NOTFOUND')
      .expect(404);
  });

  it('recovers from a flaky carrier without the caller noticing', async () => {
    // DEMO...FLAKY fails twice then succeeds; the retry layer absorbs it.
    await request(app.getHttpServer()).get('/api/v1/tracking/DEMO88FLAKY').expect(200);
  });

  it('tracks a batch and isolates failures', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/tracking/batch')
      .send({ trackingNumbers: ['DEMO111', 'DEMO222NOTFOUND', 'DEMO333'] })
      .expect(200);

    expect(response.body).toHaveLength(3);
    expect(response.body[0].shipment).toBeDefined();
    expect(response.body[1].error).toBeDefined();
    expect(response.body[2].shipment).toBeDefined();
  });

  it('rejects a batch larger than the cap', async () => {
    const trackingNumbers = Array.from({ length: 30 }, (_, i) => `DEMO${i}`);
    await request(app.getHttpServer())
      .post('/api/v1/tracking/batch')
      .send({ trackingNumbers })
      .expect(400);
  });

  it('rejects unknown properties', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/tracking/batch')
      .send({ trackingNumbers: ['DEMO1'], sneaky: true })
      .expect(400);
  });

  it('reports carrier circuit state', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/tracking/carriers/status')
      .expect(200);

    expect(response.body.some((c: { carrier: string }) => c.carrier === 'demo')).toBe(true);
  });

  it('answers liveness without touching a carrier', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    expect(response.body.status).toBe('ok');
  });

  it('reports readiness with carrier detail', async () => {
    const response = await request(app.getHttpServer()).get('/ready').expect(200);
    expect(response.body.carriers).toBeDefined();
  });
});

describe('Webhooks API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a subscription and returns a secret', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/webhooks')
      .send({ trackingNumber: 'DEMO12345', url: 'https://example.com/hook' })
      .expect(201);

    expect(response.body.secret).toBeDefined();
    expect(response.body.replayed).toBe(false);
  });

  it('returns the original subscription for a repeated idempotency key', async () => {
    const payload = { trackingNumber: 'DEMO999', url: 'https://example.com/hook' };

    const first = await request(app.getHttpServer())
      .post('/api/v1/webhooks')
      .set('Idempotency-Key', 'abc-123')
      .send(payload)
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/api/v1/webhooks')
      .set('Idempotency-Key', 'abc-123')
      .send(payload)
      .expect(201);

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.replayed).toBe(true);
  });

  it('never returns secrets when listing', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/webhooks')
      .send({ trackingNumber: 'DEMO777', url: 'https://example.com/hook' });

    const response = await request(app.getHttpServer()).get('/api/v1/webhooks').expect(200);

    for (const subscription of response.body) {
      expect(subscription.secret).toBeUndefined();
    }
  });

  it('rejects a malformed callback URL', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/webhooks')
      .send({ trackingNumber: 'DEMO1', url: 'not-a-url' })
      .expect(400);
  });
});
