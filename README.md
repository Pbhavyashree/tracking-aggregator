# Shipment Tracking Aggregator

One API across shipping carriers, built around the patterns that keep an
integration standing when the thing it integrates with does not.

NestJS, TypeScript, Docker, 68 tests. Deployable to Render from the blueprint in
this repo.

## Why this exists

Consuming a third-party API is easy. Consuming one that is occasionally slow,
occasionally down, rate limited, and inconsistent between providers is the
actual job. This service is a small surface — resolve a tracking number to a
normalised shipment — wrapped in the machinery that makes it survive a bad day
at the carrier.

It ships with a deterministic demo carrier, so the deployed instance works for
anyone who opens it without needing an API key. A public demo nobody can run is
not a demo.

## Try it

```bash
npm install
cp .env.example .env
npm run start:dev
```

Docs at `http://localhost:3000/docs`.

```bash
# A normal shipment
curl localhost:3000/api/v1/tracking/DEMO12345

# Carrier returns 404 — note the retry layer does not retry it
curl -i localhost:3000/api/v1/tracking/DEMO11NOTFOUND

# Carrier fails twice then recovers — the caller sees only success
curl localhost:3000/api/v1/tracking/DEMO88FLAKY

# Carrier is down. Call it six times and watch the circuit open:
# the sixth returns 503 with Retry-After, without touching the carrier
for i in $(seq 1 6); do curl -s -o /dev/null -w "%{http_code}\n" \
  localhost:3000/api/v1/tracking/DEMO55DOWN$i; done

# Circuit and rate limit state
curl localhost:3000/api/v1/tracking/carriers/status
```

Set `DHL_API_KEY` to route real DHL numbers to the real carrier. Without it, the
DHL adapter reports itself unconfigured and never claims a tracking number.

## The patterns, and why each is there

**Retry with exponential backoff and full jitter.** Backoff because retrying
immediately adds load to something already struggling. Full jitter because
without it, every client that failed at the same moment retries at the same
moment, and a carrier recovering from an outage gets a synchronised herd and
falls over again.

**Retrying only what is worth retrying.** A 400 will be a 400 again. A 404 means
the tracking number does not exist. Both are classified permanent and fail
immediately. A 429 is retried but honours the carrier's `Retry-After`, because
guessing when you have been told the answer is rude.

**Circuit breaker.** Retries help when a carrier is briefly unwell and hurt when
it is properly down — every request burns its retry budget and makes the caller
wait the full backoff before failing anyway. After five consecutive failures the
circuit opens and calls fail immediately. After a cooldown it allows one probe:
success closes it, failure reopens it for another cooldown. One probe is the
cheapest possible way to ask whether something has recovered.

**Ordering: cache → rate limit → circuit → retry.** This is most of the design.
Retry sits *inside* the breaker, not outside it. Outside, each retry would count
as a separate failure and trip the breaker three times faster than intended,
turning one bad request into an outage for everyone. There is a test asserting
that three attempts register as one failure.

**Token bucket rate limiting.** Carriers publish quotas, and waiting to be told
off by someone else's 429 is a poor way to discover your own limits. Token
bucket rather than a fixed window, because a fixed window permits twice the
intended rate across a boundary — spend the allowance at 0:59 and the next at
1:01.

**Per-shipment failure isolation in batches.** `Promise.allSettled`, not
`Promise.all`: one unknown tracking number in a batch of twenty should not
discard the nineteen that resolved.

**Normalisation at the adapter boundary.** Each carrier has its own shape and
status vocabulary. Mapping to a common model inside the adapter keeps that mess
in one file per carrier instead of leaking into every consumer. Adding a carrier
is one new file and one registry entry.

**Signed webhooks.** Polling a carrier for every shipment a customer cares about
is how you exhaust a quota. Webhooks invert it. Three details make them
trustworthy: an HMAC over the exact body, a timestamp included in the signed
material so a captured delivery cannot be replayed forever, and constant-time
comparison so a fast-failing compare does not leak the correct signature a byte
at a time.

**Idempotency keys on subscription creation.** A client that times out on the
request has no way to know whether it succeeded. Without a key, their natural
retry creates a second subscription and the receiver gets every event twice.

**Liveness that checks nothing external.** If `/health` called a carrier, a
carrier outage would make the orchestrator restart every healthy instance and
turn a partial failure into a total one. `/ready` reports per-carrier circuit
state and returns `degraded` rather than failing, because one carrier being down
still leaves the service useful for every other carrier.

## Verifying a webhook signature

Receivers should do this. `WebhooksService.verify` is the reference
implementation.

```js
const crypto = require('crypto');

function verify(rawBody, secret, timestamp, signature) {
  if (Math.abs(Date.now() - Number(timestamp)) > 300_000) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

The raw body matters — re-serialising the parsed JSON produces different bytes
and the signature will not match.

## MuleSoft

`mulesoft/track-shipment-flow.xml` implements the same integration as a Mule 4
flow: HTTP listener, Object Store cache, `until-successful` for retries, DataWeave
for normalisation, and error handlers mapping carrier failures onto HTTP status.

It is a companion artifact rather than the deployed service — running it needs
Anypoint Studio and a licence. The comparison is the interesting part. Mule gives
you retry, error mapping and transformation as configuration, which is faster to
assemble and easier for a non-author to read. The Node version gives you the same
behaviour as units you can assert on, which is why the jitter and circuit
ordering above have tests and the Mule flow does not. `until-successful` has no
jitter at all, which under a synchronised outage means every worker retries in
lockstep.

## Deploying

`render.yaml` is a Render blueprint — the service can be recreated from git
rather than clicked together in a dashboard. Point Render at the repo, and the
Docker build and health check path come from the blueprint. `DHL_API_KEY` is
marked `sync: false` so it is set in the dashboard rather than committed.

## Tests

| Suite | Covers |
|---|---|
| `resilience.spec.ts` | Backoff shape, jitter, Retry-After, permanent vs transient, all three circuit states, token bucket refill and sustained rate |
| `tracking.service.spec.ts` | Carrier routing, cache behaviour, retry absorption, circuit counting one failure per request, local rate limiting, batch isolation |
| `webhooks.service.spec.ts` | HMAC signing, tampered bodies, wrong secrets, replay rejection, length-mismatch guard, idempotency |
| `tracking.e2e-spec.ts` | Full HTTP surface including error mapping and validation |

The failure-path tests are the point. Anything can be tested on the happy path.

## What I would add next

- **Distributed state.** The cache, circuit breakers and rate limiters are
  per-instance. Two replicas mean two independent circuits and twice the
  intended carrier rate. Redis would fix all three, and is the first thing this
  needs before it is more than a demo.
- **Persistent subscriptions.** They are in memory and vanish on restart.
- **A dead letter queue** for webhook deliveries that exhaust their retries —
  currently they are logged and dropped, which is fine for a demo and not for
  anyone depending on it.
- **Scheduled polling** to drive webhook events, replacing the current
  notify-on-request behaviour.
- **Per-consumer rate limiting**, distinct from the per-carrier limiting that
  exists now.
- **A second live carrier.** The DHL adapter is written and tested but
  unauthenticated: their production API requires a company domain email, which
  a personal project does not have. Shippo and EasyPost issue sandbox keys
  without approval and would slot in as one adapter file plus one registry
  entry — which is the point of normalising at the adapter boundary.