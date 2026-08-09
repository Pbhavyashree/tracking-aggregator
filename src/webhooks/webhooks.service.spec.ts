import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { WebhooksService } from './webhooks.service';

async function build() {
  const module = await Test.createTestingModule({
    providers: [
      WebhooksService,
      {
        provide: ConfigService,
        useValue: { get: (_: string, fallback?: string) => fallback },
      },
    ],
  }).compile();

  return module.get(WebhooksService);
}

describe('WebhooksService', () => {
  describe('idempotency', () => {
    it('creates one subscription for a repeated key', async () => {
      const service = await build();

      const first = service.subscribe('DEMO1', 'https://example.com/hook', 'key-1');
      const second = service.subscribe('DEMO1', 'https://example.com/hook', 'key-1');

      expect(second.subscription.id).toBe(first.subscription.id);
      expect(second.replayed).toBe(true);
      expect(service.list()).toHaveLength(1);
    });

    it('creates separate subscriptions for different keys', async () => {
      const service = await build();

      service.subscribe('DEMO1', 'https://example.com/hook', 'key-1');
      service.subscribe('DEMO1', 'https://example.com/hook', 'key-2');

      expect(service.list()).toHaveLength(2);
    });

    it('creates a new subscription each time when no key is supplied', async () => {
      const service = await build();

      service.subscribe('DEMO1', 'https://example.com/hook');
      service.subscribe('DEMO1', 'https://example.com/hook');

      expect(service.list()).toHaveLength(2);
    });
  });

  describe('signing', () => {
    it('accepts a signature it produced', async () => {
      const service = await build();
      const body = JSON.stringify({ event: 'shipment.status_changed' });
      const timestamp = Date.now();
      const signature = service.sign(body, 'secret', timestamp);

      expect(service.verify(body, 'secret', timestamp, signature)).toBe(true);
    });

    it('rejects a tampered body', async () => {
      const service = await build();
      const timestamp = Date.now();
      const signature = service.sign('{"status":"delivered"}', 'secret', timestamp);

      expect(
        service.verify('{"status":"exception"}', 'secret', timestamp, signature),
      ).toBe(false);
    });

    it('rejects a signature made with a different secret', async () => {
      const service = await build();
      const body = '{"a":1}';
      const timestamp = Date.now();
      const signature = service.sign(body, 'their-secret', timestamp);

      expect(service.verify(body, 'our-secret', timestamp, signature)).toBe(false);
    });

    it('rejects a replayed delivery outside the tolerance window', async () => {
      // Without a timestamp in the signed material, a captured delivery
      // verifies forever and can be replayed indefinitely.
      const service = await build();
      const body = '{"a":1}';
      const old = Date.now() - 10 * 60 * 1000;
      const signature = service.sign(body, 'secret', old);

      expect(service.verify(body, 'secret', old, signature)).toBe(false);
    });

    it('accepts a delivery inside the tolerance window', async () => {
      const service = await build();
      const body = '{"a":1}';
      const recent = Date.now() - 30_000;
      const signature = service.sign(body, 'secret', recent);

      expect(service.verify(body, 'secret', recent, signature)).toBe(true);
    });

    it('rejects a signature of the wrong length without throwing', async () => {
      // timingSafeEqual throws on length mismatch, so the guard matters.
      const service = await build();
      const timestamp = Date.now();

      expect(service.verify('{}', 'secret', timestamp, 'abcd')).toBe(false);
    });

    it('produces a different signature when the timestamp changes', async () => {
      const service = await build();
      const body = '{"a":1}';

      expect(service.sign(body, 'secret', 1000)).not.toBe(
        service.sign(body, 'secret', 2000),
      );
    });
  });

  describe('subscriptions', () => {
    it('issues a secret on creation', async () => {
      const service = await build();
      const { subscription } = service.subscribe('DEMO1', 'https://example.com/hook');

      expect(subscription.secret).toHaveLength(32);
    });

    it('finds subscriptions for a tracking number', async () => {
      const service = await build();
      service.subscribe('DEMO1', 'https://a.example.com/hook');
      service.subscribe('DEMO1', 'https://b.example.com/hook');
      service.subscribe('DEMO2', 'https://c.example.com/hook');

      expect(service.forTrackingNumber('DEMO1')).toHaveLength(2);
    });

    it('removes a subscription', async () => {
      const service = await build();
      const { subscription } = service.subscribe('DEMO1', 'https://example.com/hook');

      expect(service.unsubscribe(subscription.id)).toBe(true);
      expect(service.list()).toHaveLength(0);
    });
  });
});
