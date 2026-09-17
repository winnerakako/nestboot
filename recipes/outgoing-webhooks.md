# Outgoing webhooks

**Add it when** customers ask to be notified. Inbound webhooks already exist in
`platform/webhooks/inbound/`; this is the other direction.

**One-way doors: none**, except the signature scheme, which your customers write
code against.

## The shape

```sql
CREATE TABLE webhook_endpoints (
  id            uuid PRIMARY KEY,
  url           text NOT NULL,
  secret        text NOT NULL,           -- per endpoint, never global
  events        text[] NOT NULL,         -- which events this endpoint wants
  enabled       boolean NOT NULL DEFAULT true,
  failure_count integer NOT NULL DEFAULT 0,
  disabled_at   timestamptz
);
```

A wildcard listener starts one delivery job per matching endpoint:

```ts
export const DeliverWebhooks = onEvent({
  event: InvoicePaid,
  name: 'DeliverWebhooks',
  meta: { group: 'webhooks', description: 'Fan an event out to subscribers' },
  handle: async (event) => {
    for (const endpoint of await endpointsFor(event.name)) {
      await runtime.start(DeliverWebhook, [{ endpointId: endpoint.id, event }], {
        // Exactly-once per endpoint, per event.
        workflowId: `deliver:${event.id}:${endpoint.id}`,
        queue: Queues.webhooksOut,
      });
    }
  },
});
```

## Sign it the way you would want it signed

```ts
const timestamp = Math.floor(Date.now() / 1000);
const signature = hmacSha256(endpoint.secret, `${timestamp}.${body}`);
// v1=… so you can rotate the scheme without breaking every consumer.
headers['x-signature'] = `t=${timestamp},v1=${signature}`;
```

The timestamp is inside the signed payload deliberately: signing the body alone
lets an attacker replay a captured delivery forever. Tell customers to reject
anything older than five minutes.

## Retry, then give up honestly

Exponential backoff over ~24 hours. After N consecutive failures, disable the
endpoint and **tell the customer** — an endpoint that has been quietly failing
for a week is worse than one that is off, because they think it works.

Deliveries are workflows, so they are already in `/ops → Workflows` with retry
and fork.

## Do not

- Do not deliver inline from the request. A slow customer endpoint must not
  become your latency.
- Do not share one secret across endpoints. Per endpoint, so a leak is contained.
- Do not follow redirects, and resolve the URL before connecting: an endpoint
  pointing at `169.254.169.254` is an SSRF into your cloud metadata service.
