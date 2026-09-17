# Idempotency

**Add it when** clients retry writes — which is every client, because networks
time out after the server committed.

**One-way doors: none.** This is additive.

## Two halves

**Background work already has it.** `runtime.start(ref, args, { workflowId })`
is idempotent: the same id is the same workflow, forever. Derive it from the
thing being acted on, never from a random value:

```ts
await runtime.start(ChargeInvoice, [{ invoiceId }], {
  workflowId: `charge:${invoiceId}`,   // a double-submit is one charge
});
```

**HTTP writes need a key.** Add a middleware over the `Idempotency-Key` header:

```sql
CREATE TABLE idempotency_keys (
  key          text        PRIMARY KEY,
  route        text        NOT NULL,
  -- The hash is what stops a client reusing a key for a DIFFERENT request and
  -- getting the first one's answer back.
  request_hash text        NOT NULL,
  status       smallint,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
```

The flow:

1. `INSERT ... ON CONFLICT DO NOTHING`. If you inserted, you own this request.
2. If you did not, read the row.
   - Same `request_hash`, completed → replay the stored response.
   - Same hash, still in flight → `409`, tell the client to retry shortly.
   - **Different hash → `422`.** The key was reused for different content, which
     is a client bug; answering with the first response would be silently wrong.
3. Do the work, store status and body, mark completed.

Expire keys after 24h — long enough for any sane retry, short enough that the
table stays small.

## Verify

`pnpm verify`. The test that matters: the same key twice returns the same body
and the effect happened once.
