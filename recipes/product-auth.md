# Product auth

**Add it when** end users sign in. This is *not* `/ops` auth — that already
exists, is operator-only, and should stay separate. Do not reuse `ops_users` for
customers; the console can cancel workflows.

**One-way doors: some.** The session mechanism (cookie vs bearer) leaks into
every client. The password hash does not — it can be upgraded on next login.

## What to reuse

Most of the hard parts are already in `platform/security/`:

- **argon2id at OWASP's floor** — copy the parameters from `OpsUsers`.
- **Sessions as rows, not JWTs.** `OpsSessions` is the model: store the SHA-256
  of the token, never the token. The reason is revocation — "log everyone out
  now" must be one statement, and a stateless token cannot be withdrawn.
- **Lockout in the increment statement**, so concurrent attempts cannot both
  read one-below-the-threshold.
- **Identical responses for unknown user and wrong password**, both paying the
  hash cost. Anything else is an account-enumeration oracle.

## What to add

1. A `users` table. Keep it separate from `ops_users`.
2. A guard that resolves the session and puts the actor on the request.
3. **Put the actor on the DTO**, so actions stay runnable in a worker:

   ```ts
   export const CreateInvoiceSchema = z.object({
     actor: ActorSchema,       // who is really acting
     // …
   });
   ```

   If you support impersonation, carry a real/effective pair — that is what
   keeps an audit trail honest.

4. Register a rate-limit subject resolver so limits are per user, not per IP.
   **This is the whole reason that seam exists:**

   ```ts
   { provide: RATE_LIMIT_RESOLVER, useClass: UserSubjectResolver }
   ```

   ```ts
   resolve(request) {
     const actor = request.actor;
     return actor
       ? [{ kind: 'user', id: actor.id }, { kind: 'ip', id: request.ip }]
       : [{ kind: 'ip', id: request.ip }];
   }
   ```

   Nothing else changes: no page, no guard, no table.

5. Tag the login routes `@RouteGroup(RouteGroups.auth)`, which is already
   limited to 10/min.

## Do not

- Do not put a long-lived bearer token on `/ops`. Deliberately absent.
- Do not skip the second factor for admin-equivalent users.
- Do not log the attempted password, ever — not even on failure. A spray attempt
  is the last thing you want durably stored.
