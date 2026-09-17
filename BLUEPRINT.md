# NestBoot — Blueprint

> The design document for NestBoot: a NestJS starter whose only opinion is
> **operability**. Read this before writing the first line of code. Everything
> here was decided deliberately; the *why* is recorded so future decisions can be
> made consistently — by a person or by an AI.

Status: **design complete, no code yet.** Build order is in §14.

---

## 0. One-sentence summary

A NestJS app that can always tell you what it is doing — every job, workflow,
schedule, log, error, request and security event in one Postgres-backed `/ops`
UI inside the app itself — with the seams pre-cut so growing to 1M users is
swapping implementations, never rewriting.

---

## 1. Origin and philosophy

NestBoot is the successor to **LaravelBoot** (`~/Documents/Dev/laravel`), a
Laravel 13 base with vertical slices, contracts-only imports, architecture
tests, generators, Postgres RLS tenancy, workflows, and Filament/Pulse/Nightwatch
tooling. Building it taught two lessons that define NestBoot:

1. **The operational layer is the highest-leverage thing a template can
   provide.** Being able to *see and control* background work and logs from
   inside the app is what separates "runs on my laptop" from "debuggable in
   production at 2am". Most templates skip it entirely.
2. **Most "correctness" features are product decisions, not template
   decisions.** Multi-tenancy/RLS, money-as-bigint, idempotency keys,
   actor-on-DTO audit trails — each is right for *some* apps and dead weight
   for the rest. Baking them in made LaravelBoot a template for one kind of app.

### The filter for what goes in the template

A thing belongs in `platform/` only if **both** are true:

- every app needs it on day one, **and**
- it is painful to add on day 100 (once there is data and traffic).

Everything else is a **recipe** (`recipes/*.md`): a short, paste-able document
an app follows when — and only when — it earns the feature.

### AI-first

The reader and writer of this code will mostly be an AI. AI is excellent at
following a pattern it can see and bad at remembering a rule it was told once.
Therefore every convention is one of:

- **generated** — the stub in `stubs/` *is* the pattern (`pnpm boot:*`);
- **derivable** — the name tells you the path; nothing is grepped for;
- **enforced** — a test in `test/architecture/` fails with a message that
  names the rule *and the fix*.

A prose rule that is none of those three does not exist. Docs are short:
root `CLAUDE.md` ≤ 100 lines, feature `CLAUDE.md` ≤ 30 lines, recipes.

### DRY

Every concern has exactly one home (see §7). If two features would copy the
same ten lines, it moves to `platform/` **and** gets a stub or helper so the
next feature receives it for free.

---

## 2. Stack (pinned)

| Concern | Choice | Why |
|---|---|---|
| Framework | **NestJS 11** on **Fastify** | modules give real runtime boundaries; Fastify = long-lived process like Octane |
| Language | **TypeScript strict** | types replace half of what PHPStan + architecture tests did |
| Database | **Postgres 17** — two databases: `app` and `ops` | see §5 |
| ORM | **Drizzle** | SQL-first; `SET LOCAL` in transactions is natural; plain-SQL forward-only migrations |
| Durable execution / queues / cron | **DBOS Transact** (`@dbos-inc/dbos-sdk`) | lives in *your* Postgres; no extra server; one engine for jobs, schedules and workflows; everything is a row we can render |
| `/ops` rendering | **Handlebars** (`@fastify/view`) + **htmx** | no SPA build; forms work; pages are templates over Postgres |
| Validation | **zod** | one schema per DTO consumed by every surface |
| Auth for `/ops` | password + TOTP, argon2, Postgres sessions | the keys to the kingdom; no API tokens |
| Logging | **pino** (`nestjs-pino`) | structured, redaction, transports |
| Tests | **Vitest** + **testcontainers** (Postgres) + DBOS test mode | real DB, parallel |
| Lint / format | **Biome** | one tool |
| Boundaries | **dependency-cruiser** | declarative rules with good messages |
| Generators | **nest-commander** | `pnpm boot:*` |

**Deliberately absent on day one:** Redis, BullMQ, Temporal, Kafka, Bull Board,
Grafana/Prometheus, Sentry, any SPA. Each has a recipe.

### Why DBOS and not Temporal / BullMQ

- **BullMQ** is a job queue: it makes sure a *job runs*. A job is atomic; a
  crash re-runs it from the start; no `sleep(3 days)`, no wait-for-event, no
  step-level resume. Flows give static parent/child trees only. Needs Redis.
- **Temporal** is a durable execution engine like DBOS but is a separate server
  with its own store and UI, and a strict deterministic sandbox for workflow
  code. More powerful and more proven; more to run; its UI cannot cleanly sit
  under our auth.
