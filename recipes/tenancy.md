# Tenancy

**Add it when** the app serves organisations rather than individual users.

**One-way doors: yes.** Adding `org_id` to a table that already has rows means
deciding what the existing rows belong to, and every query written before the
column existed is now a potential cross-tenant leak. Decide this before you have
data, or accept a migration weekend.

NestBoot is deliberately **not** multi-tenant. Tenancy is the clearest example
of the filter: it is right for some apps and dead weight for the rest, and
baking it in would make this a template for one kind of app.

## The shape

1. **Every tenant table carries `org_id` from its first migration.** Not added
   later. A table without it cannot be safely scoped afterwards.

2. **Scope twice: in the application and in Postgres.** Application scoping is
   what you read in the code; row-level security is what saves you the day
   somebody forgets it.

   ```sql
   ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
   ALTER TABLE invoices FORCE ROW LEVEL SECURITY;  -- applies to the owner too

   CREATE POLICY invoices_tenant ON invoices
     USING (org_id = current_setting('app.org_id', true)::uuid);
   ```

   `FORCE` matters: without it the table owner bypasses the policy, and your
   migration role is usually the owner.

3. **Run the app as a non-owner role.** A role that owns the tables is exempt
   from RLS unless forced, and `BYPASSRLS` is worse.

4. **Set the tenant inside a transaction, with `SET LOCAL`:**

   ```ts
   await db.tx(async (tx) => {
     await tx.execute(sql`SET LOCAL app.org_id = ${orgId}`);
     return tx.select().from(invoices);   // scoped by the policy
   });
   ```

   `SET LOCAL`, never `SET`: a plain `SET` outlives the transaction on a pooled
   connection and leaks the previous request's tenant into the next one. This is
   the single most dangerous mistake in this recipe, and it is why
   `AppDb.tx()` exists.

   **A tenant query outside a transaction sees nothing.** That is the correct
   failure: zero rows, not another tenant's rows.

5. **Resolve the organisation at the edge** — a Fastify `onRequest` hook, from
   the subdomain, a header, or the session — and put it on the correlation
   context so every log line carries it.

6. **Put `org_id` on the DTO**, like the actor. An action must not read it from
   ambient state, or it cannot run in a worker.

## Also do this

- Add `org` to the rate-limit subject resolver, so limits are per tenant:
  return `[{kind:'org', id}, {kind:'user', id}, {kind:'ip', id}]`.
- Add `org_id` to `ops.requests` and `ops.logs` and filter /ops by it.
- Write the test that proves it: two organisations, one query, one result.

## Verify

`pnpm verify`. Add a `tenancy.spec.ts` asserting that a query outside a
transaction returns nothing, and that org A cannot read org B.
