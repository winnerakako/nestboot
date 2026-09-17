# Recipes

A recipe is a short document you follow when — and only when — your app has
earned the feature. Nothing here is installed; everything here is a decision
you make once, with the one-way doors named up front.

The filter for what is in `platform/` instead of here: **every app needs it on
day one, AND it is painful to add on day 100.** Everything else is a recipe.

| Recipe | Add it when | One-way doors |
|---|---|---|
| [tenancy](./tenancy.md) | the app serves organisations, not just users | yes — the schema |
| [product-auth](./product-auth.md) | end users sign in (`/ops` auth is separate) | some |
| [money](./money.md) | you store an amount | yes — the column type |
| [idempotency](./idempotency.md) | clients retry writes | no |
| [outgoing-webhooks](./outgoing-webhooks.md) | customers want to be notified | no |
| [redis](./redis.md) | Postgres-backed cache or counters become the bottleneck | no |
| [read-replicas](./read-replicas.md) | reads dominate and lag is acceptable | no |
| [clickhouse-logs](./clickhouse-logs.md) | `ops.logs` outgrows Postgres | no |
| [metrics-tracing](./metrics-tracing.md) | you need "why is it slow", not "what is broken" | no |
| [plan-limits](./plan-limits.md) | pricing tiers imply different rate limits | no |
