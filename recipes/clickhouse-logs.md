# ClickHouse for logs

**Add it when** `ops.logs` outgrows Postgres — typically when the daily
partition stops fitting comfortably in memory, or retention has to shrink below
what you want to keep.

**One-way doors: none** for the code. The data is another matter: plan whether
you backfill history or run both for a retention period.

## How

Implement `LogStore` and swap the provider:

```ts
@Injectable()
export class ClickHouseLogStore implements LogStore {
  query(query: LogQuery): Promise<CursorPage<LogRecord>> { /* … */ }
  facets(dimension, query): Promise<FacetCount[]> { /* … */ }
  countsByLevel(query): Promise<Record<number, number>> { /* … */ }
}
```

```ts
{ provide: LOG_STORE, useClass: ClickHouseLogStore }
```

The Logs tab reads the interface, so no page changes. Point the pino destination
at ClickHouse the same way `OpsLogStream` points at Postgres — keep the
`BatchWriter`, it already does the batching, bounded buffering and
drop-reporting you need.

## Keep

- **stdout.** Always. The console cannot report on the database it reads from
  being down; an outside observer reading container logs is what still works.
- **`ops.errors` and `ops.requests` in Postgres**, at least at first. They are
  far smaller than logs and the console joins them to workflow rows.

## Watch out

ClickHouse deduplication is asynchronous and eventual. Do not build anything on
"exactly one row"; logs are for reading, not for counting money.
