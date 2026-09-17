# Plan limits

**Add it when** pricing tiers imply different rate limits.

**One-way doors: none.** This is data.

## It is already built

`rate_limit_policies` resolves most-specific-first:
`subject_id` > `subject_kind` > `*`. A per-customer limit is a row:

```sql
INSERT INTO rate_limit_policies
  (id, route_group, subject_kind, subject_id, max_requests, window_seconds, priority, note)
VALUES
  (gen_random_uuid(), 'api', 'org', '<org-id>', 10000, 60, 0, 'enterprise plan');
```

## Keep it in sync with a schedule

```ts
export const SyncPlanLimits = defineSchedule({
  name: 'SyncPlanLimits',
  meta: { group: 'billing', description: 'Reconcile rate-limit policy with plans' },
  crontab: '*/10 * * * *',
  run: async () => {
    for (const org of await orgsWithChangedPlans()) {
      await step(`sync:${org.id}`, () =>
        policies.upsert({
          routeGroup: 'api',
          subjectKind: 'org',
          subjectId: org.id,
          maxRequests: PLAN_LIMITS[org.plan],
          windowSeconds: 60,
          action: 'reject',
          priority: 0,
          enabled: true,
          burst: null,
          note: `plan: ${org.plan}`,
          expiresAt: null,
        }),
      );
    }
  },
});
```

Reconcile on a schedule rather than writing the row on upgrade: an upgrade whose
webhook was missed otherwise leaves a paying customer on the free limit, and
nothing notices.

## Roll it out in shadow first

Set `action: 'log_only'` and watch `/ops → Security`. It records what *would*
have been blocked without blocking it. When the would-block count is only the
customers you expect, flip to `reject`.

Tightening a limit on live customers without this step is how you find out which
integrations were quietly hammering you — by breaking them.

## Remember

You need a resolver that returns an `org` subject; see
[product-auth](./product-auth.md).
