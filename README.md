# NestBoot

A NestJS base whose only opinion is **operability**.

Every job, workflow, schedule, log, error, request and security event is visible
— and controllable — from one `/ops` console served by the app itself, over the
app's own Postgres. No extra services, no dashboard to deploy, no vendor to sign
up with.

```
Node 22 · NestJS 12 (ESM) · Fastify · TypeScript 7 strict
Postgres 17 · Drizzle · DBOS · Vitest against a real database
```

- **[Quick start](#quick-start)** — running in five minutes
- **[Build a feature](#build-a-feature)** — the loop you repeat
- **[Background work](#background-work)** — jobs, workflows, schedules, events
- **[The `/ops` console](#the-ops-console)** — what each tab is for
- **[Deploying](#deploying)** — the part most templates skip
- **[Scaling](#scaling-later)** — what changes, and when

`CLAUDE.md` is the short version for working in the codebase (human or AI).
`BLUEPRINT.md` records *why* it is built this way and what was deliberately left
out. `recipes/` holds the things you add only once your app has earned them.

---

## Why this exists

Most templates give you a folder layout and an auth module, then leave you to
discover at 3am that you cannot tell whether a background job ran.

NestBoot's bet is that **the operational layer is the highest-leverage thing a
template can provide**, because it is the thing you cannot retrofit. Seeing and
controlling background work from inside the app is what separates "runs on my
laptop" from "debuggable in production".

Its second bet is that most "correctness" features are *product* decisions, not
template decisions. Multi-tenancy, money-as-bigint, idempotency keys — each is
right for some apps and dead weight for the rest. A thing is in `platform/` only
if **every app needs it on day one AND it is painful to add on day 100**.
Everything else is a recipe you paste when you need it.

---

## Quick start

**Prerequisites:** Node 22 (`.nvmrc` pins it), pnpm, Docker.

```bash
nvm use                       # or: fnm use
pnpm install
docker compose up -d          # Postgres on 5443, two databases: app + ops
cp .env.example .env
pnpm migrate                  # both databases; safe to re-run
pnpm dev
```

| | |
|---|---|
| API | http://localhost:3000 |
| Console | http://localhost:3000/ops |
| Health | http://localhost:3000/health |

**To sign in to `/ops`,** set a password in `.env` first:

```bash
OPS_PASSWORD=$(openssl rand -base64 24)   # 16+ characters required
```

It creates the first operator **only when no account exists**, so it can never
silently reset a password you later changed. On first sign-in you are given a
TOTP secret — add it to an authenticator app, enter the code, then delete
`OPS_PASSWORD` from your environment.

> Port 5443, not 5432 — you almost certainly have another Postgres already, and
> "database app does not exist" against the wrong server wastes an afternoon.

### Verify

```bash
pnpm verify     # biome · tsc · dependency-cruiser · vitest (real Postgres)
```

**This is the definition of done**, and it is exactly what CI runs. The tests
spin up Postgres via testcontainers and clone a migrated template database per
test file, so they are real and still finish in seconds.

`test/architecture/` is an executable rulebook. When it fails, the message names
the rule *and* the fix — it is written to be actionable by someone who has never
read the blueprint.

---

## Build a feature

Never hand-roll the shape. Boilerplate drifts by the fifth copy; a generator
cannot.

```bash
pnpm boot:feature invoicing
pnpm boot:action invoicing CreateInvoice --http
```

That gives you:

```
src/features/invoicing/
├── CLAUDE.md                              what this feature owns
├── contracts/          ← the ONLY thing other features may import
├── actions/create-invoice.action.ts       the business operation
├── dtos/create-invoice.dto.ts             zod schema; the one validation source
├── http/create-invoice.controller.ts      the adapter
├── tests/create-invoice.action.spec.ts    fails on purpose
├── entities/ policies/ workflows/ jobs/ listeners/
└── database/migrations/
```

**The loop:** make the generated failing test pass, then `pnpm verify`.

Add the module to `src/app.module.ts` — deliberately by hand, rather than
auto-discovered, so that reading one file tells you what the app actually is.

### Why the paths are predictable

`CreateInvoice` is *always*
`features/invoicing/actions/create-invoice.action.ts`, its DTO is always
`dtos/create-invoice.dto.ts`, its test is always
`tests/create-invoice.action.spec.ts`.

Derive the path; don't grep for it. `conventions.spec.ts` enforces this, which
is what makes it safe to rely on.

### The rules that have teeth

```
features → contracts → platform          one direction, never back
```

- **Business logic in actions. Authorization in policies.** Controllers are
  adapters: validate → authorize → call the action → format. They hold neither,
  touch no database, dispatch no jobs.
- **An action takes a typed DTO and returns a domain object.** No `Request`, no
  `req.user` — it must run unchanged in a queue worker, so **the actor travels
  on the DTO**.
- **Failure is a typed exception** extending `PlatformException`, never `null`
  and never a `Result` to branch on. A caller who forgets to check a `Result`
  compiles and ships, and the failure becomes a wrong answer.
- **A feature imports another feature only from its `contracts/`.** Need its
  action? You don't — you need an event.

All enforced by `pnpm verify`, not by review.

### Errors

Every surface answers `application/problem+json` (RFC 9457). There is no second
error shape.

```ts
throw new NotFoundException('invoice', id);
```

```json
{
  "type": "https://your.app/problems/not-found",
  "title": "Not found",
  "status": 404,
  "detail": "No invoice with id inv_9.",
  "requestId": "01a0aa51-218a-7a26-b3e4-057fe24b6951",
  "resource": "invoice",
  "id": "inv_9"
}
```

`type` comes from a registry and is the one field a client may branch on — never
invent one at a throw site. Every type URI is dereferenceable at `/problems/:slug`.

An *unexpected* error is reported as a bare 500 with its detail withheld outside
development, because those messages routinely contain connection strings and SQL.

---

## Background work

Three shapes, one engine. All of them appear in `/ops` and are retryable from it.

```ts
// A single external effect, with retries.
export const SendReceipt = defineJob({
  name: 'SendReceipt',
  meta: { group: 'notifications', description: 'Email the receipt' },
  queue: Queues.mail,
  run: async (input: { invoiceId: string }) => {
    await step('send', { retries: 3 }, () => mailer.send(input.invoiceId));
  },
});

// Multi-step, durable, resumable.
export const ChargeInvoice = defineWorkflow({
  name: 'ChargeInvoice',
  meta: { group: 'payments', description: 'Charge and record a payment' },
  run: async (input: { invoiceId: string; amountMinor: bigint }) => {
    const charge = await step('charge', () =>
      // The workflow id as the idempotency key: a retry cannot double-charge.
      provider.charge({ ...input, idempotencyKey: currentWorkflowId()! }),
    );
    if (charge.status !== 'settled') {
      await step('reverse', () => provider.reverse(charge.id));
      throw new PaymentFailed(input.invoiceId);
    }
    await step('record', () => ledger.record(charge));
  },
});
```

Start it — from an action, never from a controller:

```ts
await runtime.start(ChargeInvoice, [{ invoiceId, amountMinor }], {
  workflowId: `charge:${invoiceId}`,   // a double-submit is one charge
});
```

**Everything is enqueued**, even from a process that could run it inline.
Inline execution ties the work to the request that started it, skips the queue's
concurrency limit, and leaves nothing to retry when it fails.

**What belongs in a `step()`:** anything with an outside effect — HTTP calls,
sending mail, writing to another system, reading the clock, generating an id. A
completed step never runs again, even when the workflow resumes after a crash.
That is what makes "charge the card" safe in the middle of a long process.

**Job or workflow?** A job is atomic: a crash re-runs it from the start. A
workflow resumes from its last completed step. If failing halfway would leave
the world inconsistent, it is a workflow.

### Schedules

```ts
export const NightlyReconcile = defineSchedule({
  name: 'NightlyReconcile',
  meta: { group: 'payments', description: 'Reconcile against the processor' },
  crontab: '0 2 * * *',
  run: async (scheduledAt) => { /* … */ },
});
```

Declared in code, reconciled into the engine's schedule table at worker boot —
so code-declared and operator-created schedules are **one list with one set of
controls** in `/ops`, rather than a static set nobody can pause plus a dynamic
set nobody reviews.

### Events

How one feature reacts to another without importing it.

```ts
// features/invoicing/contracts/events/invoice-paid.event.ts
export class InvoicePaid extends DomainEvent {
  constructor(readonly invoiceId: string, readonly amountMinor: number) { super(); }
}

// features/notifications/listeners/send-receipt.listener.ts
export const SendReceiptOnPaid = onEvent({
  event: InvoicePaid,
  name: 'SendReceiptOnPaid',
  meta: { group: 'notifications', description: 'Email a receipt' },
  handle: async (event) => { /* … */ },
});
```

```ts
await events.emit(new InvoicePaid(invoiceId, amountMinor));
```

Each listener runs as its own workflow with
`workflowId = ${event.id}:${listener}` — which makes delivery exactly-once per
listener, retried on failure, and visible in `/ops`. **There is no outbox table
and no relay job: the workflow record *is* the outbox row.** Emitting the same
event twice is a no-op, not a duplicated side effect.

The emitting feature never learns who reacted. That is the entire point.

> The handler receives the event as **plain data**, not a class instance —
> arguments cross a process boundary as JSON. Read fields; don't call methods.

### `meta: { group, description }` is mandatory

At 3am nobody asks "is `ChargeInvoiceWorkflow` failing", they ask "is payments
broken". The group is what `/ops` groups and filters by. A grouping dimension
that is 80% populated is worse than none, because the tab then lies by omission.

---

## The `/ops` console

Eight tabs over your own Postgres, at `OPS_PATH` (default `/ops`). It is a
**control** surface, not a dashboard.

| Tab | What it answers | What you can do |
|---|---|---|
| **Workflows** | what is running, what is stuck | cancel · resume · **fork from a step** · inspect step I/O |
| **Queues** | what is backing up, what failed | retry · cancel · see depth per queue and per group |
| **Schedules** | is the cron still running | pause · resume · **run now** · see last fired |
| **Logs** | what happened, in order | filter, full-text search, grouped into a timeline per request |
| **Errors** | which bugs, not which occurrences | resolve · mute · jump to the request that caused it |
| **Requests** | which endpoint regressed | volume, error rate, p50/p95/p99 by route |
| **Health** | is anything degraded | live checks, config (secrets masked), telemetry writer stats |
| **Security** | who was blocked and why | edit rate-limit policy · block a subject · revoke every session |

**Fork-from-step** is the one worth knowing about. Step 7 wrote the wrong thing
because of a bug you have now fixed: deploy, fork from step 7, and steps 1–6
keep their checkpoints and do not happen again.

### Two rules the console lives by

**It never presents an absence as a fact.** A tab that cannot read its data says
so; it does not render an empty list. "Nothing is wrong" and "I cannot see" are
different statements and only one of them is true. Asserted in tests.

**It reports on its own instruments.** Health shows what each telemetry writer
has dropped. If the logs you are reading have gaps, the console says so rather
than letting you draw conclusions from an incomplete picture.

### Search

One syntax on every list page, and the state lives in the URL — so a filtered
view is a link you can paste into an incident channel.

```
level:error route:/loans/:id since:2h timed out
status:ERROR group:payments queue:mail
```

---

## Deploying

One image, two roles, three steps. No provider is assumed.

### The shape

```
┌───────────────┐        ┌──────────────────┐
│ web  ROLE=web │───────▶│ Postgres: app    │  product tables + DBOS state
│ (N replicas)  │        │                  │
└───────────────┘        └──────────────────┘
┌───────────────┐        ┌──────────────────┐
│ worker        │───────▶│ Postgres: ops    │  logs, requests, errors,
│ ROLE=worker   │        │                  │  security, counters, cache
└───────────────┘        └──────────────────┘
```

**Same image both times.** `ROLE` decides what the container is:

- `ROLE=web` — serves HTTP and is *structurally incapable* of executing a
  workflow. It connects a client that can enqueue and inspect, and has no
  executor at all.
- `ROLE=worker` — executes workflows and schedules, binds no port.
- `ROLE=all` — both. Fine for a laptop or a small deployment.

Ship the split even if you run one container today. Retrofitting it means
auditing every workflow for request-scoped state it quietly came to depend on.

### Build

```bash
docker build -t yourapp .
```

Multi-stage, non-root, `tini` as PID 1 so `SIGTERM` reaches Node — which is what
lets the app drain instead of being killed mid-step.

### Release

```bash
# 1. migrate (both databases; idempotent; run as a release step)
docker run --rm --env-file .env yourapp node dist/src/platform/db/migrate.cli.js

# 2. roll web
# 3. roll workers
```

Migrations are **forward-only** — no `down()`. A rollback that has run in
production is a second, forward migration written with knowledge of what
actually broke; a `down()` written months earlier is a guess executed during the
worst ten minutes of your quarter. Roll forward, or restore from backup.

Each migration runs under a `lock_timeout`, so one that cannot get its lock
fails the deploy rather than queueing behind a long read and blocking every
writer that arrives after it.

### Environment

Everything is validated at boot by a zod schema. A bad deploy fails in the first
second with **every** problem listed, not on the first request that happens to
read a missing key.

| Variable | Notes |
|---|---|
| `ROLE` | `web` · `worker` · `all` |
| `DATABASE_URL` | product tables **and** DBOS state |
| `OPS_DATABASE_URL` | telemetry |
| `APP_SECRET` | 32+ chars; `openssl rand -hex 32` |
| `APP_URL` | must be `https://` in production |
| `TRUST_PROXY` | **required in production** — your load balancer's CIDR |
| `CORS_ORIGINS` | empty denies everything; `*` is refused outright |
| `OPS_PASSWORD` | bootstraps the first operator, then delete it |
| `OPS_IP_ALLOWLIST` | optional; restrict the console by source address |
| `OPS_REQUEST_SAMPLE` | `0`–`1`; errors and slow requests always kept |

Production **refuses to start** without `TRUST_PROXY`, with a plaintext
`APP_URL`, or with a weak `OPS_PASSWORD`. Without `TRUST_PROXY` every client
appears to come from the load balancer, which silently turns per-IP rate
limiting into one global limit — a default that is fine on a laptop and a
vulnerability on the internet.

### Health checks

| Endpoint | For | Touches the database |
|---|---|---|
| `/health/live` | liveness probe | **no** |
| `/health` | readiness probe + detail | yes |

Point liveness at `/health/live`. If a database blip fails your liveness probe,
the orchestrator restarts every pod at once and turns a recoverable incident
into an outage. Readiness is the one allowed to say "not me right now".

### Managed Postgres (Neon, Supabase, RDS)

- Two databases in one project is fine; `OPS_DATABASE_URL` is one variable when
  you later want to move telemetry to its own instance.
- **On a connection pooler:** web may use the pooled URL, but the **worker needs
  the direct URL** — DBOS uses `LISTEN/NOTIFY`, which transaction pooling breaks.
- `UNLOGGED` tables (rate-limit counters, cache) are wiped if the compute
  suspends. That is survivable by design: one window of unlimited requests and a
  cold cache.

### A production checklist

- [ ] `TRUST_PROXY` set to the load balancer's CIDR
- [ ] `APP_SECRET` from a secret manager, not the repo
- [ ] `CORS_ORIGINS` lists real origins
- [ ] `OPS_PASSWORD` removed after TOTP enrolment
- [ ] `OPS_IP_ALLOWLIST` set, if the console need not face the internet
- [ ] Migrations run as a release step, before the roll
- [ ] External uptime ping against `/health` — **an alerter inside the app
      cannot report the app being down**
- [ ] Nightly `pg_dump` of both databases, and a restore actually tested

---

## Scaling later

Nothing here is needed on day one; all of it is a provider swap, because every
`/ops` tab reads an interface rather than a table.

| When | Do | Recipe |
|---|---|---|
| Reads dominate | `DATABASE_READ_URL` → a replica | [read-replicas](recipes/read-replicas.md) |
| Telemetry is loud | `OPS_DATABASE_URL` → its own instance | — |
| Cache/counters are hot | Redis implements `CacheStore` / `RateLimitStore` | [redis](recipes/redis.md) |
| Logs outgrow Postgres | ClickHouse implements `LogStore` | [clickhouse-logs](recipes/clickhouse-logs.md) |
| Huge single-step volume | BullMQ as a `QueueBackend` | [redis](recipes/redis.md) |
| You need "why", not "what" | metrics + tracing | [metrics-tracing](recipes/metrics-tracing.md) |

**DBOS stays on Postgres.** Its checkpoints are written in the same transaction
as your product rows — that is precisely what makes a step's effects
exactly-once. Split them and you have a distributed commit problem and no
guarantee.

### Recipes

Features you add only once your app has earned them. Each names its one-way
doors up front: [tenancy](recipes/tenancy.md) ·
[product-auth](recipes/product-auth.md) · [money](recipes/money.md) ·
[idempotency](recipes/idempotency.md) ·
[outgoing-webhooks](recipes/outgoing-webhooks.md) ·
[plan-limits](recipes/plan-limits.md) · [and more](recipes/).

---

## Commands

```bash
pnpm dev                 # ROLE from .env, watch mode
pnpm verify              # lint · typecheck · boundaries · tests — the gate
pnpm test                # vitest against real Postgres
pnpm migrate             # both databases, forward-only
pnpm migrate --dry-run   # what would run
pnpm build               # tsc + copy .sql/.hbs/.css into dist/

pnpm boot:feature   <name>
pnpm boot:action    <feature> <Name> [--http]
pnpm boot:workflow  <feature> <Name>
pnpm boot:job       <feature> <Name>
pnpm boot:event     <feature> <Name>
pnpm boot:listener  <feature> <Name> --event=<feature>/<Event>
pnpm boot:migration <feature> <name>
```

Stubs live in `stubs/`. **Change the stub, never the generated file.**

---

## What this is deliberately not

Not multi-tenant, not a payments system, not an auth product, not an admin CRUD
generator, not a metrics platform, not an SPA. Those are recipes you paste when
you earn them.

The promise is narrower and stronger: **one app, one Postgres, one `/ops`, and
seams that make growing it boring.**

## License

MIT.
