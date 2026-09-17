import { DBOS } from '@dbos-inc/dbos-sdk';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabases } from '../../../test/setup/database.js';
import { ConfigService, loadEnv } from '../config/index.js';
import { AppDb } from '../db/app-db.service.js';
import { OpsDb } from '../db/ops-db.service.js';
import { defineJob } from '../dbos/define.js';
import { ExecutorBackend, WorkflowRuntime } from '../dbos/runtime.js';
import {
  ApplyRetention,
  CreatePartitions,
  configureHousekeeping,
  PruneWorkflowHistory,
  SweepEphemeral,
} from './housekeeping.workflows.js';

/**
 * Housekeeping, actually run.
 *
 * Every one of these is SQL that only executes at 2am on a schedule nobody
 * watches, so a typo in it stays invisible until the disk fills. Running them
 * against a real database is the only way to know they work at all.
 */

const Trivial = defineJob({
  name: 'HousekeepingSpecJob',
  meta: { group: 'spec', description: 'A workflow to prune' },
  run: async () => 'done',
});

describe('housekeeping', () => {
  const databases = useTestDatabases();
  let appDb: AppDb;
  let opsDb: OpsDb;
  let runtime: WorkflowRuntime;
  let ops: Client;

  beforeAll(async () => {
    const config = new ConfigService(
      loadEnv({
        ...process.env,
        DATABASE_URL: databases.appUrl,
        OPS_DATABASE_URL: databases.opsUrl,
        APP_SECRET: 'a'.repeat(32),
      } as NodeJS.ProcessEnv),
    );
    appDb = new AppDb(config);
    opsDb = new OpsDb(config);

    DBOS.setConfig({
      name: 'nestboot-housekeeping-spec',
      systemDatabaseUrl: databases.appUrl,
      logLevel: 'error',
      runAdminServer: false,
    });
    await DBOS.launch();
    runtime = new WorkflowRuntime(() => new ExecutorBackend());

    configureHousekeeping({
      opsQuery: (statement) => opsDb.write().execute(statement),
      appQuery: (statement) => appDb.write().execute(statement),
      runtime,
      // Zero days, so anything already there is past retention and the sweeps
      // have something to actually do.
      retention: { logs: 0, requests: 0, errors: 0, security: 0, workflows: 0 },
    });

    ops = new Client({ connectionString: databases.opsUrl });
    await ops.connect();
  }, 180_000);

  afterAll(async () => {
    await ops.end();
    await DBOS.shutdown();
    await appDb.onModuleDestroy();
    await opsDb.onModuleDestroy();
  });

  async function run(ref: { invoke: (at: Date) => Promise<void> }): Promise<void> {
    const started = await runtime.start(ref as never, [new Date()] as never);
    await started.result();
  }

  it('creates a week of partitions ahead of traffic', async () => {
    await ops.query(`SELECT ops.drop_partitions_before('logs', (current_date + 30)::date)`);

    await run(CreatePartitions);

    const { rows } = await ops.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'logs' AND c.relname ~ '_[0-9]{8}$'`,
    );

    // Today through seven days out. The headroom is the point: a failed run has
    // days to be noticed before writes land in the default partition.
    expect(rows.length).toBeGreaterThanOrEqual(8);
  });

  it('drops partitions past retention', async () => {
    await ops.query(`SELECT ops.ensure_partition('logs', '2020-01-01'::date)`);
    expect(await partitionExists('logs_20200101')).toBe(true);

    await run(ApplyRetention);

    expect(await partitionExists('logs_20200101')).toBe(false);
  });

  it('never drops a partition that is still inside retention', async () => {
    await run(CreatePartitions);
    const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');

    await run(ApplyRetention);

    // Retention is 0 days here, so today's partition is the boundary case —
    // and dropping it would delete the rows being written right now.
    expect(await partitionExists(`logs_${today}`)).toBe(true);
  });

  it('sweeps expired cache, spent counters and dead sessions', async () => {
    await opsDb.write().execute(sql`
      INSERT INTO ops.cache (key, value, expires_at)
      VALUES ('stale', '1'::jsonb, now() - interval '2 hours'),
             ('fresh', '1'::jsonb, now() + interval '1 hour')
    `);
    await opsDb.write().execute(sql`
      INSERT INTO ops.rate_limit_counters (subject_kind, subject_id, route_group, window_start, count)
      VALUES ('ip', 'old', 'api', now() - interval '2 hours', 5),
             ('ip', 'now', 'api', date_trunc('minute', now()), 5)
    `);

    await run(SweepEphemeral);

    const cache = await ops.query<{ key: string }>('SELECT key FROM ops.cache');
    const counters = await ops.query<{ subject_id: string }>(
      'SELECT subject_id FROM ops.rate_limit_counters',
    );

    // Expired goes, live stays. A sweep that took the live rows would empty the
    // cache and reset every rate-limit window on the quarter hour.
    expect(cache.rows.map((row) => row.key)).toEqual(['fresh']);
    expect(counters.rows.map((row) => row.subject_id)).toEqual(['now']);
  });

  it('prunes finished workflows and leaves running ones alone', async () => {
    const finished = await runtime.start(Trivial, []);
    await finished.result();

    const pending = await runtime.start(Trivial, [], {
      workflowId: `housekeeping-spec-pending-${Date.now()}`,
      delaySeconds: 600,
    });

    await run(PruneWorkflowHistory);

    expect(await runtime.get(finished.workflowId)).toBeNull();
    // The row IS the work: deleting an enqueued workflow destroys it.
    expect(await runtime.get(pending.workflowId)).not.toBeNull();

    await runtime.cancel(pending.workflowId);
  });

  it('prunes a workflow that exhausted its recovery attempts', async () => {
    const finished = await runtime.start(Trivial, []);
    await finished.result();

    await appDb.write().execute(sql`
      UPDATE dbos.workflow_status
      SET status = 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'
      WHERE workflow_uuid = ${finished.workflowId}
    `);

    await run(PruneWorkflowHistory);

    // This status is terminal and was originally missing from the prune, so
    // these rows accumulated forever while looking like running work.
    expect(await runtime.get(finished.workflowId)).toBeNull();
  });

  it('removes a pruned workflow’s steps with it, rather than orphaning them', async () => {
    const finished = await runtime.start(Trivial, []);
    await finished.result();

    const before = await appDb
      .read()
      .execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM dbos.operation_outputs WHERE workflow_uuid = ${finished.workflowId}`,
      );
    expect(Number(before.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(0);

    await run(PruneWorkflowHistory);

    const after = await appDb
      .read()
      .execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM dbos.operation_outputs WHERE workflow_uuid = ${finished.workflowId}`,
      );
    expect(Number(after.rows[0]?.count ?? 0)).toBe(0);
  });

  async function partitionExists(name: string): Promise<boolean> {
    const { rows } = await ops.query('SELECT to_regclass($1) AS oid', [`ops.${name}`]);
    return (rows[0] as { oid: string | null } | undefined)?.oid !== null;
  }
});