- **DBOS** checkpoints every *step* in our own Postgres. A job is a one-step
  workflow on a queue; cron is `DBOS.scheduled`; a saga is normal code with
  `try/catch`. One datastore, one list, one `/ops` page. It is the newer bet, so
  it is wrapped in `platform/dbos/` and features never import the vendor.

One line: *BullMQ makes sure a job runs; DBOS makes sure a process finishes.*

---

## 3. The seven day-one seams (non-negotiable)

These are the things that cannot be retrofitted cheaply. They are seams, not
features.

1. **Stateless processes with a `ROLE` split** — `ROLE=web | worker | all`;
   same image. Web never runs workflows. Ship the split even if both run in one
   container.
2. **Store interfaces behind `/ops`** — `LogStore`, `QueueBackend`,
   `RateLimitStore`, `CacheStore`. Postgres implementations only, but every page
   talks to the interface.
3. **Pooler-safe data layer with read/write split** — `db.read()` /
   `db.write()` (same host initially); no session-level Postgres state;
   `SET LOCAL` only inside transactions.
4. **Migration safety rails** — forward-only (no `down()`), `lock_timeout`,
   `CREATE INDEX CONCURRENTLY`, a lint that blocks unsafe `ALTER`s.
5. **Time-partitioned append-only tables from the first migration** — logs,
   requests, errors, security events; retention by dropping partitions.
6. **Correlation ids everywhere** — request id → job id → workflow id → step →
   log line → error, via middleware + AsyncLocalStorage logger context + job
   payloads.
7. **Graceful shutdown + health** — `SIGTERM` → stop accepting → drain steps →
   close DB → exit; `/health` reports db, dbos, queue depth, schedule staleness.

Plus the **two-database split** (§5), which is the eighth seam in practice.

---

## 4. Repository structure

```
nestboot/
├── CLAUDE.md                          ≤100 lines: map · verify · generators · invariants → test
├── BLUEPRINT.md                       this file
├── package.json                       pnpm verify = biome · tsc · vitest · depcruise · openapi diff
├── .dependency-cruiser.cjs            features → contracts → platform (one rule)
├── biome.json · tsconfig.json · vitest.config.ts · drizzle.config.ts
├── Dockerfile                         multi-stage, non-root, postgresql-client (pg_dump)
├── docker-compose.yml                 postgres only
│   └── docker/init.sql                CREATE DATABASE app; CREATE DATABASE ops;
├── .env.example
│
├── src/
│   ├── main.ts                        ROLE switch · DBOS.launch · graceful shutdown
│   ├── app.module.ts
│   │
│   ├── platform/                      the framework — features never edit it
│   │   ├── config/                    zod env schema · fail-fast · masked view
│   │   ├── db/                        Drizzle · app + ops pools · read()/write() · migration rails
│   │   ├── dbos/                      vendor wrapper · registry · queues.ts · test mode
│   │   ├── http/                      problem+json filter · PlatformException · envelope · cursor pagination · zod pipe
│   │   ├── schedules/                 schedules table · service · dispatcher workflow
│   │   ├── logging/                   pino · correlation (ALS) · pg transport · LogStore
│   │   ├── requests/                  request log middleware · sampling
│   │   ├── errors/                    fingerprinting · errors table
│   │   ├── events/                    DomainEvent · emit() → listener workflows · @OnEvent · registry
│   │   ├── cache/                     CacheStore · PostgresCacheStore · remember()
│   │   ├── webhooks/
│   │   │   └── inbound/               /webhooks/:provider · verifiers · inbound table · process workflow
│   │   ├── security/
│   │   │   ├── headers.ts · cors.ts · csrf.ts · body-limits.ts · trusted-proxy.ts
│   │   │   ├── rate-limit/            RateLimitSubject · resolver · policies · PG store · 429 headers
│   │   │   ├── ops-auth/              password + TOTP · sessions · lockout · IP allowlist
│   │   │   └── events/                security_events writer
│   │   ├── alerts/                    alert_rules · evaluator workflow · channels (email, webhook)
│   │   ├── health/                    /health JSON · live checks
│   │   ├── housekeeping/              retention workflows · partition manager · backup workflow
│   │   ├── stores/                    interfaces: LogStore · QueueBackend · RateLimitStore · CacheStore
│   │   ├── testing/                   actingAs · runWorkflow · fakeClock · queryBudget · testcontainers
│   │   ├── console/                   boot:* commands (nest-commander)
│   │   └── ops/                       the one UI (Handlebars + htmx)
│   │       ├── ops.guard.ts · layout/
│   │       ├── workflows/             list · detail · cancel · resume · fork · signal
│   │       ├── queues/                depth · failed · retry · pause
│   │       ├── schedules/             CRUD · run now · history
│   │       ├── logs/                  filters · links
│   │       ├── errors/                grouped · resolve · mute
│   │       ├── requests/              slow/failed · per-route p50/p95
│   │       ├── health/                checks · alert rules · config · cache stats/flush
│   │       └── security/              auth events · rate-limit policies/overrides/inspect · sessions · blocks
│   │
│   ├── contracts/                     (optional) shared cross-feature types
│   │
│   └── features/
│       └── <name>/
│           ├── CLAUDE.md              ≤30 lines: what it owns, external deps, non-obvious rules
│           ├── contracts/             interfaces · DTO types · events/  ← the ONLY importable surface
│           ├── actions/               business operations: typed DTO in → domain object out
│           ├── dtos/                  zod schema + inferred type; single validation source
│           ├── entities/              Drizzle tables + relations
│           ├── policies/              can(actor, action, subject)
│           ├── workflows/             DBOS multi-step workflows
│           ├── jobs/                  DBOS one-step workflows on a queue
│           ├── schedules/             static DBOS.scheduled entries
│           ├── listeners/             @OnEvent handlers (each is a DBOS workflow)
│           ├── webhooks/              provider verifiers + handlers for this feature
│           ├── http/                  controller · resource
│           ├── database/              migrations/ factories/ seeders/
│           ├── <name>.module.ts       Nest module; exports contracts/ providers ONLY
│           └── tests/
│
├── stubs/                             feature · action · dto · workflow · job · schedule · event · listener · webhook · migration
│
├── test/
│   ├── architecture/                  the rulebook (see §11)
│   └── setup/                         testcontainers · DBOS test harness
│
└── recipes/                           see §13
```

