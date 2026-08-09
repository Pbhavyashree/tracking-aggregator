import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { CARRIERS, type Carrier, type Shipment } from '../carriers/carrier.interface';
import { DemoCarrier } from '../carriers/demo.carrier';
import { Test } from '@nestjs/testing';
import { TrackingService } from './tracking.service';
import { CircuitOpenError } from '../resilience/circuit-breaker';
import { RateLimitExceededError } from '../resilience/rate-limiter';
import { PermanentError, RetryableError } from '../resilience/retry';

function shipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    trackingNumber: 'DEMO123',
    carrier: 'stub',
    status: 'in_transit',
    events: [],
    retrievedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A carrier whose behaviour each test controls. */
class StubCarrier implements Carrier {
  readonly name = 'stub';
  track = jest.fn<Promise<Shipment>, [string]>();
  matches(trackingNumber: string): boolean {
    return trackingNumber.startsWith('STUB');
  }
}

async function build(carriers: Carrier[], config: Record<string, string> = {}) {
  const module = await Test.createTestingModule({
    providers: [
      TrackingService,
      { provide: CARRIERS, useValue: carriers },
      {
        provide: ConfigService,
        useValue: {
          get: (key: string, fallback?: string) => config[key] ?? fallback,
        },
      },
    ],
  }).compile();

  return module.get(TrackingService);
}

