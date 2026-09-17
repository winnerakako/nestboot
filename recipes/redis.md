# Redis

**Add it when** measurement says Postgres is the bottleneck for cache reads or
rate-limit counters — not before. Redis is a second thing to run, monitor, back
up and fail over.

**One-way doors: none.** Every one of these is an interface with a Postgres
implementation shipped. Swapping is a provider.

## What can move

| Interface | Postgres today | Move when |
|---|---|---|
| `CacheStore` | `ops.cache` (UNLOGGED) | cache reads show up in `pg_stat_statements` |
| `RateLimitStore` | `ops.rate_limit_counters` | the counter upsert is a hot row |
| `QueueBackend` | DBOS on Postgres | thousands of single-step jobs a minute |

## How

```ts
@Injectable()
export class RedisCacheStore implements CacheStore { /* … */ }
```

```ts
{ provide: CACHE_STORE, useClass: RedisCacheStore }
```

That is the entire change. `/ops` reads the interface, so no page is touched.

## What must not move

**DBOS stays on Postgres.** Its checkpoints are written in the same transaction
as your product rows — that is precisely what makes a step's effects
exactly-once. Split them across two datastores and you have a distributed commit
problem and no exactly-once guarantee.

For high-volume *single-step* jobs, add BullMQ as a `QueueBackend` and assign
only the noisy queues to it in `queues.ts`. Multi-step work stays in DBOS: a
BullMQ job is atomic, so a crash re-runs it from the start.

## Remember

Redis is not durable by default. Rate-limit counters and cache tolerate loss —
that is why they are the two things that move first. Sessions do not; leave
those in Postgres unless you have configured persistence and understand what you
lose on failover.