### Naming is derivable

`ApplyForLoan` → `features/loans/actions/apply-for-loan.action.ts` →
`features/loans/dtos/apply-for-loan.dto.ts` (exports `ApplyForLoanSchema` and
`ApplyForLoanData`) → `features/loans/tests/apply-for-loan.action.spec.ts`.
`naming.spec.ts` asserts file ⇄ class ⇄ folder.

### Dependency direction

`features → contracts → platform`. A feature imports another feature **only**
from its `contracts/`. `platform/` never imports `features/`. One
dependency-cruiser rule; `feature-boundaries.spec.ts` backs it with a readable
message.

---

## 5. Data layer

### Two databases from the first commit

```
DATABASE_URL       → app   product tables · DBOS system schema · schedules · rate_limit_policies
                           · ops_users · ops_sessions · alert_rules · webhook_inbound
OPS_DATABASE_URL   → ops   logs · requests · errors · security_events
                           · rate_limit_counters (UNLOGGED) · cache (UNLOGGED)
```

Why: observability + rate-limit traffic is 5–10× larger than product traffic
and scales with every request (≈1 request row + 3–10 log rows + 1–3 counter
upserts per request). On one database it competes with product tables for
cache, vacuum, WAL and disk. Splitting later means migrating hundreds of
millions of rows; splitting on day one is one env var.

- Day one: same Postgres server, two logical databases (`docker/init.sql`; on
  Neon, two databases in one project).
- The ops DB uses `synchronous_commit = off` where the host allows it,
  `UNLOGGED` for counters and cache, batched inserts (pino transport buffers
  ~100 rows / 500 ms), a sampling knob for request/debug logs
  (`OPS_REQUEST_SAMPLE`, errors and slow requests always kept), and daily
  partitions with drop-based retention.
- **DBOS stays in `app`** on purpose: a step can write product rows and its
  own checkpoint in one transaction — that is what makes effects exactly-once.
- No query ever joins across the two databases.

### Conventions

- Drizzle; `db.read()` / `db.write()`; `DATABASE_READ_URL` optional.
- Pooler-safe: no `SET` outside transactions, no prepared-statement reliance,
  no advisory locks held across requests. (On Neon: web uses the pooled URL,
  worker uses the direct URL — DBOS needs `LISTEN/NOTIFY`.)
- Migrations: forward-only, `SET lock_timeout = '5s'` in every migration,
  `CONCURRENTLY` for indexes, expand → backfill (as a workflow) → contract for
  big tables. `migrations.spec.ts` rejects `down()`, missing `lock_timeout`,
  and `ADD COLUMN … NOT NULL DEFAULT` without the safe pattern.
- Every table declares a retention policy and an export policy in column
  metadata; `schema.spec.ts` asserts it against the live schema.
- Timestamps `timestamptz`, UTC. Ids UUIDv7.

---

## 6. DBOS: workflows, jobs, schedules

- **Workflow** = `@DBOS.workflow()` method; **step** = `@DBOS.step({retries…})`.
  Step results are checkpointed; a completed step never re-runs.
- **Job** = a one-step workflow enqueued on a `WorkflowQueue`
  (`DBOS.startWorkflow(Job, { queueName, workflowID }).run(args)`).
  `workflowID` gives idempotent enqueue for free.