describe('TrackingService', () => {
  describe('routing', () => {
    it('picks the carrier that recognises the number format', async () => {
      const stub = new StubCarrier();
      stub.track.mockResolvedValue(shipment());
      const service = await build([stub, new DemoCarrier()]);

      await service.track('STUB123');

      expect(stub.track).toHaveBeenCalledWith('STUB123');
    });

    it('rejects a format no carrier recognises', async () => {
      const service = await build([new StubCarrier()]);

      await expect(service.track('unknown-format')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('does not call carriers that cannot match, saving their quota', async () => {
      const stub = new StubCarrier();
      const demo = new DemoCarrier();
      const demoTrack = jest.spyOn(demo, 'track');
      stub.track.mockResolvedValue(shipment());

      const service = await build([stub, demo]);
      await service.track('STUB123');

      expect(demoTrack).not.toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('serves a repeat lookup from cache', async () => {
      const stub = new StubCarrier();
      stub.track.mockResolvedValue(shipment());
      const service = await build([stub]);

      await service.track('STUB123');
      await service.track('STUB123');
      await service.track('STUB123');

      expect(stub.track).toHaveBeenCalledTimes(1);
    });

    it('does not share cache entries between tracking numbers', async () => {
      const stub = new StubCarrier();
      stub.track.mockResolvedValue(shipment());
      const service = await build([stub]);

      await service.track('STUB111');
      await service.track('STUB222');

      expect(stub.track).toHaveBeenCalledTimes(2);
    });

    it('refetches once the entry expires', async () => {
      const stub = new StubCarrier();
      stub.track.mockResolvedValue(shipment());
      const service = await build([stub], { CACHE_TTL_MS: '0' });

      await service.track('STUB123');
      await service.track('STUB123');

      expect(stub.track).toHaveBeenCalledTimes(2);
    });
  });

  describe('retries', () => {
    it('absorbs a transient carrier failure without the caller seeing it', async () => {
      const stub = new StubCarrier();
      stub.track
        .mockRejectedValueOnce(new RetryableError('503'))
        .mockResolvedValue(shipment());

      const service = await build([stub]);

      await expect(service.track('STUB123')).resolves.toMatchObject({
        status: 'in_transit',
      });
      expect(stub.track).toHaveBeenCalledTimes(2);
    });

    it('does not retry an unknown tracking number', async () => {
      const stub = new StubCarrier();
      stub.track.mockRejectedValue(new PermanentError('not found', 404));
      const service = await build([stub]);

      await expect(service.track('STUB123')).rejects.toBeInstanceOf(PermanentError);
      expect(stub.track).toHaveBeenCalledTimes(1);
    });
  });

  describe('circuit breaking', () => {
    it('stops calling a carrier that keeps failing', async () => {
      const stub = new StubCarrier();
      stub.track.mockRejectedValue(new RetryableError('down'));
      const service = await build([stub]);

      // Five failures trips the breaker. Each request retries three times, so
      // the breaker counts the *request*, not each attempt — which is why
      // retry sits inside the breaker rather than outside it.
      for (let i = 0; i < 5; i++) {
        await expect(service.track(`STUB-${i}`)).rejects.toThrow();
      }

      const callsBefore = stub.track.mock.calls.length;
      await expect(service.track('STUB-next')).rejects.toBeInstanceOf(CircuitOpenError);
      expect(stub.track.mock.calls.length).toBe(callsBefore);
    });

    it('counts one failed request once, not once per retry', async () => {
      const stub = new StubCarrier();
      stub.track.mockRejectedValue(new RetryableError('down'));
      const service = await build([stub]);

      await expect(service.track('STUB-1')).rejects.toThrow();

      // Three attempts made, but only one failure recorded against the circuit.
      expect(stub.track).toHaveBeenCalledTimes(3);
      expect(service.carrierStatus()[0].consecutiveFailures).toBe(1);
    });
  });

  describe('rate limiting', () => {
    it('refuses locally rather than spending a carrier call', async () => {
      const stub = new StubCarrier();
      stub.track.mockResolvedValue(shipment());
      const service = await build([stub], { CARRIER_RATE_LIMIT_PER_SECOND: '1' });

      // Burst capacity is twice the rate, so the first two pass.
      await service.track('STUB-1');
      await service.track('STUB-2');

      await expect(service.track('STUB-3')).rejects.toBeInstanceOf(
        RateLimitExceededError,
      );
      expect(stub.track).toHaveBeenCalledTimes(2);
    });
  });

  describe('batch tracking', () => {
    it('isolates failures so one bad number does not lose the rest', async () => {
      const stub = new StubCarrier();
      stub.track.mockImplementation(async (number: string) => {
        if (number === 'STUB-BAD') throw new PermanentError('not found', 404);
        return shipment({ trackingNumber: number });
      });

      const service = await build([stub]);
      const results = await service.trackMany(['STUB-1', 'STUB-BAD', 'STUB-2']);

      expect(results[0].shipment).toBeDefined();
      expect(results[1].error).toContain('not found');
      expect(results[2].shipment).toBeDefined();
    });
  });

  describe('carrier status', () => {
    it('reports circuit state and remaining tokens', async () => {
      const stub = new StubCarrier();
      const service = await build([stub]);

      expect(service.carrierStatus()[0]).toMatchObject({
        carrier: 'stub',
        state: 'closed',
      });
      expect(service.carrierStatus()[0].tokensAvailable).toBeGreaterThan(0);
    });
  });
});

describe('DemoCarrier', () => {
  const carrier = new DemoCarrier();

  it('matches DEMO-prefixed numbers only', () => {
    expect(carrier.matches('DEMO12345')).toBe(true);
    expect(carrier.matches('1234567890')).toBe(false);
  });

  it('returns the same journey for the same number', async () => {
    const first = await carrier.track('DEMO12345');
    const second = await carrier.track('DEMO12345');
    expect(first.status).toBe(second.status);
    expect(first.events).toEqual(second.events);
  });

  it('reports a permanent failure for the NOTFOUND suffix', async () => {
    await expect(carrier.track('DEMO99NOTFOUND')).rejects.toBeInstanceOf(PermanentError);
  });

  it('recovers on the third attempt for the FLAKY suffix', async () => {
    await expect(carrier.track('DEMO77FLAKY')).rejects.toBeInstanceOf(RetryableError);
    await expect(carrier.track('DEMO77FLAKY')).rejects.toBeInstanceOf(RetryableError);
    await expect(carrier.track('DEMO77FLAKY')).resolves.toBeDefined();
  });

  it('always fails for the DOWN suffix', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(carrier.track('DEMO55DOWN')).rejects.toBeInstanceOf(RetryableError);
    }
  });

  it('orders events oldest first and ends at the current status', async () => {
    const result = await carrier.track('DEMO12345');
    const timestamps = result.events.map((e) => Date.parse(e.timestamp));
    const sorted = [...timestamps].sort((a, b) => a - b);

    expect(timestamps).toEqual(sorted);
    if (result.events.length > 0) {
      expect(result.events[result.events.length - 1].status).toBe(result.status);
    }
  });
});
