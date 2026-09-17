# Metrics and tracing

**Add it when** you need "why is this slow", not "what is broken". `/ops`
answers the second question well and the first one badly.

**One-way doors: none.**

## The division

- **`/ops`** — what is wrong right now, and the controls to fix it. Cancel a
  workflow, retry a dead letter, block a subject.
- **Metrics/tracing** — why. Where the 300ms went, which dependency regressed,
  what the p99 looked like last Tuesday.

They overlap, and that is fine. Do not try to make `/ops` a metrics platform: it
would be a worse Grafana, built by you.

## Tracing

The correlation context already carries `traceId` when a `traceparent` header
arrives. Add the OpenTelemetry SDK, and:

- put the trace id on `ops.requests` and `ops.logs` — both columns exist;
- link out from `/ops` by trace id;
- instrument `step()` in `platform/dbos/define.ts` — one place, and every
  workflow step is a span.

## Metrics

Expose `/metrics` on a **separate port**, not the public one. A metrics endpoint
on the main listener is either public or behind a guard nobody maintains.

Start with four: request rate, error rate, latency p99, queue depth. Add more
when a specific question needs one — a dashboard of 200 metrics answers nothing.

## The thing that actually matters

**Alerting cannot live inside the app it watches.** An alerter in this process
cannot tell you this process is dead. Whatever you use for metrics, the
"is it up" check must come from outside — an external uptime ping against
`/health`, at minimum.