- **Schedule** = `@DBOS.scheduled({ crontab })` for static entries; dynamic
  entries live in the `schedules` table (`name, group, crontab, workflow, args,
  enabled, last_run_id, last_status`) and a dispatcher workflow runs each
  minute and starts what is due (`workflowID = name:minute` for dedup). Static
  and dynamic entries appear in one list in `/ops`, grouped.
- **Queues** are defined once in `platform/dbos/queues.ts` (`default`, `mail`,
  `events`, `webhooks-in`, `repayments`…) with concurrency / rate / priority.
- Long waits: `DBOS.sleep()`; human-in-the-loop: `DBOS.recv()` / `DBOS.send()`;
  status exposure: `DBOS.setEvent()` / `getEvent()`.
- Throughput target: thousands of jobs per minute on Postgres. Beyond that a
  project adds Redis + BullMQ as a `QueueBackend` (recipe) for high-volume
  single-step jobs; multi-step work always stays in DBOS.
- `platform/dbos/registry.ts` registers workflow/step methods on Nest providers
  before `DBOS.launch()`; providers are singletons and resolved via `ModuleRef`
  inside steps so recovery on a fresh process works.
- **Every workflow, job and schedule carries ops metadata** via
  `@OpsMeta({ group, description, feature? })`. `group` is a free-form label
  (`payments`, `notifications`, `housekeeping`…) used by `/ops` for grouping and
  filtering; `feature` is inferred from the path. DBOS itself has no notion of
  groups, so the registry builds a `workflowName → { group, description,
  feature, kind: workflow|job|schedule|listener|webhook }` map at boot, and
  `/ops` joins against it. Generators write the decorator; `workflows.spec.ts`
  requires it. The `schedules` table has its own `group` column for dynamic
  entries.
- Housekeeping prunes completed DBOS runs older than N days.

### Example — a loan origination workflow (reference shape)

```ts
export class LoanOriginationWorkflow {
  @DBOS.workflow()
  static async run(i: { loanId: string; applicantId: string; amountMinor: bigint; currency: string }) {
    const kyc = await LoanOriginationWorkflow.verifyIdentity(i.applicantId);          // step, retried
    if (!kyc.passed) { await LoanOriginationWorkflow.markRejected(i.loanId, 'kyc_failed'); throw new LoanRejected(i.loanId, 'kyc_failed'); }

    const score = await LoanOriginationWorkflow.creditScore(i.applicantId, i.amountMinor);
    let approved = score.value >= 720 && i.amountMinor <= 500_000n;
    if (!approved) {
      await LoanOriginationWorkflow.markPendingReview(i.loanId);
      await DBOS.setEvent('status', 'pending_review');
      const d = await DBOS.recv<{ approved: boolean; reason?: string }>('review_decision', 7 * 86400); // waits up to 7 days
      if (!d || !d.approved) { /* reject */ }
    }

    const transfer = await LoanOriginationWorkflow.disburse(i.loanId, i.amountMinor, i.currency, DBOS.workflowID!); // idempotency key = workflow id
    if (transfer.status !== 'settled') { await LoanOriginationWorkflow.reverseTransfer(transfer.id); /* compensation */ }

    for (const [n, inst] of LoanOriginationWorkflow.buildSchedule(i.amountMinor, 12).entries()) {
      await DBOS.startWorkflow(RepaymentWorkflow, { workflowID: `repayment-${i.loanId}-${n + 1}`, queueName: 'repayments' })
        .run({ loanId: i.loanId, instalment: n + 1, dueAt: inst.dueAt, amountMinor: inst.amountMinor });
    }
    await DBOS.setEvent('status', 'active');
  }

  @DBOS.step({ retriesAllowed: true, maxAttempts: 5, intervalSeconds: 10, backoffRate: 2 })
  static async verifyIdentity(applicantId: string) { return kycProvider.verify(applicantId); }
  // …other steps: creditScore, disburse, reverseTransfer, markX (small idempotent DB writes)
}
```

Started from an action with `DBOS.startWorkflow(LoanOriginationWorkflow, { workflowID: \`loan-${id}\`, queueName: 'origination' })`;
approved by `DBOS.send(\`loan-${id}\`, decision, 'review_decision')`. Appears in `/ops → Workflows` as
`loan-… · PENDING · step 5/12 · waiting on review_decision`, with Resume/Fork/Signal actions.

*(Verify DBOS API names against the installed version; the SDK moves between majors.)*

---

## 7. DRY map — the one home for each concern

