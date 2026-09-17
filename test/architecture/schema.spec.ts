import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as opsSchema from '../../src/platform/db/schema/ops.js';
import { useTestDatabases } from '../setup/database.js';
import { ruleFailure } from './support.js';

/**
 * The Drizzle declarations and the migrations are two descriptions of one
 * schema, so they can disagree — and when they do, the failure is a query that
 * compiles and then throws at runtime against a column that was never created.
 *
 * This checks them against a live database, which is the only arbiter.
 */
interface TableMeta {
  name: string;
  schema?: string;
  columns: Record<string, { name: string }>;
}

/**
 * Drizzle keeps a table's metadata on a `_` property. The schema module also
 * exports the `pgSchema('ops')` object itself, which has no `_` — hence the
 * filter rather than a blanket cast.
 */
function tables(): Array<[string, TableMeta]> {
  return Object.entries(opsSchema as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'object' && value !== null && '_' in value)
    .map(([name, value]) => [name, (value as { _: TableMeta })._]);
}

describe('the schema matches what the code expects', () => {
  const databases = useTestDatabases();
  let ops: Client;

  beforeAll(async () => {
    ops = new Client({ connectionString: databases.opsUrl });
    await ops.connect();
  });

  afterAll(async () => {
    await ops.end();
  });

  it('creates every ops table the Drizzle schema declares', async () => {
    const declared = tables().map(([, meta]) => meta.name);

    const { rows } = await ops.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema IN ('ops', 'public')`,
    );
    const live = new Set(rows.map((row) => row.table_name));

    const missing = declared.filter((name) => !live.has(name));

    expect(
      missing,
      ruleFailure(
        'A table is declared in Drizzle but no migration creates it.',
        missing,
        'add the migration. A declared-but-uncreated table typechecks perfectly and throws on ' +
          'the first query that touches it, in production.',
      ),
    ).toEqual([]);
  });

  it('declares every ops column that the migration creates', async () => {
    const offenders: string[] = [];

    for (const [exportName, meta] of tables()) {
      if (meta.schema !== 'ops') continue;

      const declared = new Set(Object.values(meta.columns).map((column) => column.name));
      const { rows } = await ops.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'ops' AND table_name = $1`,
        [meta.name],
      );

      for (const row of rows) {
        // `search` is a generated tsvector nothing reads through Drizzle; it is
        // matched in raw SQL with plainto_tsquery.
        if (row.column_name === 'search') continue;
        if (!declared.has(row.column_name)) {
          offenders.push(
            `${exportName}: the table has "${row.column_name}" but the schema does not`,
          );
        }
      }
    }

    expect(
      offenders,
      ruleFailure(
        'A column exists in the database but is missing from the Drizzle table.',
        offenders,
        'add it. An undeclared column cannot be selected or written through the query builder, ' +
          'so it is dead weight that still costs storage on every row.',
      ),
    ).toEqual([]);
  });

  it('partitions every append-only table, because retention is DROP PARTITION', async () => {
    const APPEND_ONLY = ['logs', 'requests', 'errors', 'security_events'];

    const { rows } = await ops.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'ops' AND c.relkind = 'p'`,
    );
    const partitioned = new Set(rows.map((row) => row.relname));
    const offenders = APPEND_ONLY.filter((name) => !partitioned.has(name));

    expect(
      offenders,
      ruleFailure(
        'An append-only telemetry table is not partitioned.',
        offenders,
        'declare it PARTITION BY RANGE (ts) in its migration. Retention on these is dropping a ' +
          'partition; a DELETE at this volume produces more WAL than the writes it removes and ' +
          'leaves bloat only VACUUM FULL reclaims. Adding partitioning later rewrites the table.',
      ),
    ).toEqual([]);
  });

  it('indexes every append-only table on its time column, so a window can prune', async () => {
    const { rows } = await ops.query<{ tablename: string; indexdef: string }>(
      `SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'ops'`,
    );

    const offenders = ['logs', 'requests', 'errors', 'security_events'].filter(
      (table) => !rows.some((row) => row.tablename === table && row.indexdef.includes('(ts')),
    );

    expect(offenders).toEqual([]);
  });
});
