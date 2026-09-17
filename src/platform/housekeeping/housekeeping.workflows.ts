import { sql } from 'drizzle-orm';
import { defineSchedule, step } from '../dbos/define.js';
import { Queues } from '../dbos/queues.js';
import type { WorkflowRuntime } from '../dbos/runtime.js';

/**
 * The work that keeps the telemetry database from becoming the problem.
 *
 * These are ordinary scheduled workflows, on the housekeeping queue, visible in
 * /ops like everything else — deliberately, because maintenance that runs
 * invisibly is maintenance nobody notices has stopped, and the first symptom of
 * that is a disk filling up at 3am.
 *
 * Wired to real services by `HousekeepingModule`, which is the only thing that
 * may set these.
 */
interface HousekeepingDeps {
  opsQuery: (statement: ReturnType<typeof sql>) => Promise<{ rows: Record<string, unknown>[] }>;
  appQuery: (statement: ReturnType<typeof sql>) => Promise<{ rowCount: number | null }>;
  runtime: WorkflowRuntime;
  retention: {
    logs: number;
    requests: number;
    errors: number;
    security: number;
    workflows: number;
  };
}

let deps: HousekeepingDeps | undefined;

export function configureHousekeeping(value: HousekeepingDeps): void {
  deps = value;
}

function required(): HousekeepingDeps {
  if (!deps) {
    throw new Error(
      'Housekeeping ran before it was configured.\n' +
        'FIX: HousekeepingModule calls configureHousekeeping() at boot; a worker that runs ' +
        'these schedules must import it.',
    );
  }
  return deps;
}

const PARTITIONED = ['logs', 'requests', 'errors', 'security_events'] as const;

/**
 * Create tomorrow's partitions, a week ahead.
 *
 * A week of headroom, not a day: if this job fails, nobody finds out at the
 * moment inserts start landing in the default partition — they find out from
 * the alert, with days to spare.
 */
export const CreatePartitions = defineSchedule({
  name: 'CreatePartitions',
  meta: { group: 'housekeeping', description: 'Create upcoming daily partitions' },
  crontab: '0 2 * * *',
  queue: Queues.housekeeping,
  run: async () => {
    const { opsQuery } = required();

    for (const table of PARTITIONED) {
      await step(`ensure:${table}`, async () => {
        for (let offset = 0; offset <= 7; offset++) {
          // The ::int casts are load-bearing. A bound parameter arrives as
          // `unknown`, and `current_date + unknown` is ambiguous to Postgres —
          // it could mean `date + integer` or `date + interval` — so it fails
          // with "could not choose a best candidate operator" rather than
          // guessing. Both of these ran only on a nightly schedule, so the
          // error would have surfaced as a disk filling up.
          await opsQuery(
            sql`SELECT ops.ensure_partition(${table}::text, (current_date + ${offset}::int)::date)`,
          );
        }
      });
    }
  },
});

/**
 * Drop partitions past their retention.
 *
 * `DROP TABLE` on a partition is a catalogue update. The same deletion as a
 * `DELETE` would produce more WAL than the writes it removes and leave bloat
 * that only `VACUUM FULL` reclaims — which is why these tables were partitioned
 * in the very first migration.
 */
export const ApplyRetention = defineSchedule({
  name: 'ApplyRetention',
  meta: { group: 'housekeeping', description: 'Drop telemetry partitions past retention' },
  crontab: '30 2 * * *',
  queue: Queues.housekeeping,
  run: async () => {
    const { opsQuery, retention } = required();

    const windows: Array<[(typeof PARTITIONED)[number], number]> = [
      ['logs', retention.logs],
      ['requests', retention.requests],
      ['errors', retention.errors],
      ['security_events', retention.security],
    ];

    for (const [table, days] of windows) {
      await step(`drop:${table}`, async () => {
        const result = await opsQuery(
          sql`SELECT * FROM ops.drop_partitions_before(${table}::text, (current_date - ${days}::int)::date)`,
        );
        return result.rows.length;
      });
    }
  },
});

/** Expired cache rows, spent rate-limit windows, dead sessions. */
export const SweepEphemeral = defineSchedule({
  name: 'SweepEphemeral',
  meta: { group: 'housekeeping', description: 'Sweep expired cache, counters and sessions' },
  crontab: '*/15 * * * *',
  queue: Queues.housekeeping,
  run: async () => {
    const { opsQuery, appQuery } = required();

    await step('cache', async () => {
      await opsQuery(sql`DELETE FROM ops.cache WHERE expires_at < now() - interval '1 hour'`);
    });

    await step('rate-limit-counters', async () => {
      await opsQuery(
        sql`DELETE FROM ops.rate_limit_counters WHERE window_start < now() - interval '1 hour'`,
      );
    });

    await step('sessions', async () => {
      await appQuery(sql`DELETE FROM ops_sessions WHERE expires_at < now() - interval '7 days'`);
    });
  },
});

/**
 * Prune finished workflow history.
 *
 * Goes through the DBOS wrapper rather than issuing SQL against the engine's
 * own tables. Those tables are the vendor's private schema: a raw DELETE there
 * couples a schedule to an internal layout, and would silently orphan a
 * workflow's steps, messages and events the day that layout changed.
 *
 * Intentional: only terminal workflows, and only past retention. Deleting a
 * PENDING or ENQUEUED row would destroy in-flight work — the row *is* the work.
 */
export const PruneWorkflowHistory = defineSchedule({
  name: 'PruneWorkflowHistory',
  meta: { group: 'housekeeping', description: 'Prune completed workflow history' },
  crontab: '0 3 * * *',
  queue: Queues.housekeeping,
  run: async () => {
    const { runtime, retention } = required();
    const cutoff = new Date(Date.now() - retention.workflows * 86_400_000);

    // Batched, and repeated until a batch comes back short: one unbounded
    // DELETE over a year of backlog is a long lock on the table every running
    // workflow also writes to.
    let removed = 0;
    for (let batch = 0; batch < 20; batch++) {
      const deleted = await step(`prune:${batch}`, () => runtime.pruneHistory(cutoff));
      removed += deleted;
      if (deleted === 0) break;
    }

    await step('report', async () => removed);
  },
});

export const HOUSEKEEPING_SCHEDULES = [
  CreatePartitions,
  ApplyRetention,
  SweepEphemeral,
  PruneWorkflowHistory,
];