| Concern | Lives in | Consumed by |
|---|---|---|
| Validation rules | `dtos/*.dto.ts` (zod) | controller pipe · CLI · workflow input · tests · OpenAPI |
| Business logic | `actions/` | controller · workflow steps · commands · `/ops` run-now |
| Authorization | `policies/` | controller guard · `/ops` feature actions |
| Error → HTTP mapping | `PlatformException` subclasses (`type`, `status`) | one global filter |
| Retry/timeout policy | `@DBOS.step({…})` | — |
| Queue definitions | `platform/dbos/queues.ts` | jobs · `/ops` · schedules |
| Correlation ids | logger context (ALS) | every log/error/request row |
| Env schema | `platform/config/schema.ts` | boot · `/ops` config view |
| Retention / export policy | entity column metadata | housekeeping · `schema.spec.ts` |
| Envelope, pagination, problem+json | `platform/http/` | every controller |
| Test helpers | `platform/testing/` | every spec |
| Boilerplate | `stubs/` | `pnpm boot:*` |

### Action contract (inherited from LaravelBoot, still true)

- Takes a typed DTO, returns a domain object. No `Request`/`Response`/`req.user`.
- Failure is a typed exception extending `PlatformException` with a registered
  problem type. Never `null`, never a `Result` to branch on.
- The actor (real/effective) travels on the DTO when an app needs it.
- Assumes an authorized caller; policies run in the adapter.
- Controllers: validate → authorize → call action → format. No DB, no DBOS.

---

## 8. Observability

| Piece | Detail |
|---|---|
| Logs | `nestjs-pino`, JSON, `redact` for `authorization`, `cookie`, `password`, `token`, card-like numbers; context carries `requestId`, `jobId`, `workflowId`, `step`, **`route`** (the Fastify route *pattern*, e.g. `POST /api/loans/:id/approve`, not the concrete URL), `feature`, `group`; `pg-transport` batches into `ops.logs` (partitioned daily) |
| Requests | middleware → `ops.requests` (route pattern, method, status, duration, ids); sampled by `OPS_REQUEST_SAMPLE`; errors and slow requests always kept |
| Errors | global filter → `ops.errors`: fingerprint (type + top frames), count, first/last seen, stack, ids |
| Alerts | `alert_rules` (error rate, failed workflows, stale schedule, queue depth, backup age) evaluated by a scheduled workflow; channels: email, webhook |
| Health | `/health` JSON for orchestrators; same data on `/ops → Health` |
| Config view | resolved config with secrets masked, commit SHA, boot time, runtime versions |
| Housekeeping | scheduled workflows: partition create/drop for every append-only table, DBOS history prune, cache sweep, rate-limit counter prune, nightly `pg_dump` of both DBs → S3, monthly restore-test |

Metrics/Prometheus and OpenTelemetry tracing are **recipes**, added when an
app has real traffic. `/ops` is the "what is wrong" view; Grafana/Tempo is the
"why" view; link out by trace id when present.

---

## 9. Security

### Defaults (all overridable in config)

| Concern | Default | Why |
|---|---|---|
| Headers | helmet on; CSP `default-src 'self'` on `/ops` only | API responses don't render |
| CORS | **deny all** until `CORS_ORIGINS` set; never `*` with credentials | the insecure default is the one people forget |
| Rate limit | 100/min per IP `api`; 10/min `auth`; 5/min + lockout `ops`; high limit `webhooks` | stops credential stuffing without touching product |
| Body | 1 MB JSON, 10 MB multipart, 5 files | |
| Trusted proxy | `false`; must be set to LB CIDR | otherwise clients spoof `X-Forwarded-For` |
| Cookies | HttpOnly, Secure (prod), SameSite=Lax, signed | |
| Validation | zod on every body/query/param; unknown keys stripped | mass-assignment protection |
| Secrets | boot refuses on missing `APP_SECRET`, weak `OPS_PASSWORD`, prod without `TRUST_PROXY` | fail at deploy, not silently |
| `/ops` auth | password + TOTP, argon2, Postgres sessions, 12 h, lockout after 5, optional IP allowlist | |
| Errors | problem+json (RFC 9457), no stacks outside dev | |
| CSRF | `/ops` forms | |
| CI | `pnpm audit --audit-level=high`, lockfile check, `security.spec.ts` asserts every default | security you don't test regresses |

Every layer writes to `ops.security_events`; `/ops → Security` shows auth
failures, lockouts, rate-limit hits, CORS rejections, blocks, active sessions.

### Rate limiting (per user / org ready from day one)

```ts
type RateLimitSubject = { kind: 'ip' | 'user' | 'org' | 'api_key'; id: string };
interface RateLimitSubjectResolver { resolve(req): RateLimitSubject[] } // most specific first
```

- Template ships `IpSubjectResolver`. An app with auth registers its own
  resolver returning `[org, user, ip]`. Nothing else changes.
- Policies live in `app.rate_limit_policies`: `route_group × subject_kind ×
  optional subject_id`, `limit / window_seconds / burst`, `action = reject |
  log_only` (shadow mode), `priority`, `enabled`, `note`.
