# Read replicas

**Add it when** reads dominate and you have queries that tolerate lag.

**One-way doors: none.** `db.read()` and `db.write()` are separate from the
first commit precisely so this is a URL.

## How

```
DATABASE_READ_URL=postgres://…@replica/app
```

That is it. `AppDb` builds a second pool and `read()` uses it.

## The part that is actually work

**Auditing which queries may be stale.** A replica is asynchronous: a read
immediately after a write may not see it.

- `read()` — anything that tolerates being a few hundred milliseconds behind:
  lists, dashboards, search, reports.
- `write()` — anything read-modify-write, anything a user just changed and is
  about to look at, anything a uniqueness check depends on.

The read-your-own-writes problem is the one that will bite: a user updates their
profile, is redirected, and sees the old value. Route that read to `write()`, or
hold the user on the primary for a few seconds after a write.

**Never** do a uniqueness check against a replica. The window between the check
and the insert is exactly where the duplicate gets in — and the database
constraint is what actually protects you anyway.

## Remember

DBOS keeps using the primary: its system tables are transactional state, not
cacheable reads.
