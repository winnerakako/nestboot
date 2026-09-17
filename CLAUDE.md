# NestBoot

A NestJS base whose only opinion is **operability**: every job, workflow,
schedule, log, error, request and security event is visible and controllable
from one `/ops` console inside the app, and the seams are pre-cut so growing is
swapping implementations rather than rewriting.

Pinned: **Node 22 · NestJS 12 (ESM) · Fastify · TypeScript 7 strict · Postgres 17
· Drizzle · DBOS · Vitest**. `BLUEPRINT.md` records why each of those, and what
was deliberately left out.

---

## Verify

```
pnpm verify
```

Biome, tsc, dependency-cruiser and Vitest (real Postgres, via testcontainers).
**This is the definition of done.** CI runs it verbatim. Run it before claiming
anything works.

`test/architecture/` is the executable rulebook. A rule that fails there is not
a style opinion — read the message, it names the rule *and the fix*.

---

## The map

```
src/
├── main.ts                 ROLE switch · security bootstrap · graceful shutdown
├── platform/               the framework. Never imports features.
│   ├── config/             zod env schema · fail-fast · masked view
│   ├── db/                 app + ops pools · read()/write() · forward-only migrations
│   ├── dbos/               the vendor wrapper: defineWorkflow/Job/Schedule, step()
│   ├── http/               problem+json · PlatformException · envelope · cursor pagination
│   ├── logging/            pino · correlation (ALS) · the ops.logs writer
│   ├── requests/           request recording · sampling
│   ├── errors/             fingerprinting · grouping
│   ├── events/             DomainEvent · EventBus · onEvent()
│   ├── cache/              CacheStore on Postgres · remember()
│   ├── security/           headers · CORS · CSRF · rate limiting · ops auth
│   ├── webhooks/inbound/   verify → record → hand to a workflow
│   ├── housekeeping/       partitions · retention · sweeps
│   ├── health/             /health/live · /health
│   ├── stores/             the interfaces /ops reads through
│   ├── console/            the boot:* generators
│   └── ops/                the eight-tab console (Handlebars + htmx)
└── features/<name>/        the product. One vertical slice per feature.
```

### Inside a feature

```
contracts/      ★ the ONLY thing other features may import
actions/        the business operations
dtos/           zod schema + inferred type — the single validation source
entities/ policies/ workflows/ jobs/ schedules/ listeners/ http/
database/migrations/
tests/
```

Paths are **derivable, not searchable**: `CreateInvoice` is always
`features/invoicing/actions/create-invoice.action.ts`, its DTO is
`dtos/create-invoice.dto.ts`, its test is
`tests/create-invoice.action.spec.ts`. Derive the path; don't grep for it.

---

## The loop

```
1. read features/<x>/CLAUDE.md            it is short and it is the local truth
2. pnpm boot:<thing>                      never hand-roll the shape
3. make the generated failing test pass
4. pnpm verify
```

```
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

## Invariants

Break one and `pnpm verify` fails.

**Dependency direction is one-way: `features → contracts → platform`.** A
feature imports another feature only from its `contracts/`. Platform never
imports a feature.

**Business logic in actions; authorization in policies.** Controllers are
adapters: validate → authorize → call the action → format. They hold neither,
touch no database, and dispatch no jobs.

**The action contract:** takes a typed DTO, returns a domain object. No
`Request`, no `Response`, no `req.user` — an action must run unchanged in a
queue worker, so the actor travels on the DTO. Failure is a typed exception
extending `PlatformException`, never `null` and never a `Result` to branch on.

**Errors are `application/problem+json`** on every surface. `type` URIs come
from the registry in `platform/http/problem.ts` — never invent a string at a
throw site. API bodies wrap in `{"data": …}`. Pagination is cursor-based.

**Two databases, from the first commit.** `DATABASE_URL` holds product tables
and DBOS's system schema; `OPS_DATABASE_URL` holds logs, requests, errors,
security events, counters and cache. No query joins across them.

**Migrations are forward-only. No `down()`.** Roll forward, or restore. Every
telemetry table is time-partitioned by day and retained by dropping partitions.

**Everything background is enqueued**, even from a process that could run it
inline — so it survives the request, respects the queue's concurrency limit, and
is retryable from /ops.

**Every workflow, job, schedule and listener carries `meta: { group, description }`.**
The group is what lets an operator ask about "payments" instead of a class name,
and it is what /ops groups by.

**No mutable module-level state.** In a long-lived process a module-level `let`
that a request writes is read by the *next* request, on a different user's
behalf. Need a cache? `cache.remember()`. The allowlist is in
`test/architecture/static-state.spec.ts` and each entry states why.

**Telemetry may never take down what it observes.** Every writer batches,
swallows its own failures, drops rather than growing without bound, and reports
what it dropped. The rate limiter fails **open** for the same reason.

**Raw SQL rows declare timestamps as `string`.** Drizzle installs its own `pg`
type parsers and returns `timestamptz` as a string on the raw-`execute` path.
Convert with `toDate()` from `platform/db/raw.ts`; the types are written so the
compiler forces it. (A `Date`-typed field that is really a string silently
disabled account lockout here once.)

---

## `/ops` — the operator console

Eight tabs over the app's own Postgres: **Workflows · Queues · Schedules · Logs
· Errors · Requests · Health · Security**. It is a *control* surface — cancel a
workflow, fork it from a repaired step, retry a dead letter, run a schedule now,
edit a rate-limit policy, block a subject, revoke every session.

Rules when working on it:

- **Never present an absence as a fact.** A tab that cannot read its data says
  so; it does not render an empty list. "Nothing is wrong" and "I cannot see"
  are different statements and only one of them is true. Asserted in
  `ops.spec.ts`.
- **Every query is windowed**, so Postgres can prune partitions.
- **Request volume is `sum(1 / sample_rate)`, never `count(*)`** — rows are
  sampled, and a count understates traffic silently.
- **Full-text search uses `plainto_tsquery('simple', …)`.** The generated
  columns use the `simple` dictionary; `'english'` stems the query and matches
  nothing.
- **Every mutation goes through an Action**, like any other surface.
- **Every controller carries `@UseGuards(OpsGuard)`.** Not an `APP_GUARD` — Nest
  applies those globally regardless of the declaring module, which would put the
  console's login in front of the whole app.

---

## Local

```
docker compose up -d        postgres on 5443, with the app and ops databases
cp .env.example .env
pnpm migrate
pnpm dev                    http://localhost:3000 · /ops
```

`ROLE=web` serves HTTP and cannot execute a workflow. `ROLE=worker` executes
workflows and serves no HTTP. `ROLE=all` is both, for a laptop.