- Resolution: for each subject, most specific matching policy
  (`subject_id > subject_kind > *`, route group before `*`); **all** subjects
  are checked; the first exhausted wins. Response: 429 problem+json with
  `scope` and `policy`, plus `RateLimit-Limit/Remaining/Reset`, `Retry-After`.
- Store: `ops.rate_limit_counters` (UNLOGGED, sliding window, one upsert);
  policies cached in-process with a version bump on edit. `RateLimitStore` →
  Redis later.
- `/ops → Security → Rate limits`: policies CRUD, per-subject overrides with
  expiry, live top offenders, one-click temporary block, "inspect a subject"
  (resolved chain + remaining budget), shadow mode.
- Route groups are **tags** on controllers (`@RouteGroup('auth')`), not regexes.

---

## 10. Events, cache, webhooks

### Events (day one, minimal)

- `DomainEvent` base: `id` (UUIDv7), `occurredAt`, correlation ids attached
  automatically. Event classes live in the **emitting feature's
  `contracts/events/`** so subscribers import them legally.
- `events.emit(event)` → for every registered listener,
  `DBOS.startWorkflow(listener, { workflowID: \`${event.id}:${listener}\`, queueName: 'events' })`.
  Delivery is durable, retried, deduped, and visible in `/ops → Workflows`
  (`queue = events`). No outbox table, no relay job: the workflow record *is*
  the outbox row.
- Listeners: `@OnEvent(EventClass)` class with `handle(e)`; may import only
  `contracts/`. `events.spec.ts` enforces placement and tests.
- Why day one: without events, the second feature that needs to react to the
  first imports its action directly and breaks the one boundary rule. Events
  make the right move the obvious one.
- Not shipped: event sourcing, Kafka, replay UI.

### Cache (day one, interface + Postgres)

- `cache.get / set / remember(key, ttlSec, fn) / forget / forgetPrefix`.
- `PostgresCacheStore` on `ops.cache` (UNLOGGED). Redis is a swap.
- `/ops → Health`: hit/miss rate, entry count, flush-by-prefix.
- Why day one: the first time an AI needs a cache without an interface it
  writes a module-level `Map` — cross-request state leak in a long-lived
  process. `static-state.spec.ts` now points to `cache.remember()`.

### Webhooks

- **Inbound (day one, `platform/webhooks/inbound/`)** — `POST /webhooks/:provider`
  with raw body, no ops guard, own rate-limit group. Handler does exactly:
  verify signature (per-provider verifier registered by the feature) → insert
  `app.webhook_inbound` row → `DBOS.startWorkflow(ProcessInbound, { workflowID: \`${provider}:${externalId}\`, queueName: 'webhooks-in' })`
  → 200 in milliseconds. The workflow dispatches to the feature via
  `events.emit(...)`. Provider retries collapse into one processing; every
  delivery is visible and replayable (fork) in `/ops`.
- **Outbound (recipe)** — `webhook_endpoints` table + a wildcard listener that
  starts a `DeliverWebhook` job per matching endpoint (HMAC-SHA256 signed,
  timestamped, retried, endpoint auto-disabled after N failures). Product-facing
  management UI is the product's job.

---

## 11. The rulebook — `test/architecture/`

Every test fails with **the rule and the fix**, e.g.
*"controllers may not import from entities/ — move the query into an action
(see features/loans/actions/)."*

| Spec | Asserts |
|---|---|
| `dependency-direction` | features → contracts → platform only |
| `feature-boundaries` | cross-feature imports come from `contracts/` |
| `controllers` | no db/entities/DBOS imports; validate → authorize → act → format |
| `actions` | no Request/Response/`req.user`; DTO in; typed exception out |
| `dtos` | every DTO exports a zod schema; every action has a DTO |
| `workflows` | steps call actions/clients only; no raw `fetch` in workflow body; every workflow has a test |
| `events` | `DomainEvent`s live in `contracts/events/`; listeners import only contracts; every listener has a test |
| `exceptions` | every thrown exception extends `PlatformException` with a registered problem type |
| `static-state` | no module-level mutable state outside the allowlist |
| `migrations` | no `down()`; `lock_timeout` set; no unsafe `ALTER`; conventions for ids/timestamps |
| `schema` | every table has retention + export policy; append-only tables partitioned |
| `security` | CORS denies unknown; `/ops` 401s; rate limit 429s; CSP on `/ops`; cookies flagged |
| `openapi` | generated spec == committed spec |
| `naming` | file ⇄ class ⇄ folder derivable |
| `platform-api` | snapshot of `platform/` public exports — platform changes that break features fail loudly |

---

## 12. Generators

```
pnpm boot:feature   <name>
pnpm boot:action    <feature> <Name>            action · dto · controller method · resource · failing test
pnpm boot:workflow  <feature> <Name>            workflow · step skeleton · failing test
pnpm boot:job       <feature> <Name>            one-step workflow on a queue · failing test
pnpm boot:schedule  <feature> <Name>            scheduled workflow · test
pnpm boot:event     <feature> <Name>            contracts/events/<name>.event.ts
pnpm boot:listener  <feature> <Name> --event=<feature>/<Event>
pnpm boot:webhook   <feature> <provider>        verifier + handler + test
pnpm boot:migration <feature> <name>            forward-only, lock_timeout, CONCURRENTLY
```

Stubs live in `stubs/`. Change the stub, never the generated files.

### The loop every task runs

```
1. read features/<x>/CLAUDE.md
2. pnpm boot:<thing>          never hand-roll the shape
3. make the generated failing test pass
4. pnpm verify                biome · tsc · vitest · depcruise · openapi diff
5. green = done. Red = the message names the rule; fix and rerun.
```

`pnpm verify` is the definition of done. CI runs it verbatim.

---

## 13. Recipes (docs only, per project)

`tenancy` (org_id + RLS, `SET LOCAL` in tx) · `idempotency` (Idempotency-Key
middleware) · `outgoing-webhooks` · `money` (bigint minor units + currency) ·
`product-auth` (sessions/JWT/OAuth/passkeys) · `caching` (when to) · `redis`
(cache/sessions/rate-limit store/BullMQ `QueueBackend`) · `clickhouse-logs`
(`LogStore`) · `read-replicas` · `pgbouncer` · `metrics-tracing` · `pager`
(SLO burn-rate alerts) · `feature-flags` · `cdn-uploads` (presigned S3) ·
`pitr` (WAL archiving + restore test) · `k6` (load tests) · `plan-limits`
(plan → rate-limit policy rows via a scheduled workflow).

Each recipe ends with: *run `pnpm verify`; `<x>.spec.ts` now applies.*

---

## 14. Infrastructure

### Day one (local)

```
docker compose up -d      → one Postgres container; init.sql creates app + ops
pnpm dev                  → one Node process, ROLE=all
                            http://localhost:3000        API
                            http://localhost:3000/ops    the UI
```

### Day one (production, e.g. Neon + Fly/Railway/Render)

```
Neon project           databases: app, ops
                       web  → pooled URLs;  worker → direct URLs (DBOS needs LISTEN/NOTIFY)
web container          ROLE=web
worker container       ROLE=worker      (same image)
S3 / R2 bucket         nightly pg_dump of both DBs (a scheduled workflow, visible in /ops)
external uptime ping   /health
```

Env: `ROLE`, `DATABASE_URL`, `OPS_DATABASE_URL`, `APP_SECRET`, `OPS_PASSWORD`,
`CORS_ORIGINS`, `TRUST_PROXY`, `S3_*`. Deploy = build image → `migrate` (both
DBs) → roll web → roll worker. ≈ $30–50/month.

Neon notes: `UNLOGGED` tables are wiped on compute suspend (fine for
counters/cache); check whether `synchronous_commit=off` is permitted — skip if
not, batching does most of the work; the worker's polling keeps compute awake.

### Scaling path (no `/ops` code changes)

| At | Do |
|---|---|
| ~100k users | `OPS_DATABASE_URL` → separate instance; `DATABASE_READ_URL` → replica |
| Volume queues | Redis + BullMQ implements `QueueBackend`; noisy queues assigned in `queues.ts` |
| Log volume | ClickHouse implements `LogStore`; `RateLimitStore` → Redis |
| Traffic | more web pods; PgBouncer; CDN |
| Incidents | metrics/tracing recipe; pager recipe |

**Explicitly out of scope even at 1M users:** multi-region, Kubernetes vs
managed containers, service mesh, Kafka, search cluster, data warehouse.

---

## 15. `/ops` — the one UI

Server-rendered, one shell, one nav, one guard, one login. Every id links to
every other tab (request → logs; workflow → logs/errors; schedule → its runs).

| Tab | Backed by | Actions |
|---|---|---|
| Workflows | DBOS (`app`) + ops-meta registry | filter by group/feature/kind/status/name/queue/time; search; step detail with I/O; cancel · resume · fork-from-step · signal/event |
| Queues | DBOS queues | per-queue pending/running/failed, grouped by `group`; retry · cancel · bulk cancel · pause |
| Schedules | `schedules` + `@DBOS.scheduled` registry + DBOS history | grouped by `group`; create · edit · enable · run now · history; search |
| Logs | `ops.logs` | filter by level/time/route/feature/group/request/job/workflow; full-text search |
| Errors | `ops.errors` | grouped by fingerprint; filter by route/feature; search; resolve · mute · jump to context |
| Requests | `ops.requests` | by route: volume, error rate, p50/p95; slow/failed; search |
| Health | live checks · `alert_rules` · config · cache | edit alert rules · flush cache prefix |
| Security | `security_events` · `rate_limit_policies` · sessions | block/lift · policies · overrides · inspect subject · shadow mode · revoke session |

Everything is a template over Postgres through the store interfaces. No
third-party dashboard is mounted or proxied.

### UX conventions (apply to every tab)

These are what make `/ops` a tool rather than a table dump. They are
implemented once in `platform/ops/layout/` and reused by every tab.

**Group / route / feature are first-class dimensions.**
- **Logs, Errors, Requests** are viewable *by route*: a left rail lists route
  patterns (`POST /api/loans/:id/approve`) with counts for the current time
  window; clicking one filters the page. The same rail can switch to
  *by feature* (derived from the controller's path) and *by group*.
- **Workflows, Queues, Schedules** are viewable *by group*: `payments`,
  `notifications`, `housekeeping`… from `@OpsMeta`/`schedules.group`. The
  Schedules page opens grouped and collapsed — a `payments` group shows
  "6 schedules · last run 02:00 · 1 failing" before you expand it. A group's
  health is the worst status inside it.
- Groups are free-form labels; the UI offers existing ones as suggestions in
  forms and generators.

**Search on every list page.** One search box, consistent syntax:
- free text → Postgres full-text search on a generated `tsvector` column
  (`ops.logs.search` over `msg` + flattened `ctx`; `ops.errors.search` over
  message + top frames; `ops.requests` over route + ids; workflows over name +
  id + JSON args);
- `key:value` tokens → exact filters: `level:error route:/api/loans/* feature:loans
  group:payments status:failed queue:mail wf:loan-8f3 req:… job:… since:2h before:2026-08-28`;
- exact ids (request/job/workflow) short-circuit to the detail page.
Search state lives in the URL so results are shareable and back-button safe.

**Readable display, not raw rows.**
- Logs render as a **timeline grouped by request/workflow**: one header line
  (route, status, duration or workflow name/status), then its log lines
  indented, level-coloured, with the message first and structured context
  collapsed behind a disclosure. JSON is pretty-printed and key-sorted; long
  values truncate with expand; ids are links; timestamps are relative with the
  absolute on hover; consecutive duplicate lines are collapsed with a `×N`.
- Workflow detail is a **step list with status badges**, elapsed time per step,
  input/output pretty-printed, the failing step's error highlighted, and the
  workflow's log lines interleaved under the step that emitted them.
- Requests by route is a **table with sparklines** (volume, error rate, p95
  over the window) so a regression is visible without opening anything.
- Everything paginates by cursor (`before=<uuidv7>`), supports "live" (auto
  refresh via htmx polling, off by default), and respects a global time-window
  picker (15m · 1h · 24h · 7d · custom) shared across tabs.

**Schema additions that support this** (all in the first migration):
`ops.logs (route, method, status, feature, group, search tsvector)`,
`ops.requests (route, method, feature)`, `ops.errors (route, feature, search)`,
`app.schedules (group)`, and B-tree indexes on `(route, ts)`, `(feature, ts)`,
`(workflow_id, ts)`, GIN on each `search` column — all per-partition.

---

## 16. Build phases

1. **Skeleton** — Nest + Fastify, `ROLE` switch, config schema, two DB pools,
   Drizzle + migration rails, DBOS wrapper + queues + registry, `platform/http`
   (problem+json, `PlatformException`, envelope, zod pipe), health, graceful
   shutdown, Vitest + testcontainers, Biome, dependency-cruiser, `pnpm verify`.
2. **Observability + ops shell** — logging/correlation/pg-transport, requests,
   errors, `schedules` + dispatcher, `/ops` layout + guard (basic), tabs:
   Workflows · Queues · Schedules · Logs.
3. **Security** — headers/CORS/CSRF/body/proxy, rate limiting (subjects,
   policies, store, headers), ops-auth (password + TOTP, sessions, lockout),
   security events, inbound webhooks, tabs: Errors · Requests · Health · Security.
4. **Platform completeness** — cache, events + listeners, alerts,
   housekeeping (partitions, prunes, backup, restore-test), generators + stubs,
   full architecture rulebook, recipes, root `CLAUDE.md`, Dockerfile/compose.

Definition of done for each phase: `pnpm verify` green and the phase's `/ops`
tabs working against the local compose stack.

---

## 17. What NestBoot is deliberately not

Not multi-tenant, not a payments system, not an auth product, not an admin
CRUD generator, not a metrics platform, not a SPA. Those are recipes an app
pastes when it earns them. The template's promise is narrower and stronger:
**one app, one Postgres, one `/ops`, and seams that make growing it boring.**
