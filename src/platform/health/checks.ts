import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ConfigService } from '../config/index.js';
import { AppDb, OpsDb } from '../db/index.js';
import { DbosService } from '../dbos/dbos.service.js';
import type { HealthCheck, HealthCheckResult } from './health.types.js';

async function timed(fn: () => Promise<HealthCheckResult>): Promise<HealthCheckResult> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    return { ...result, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      status: 'down',
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

@Injectable()
export class AppDbCheck implements HealthCheck {
  readonly name = 'database:app';
  readonly critical = true;

  constructor(private readonly db: AppDb) {}

  run(): Promise<HealthCheckResult> {
    return timed(async () => {
      await this.db.read().execute(sql`select 1`);
      const pool = this.db.pool;
      return {
        status: 'ok',
        data: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      };
    });
  }
}

@Injectable()
export class OpsDbCheck implements HealthCheck {
  readonly name = 'database:ops';
  /**
   * Not critical: losing telemetry must never take the product offline. The
   * whole point of the second database is that this failure is survivable.
   */
  readonly critical = false;

  constructor(private readonly db: OpsDb) {}

  run(): Promise<HealthCheckResult> {
    return timed(async () => {
      await this.db.read().execute(sql`select 1`);
      const pool = this.db.pool;
      return {
        status: 'ok',
        data: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      };
    });
  }
}

/**
 * Queue depth and the engine's reachability.
 *
 * A web process reports depth too — it can read the queues even though it can
 * never drain them, and a web process that cannot see the queue table is worth
 * knowing about.
 */
@Injectable()
export class WorkflowEngineCheck implements HealthCheck {
  readonly name = 'workflows';
  readonly critical = false;

  constructor(
    private readonly dbos: DbosService,
    private readonly config: ConfigService,
  ) {}

  run(): Promise<HealthCheckResult> {
    return timed(async () => {
      const runtime = this.dbos.runtimeOrNull();
      if (!runtime) {
        return { status: 'unknown', detail: 'the workflow engine has not finished starting' };
      }

      const [pending, failed] = await Promise.all([
        runtime.list({ queuedOnly: true, limit: 500 }),
        runtime.list({ status: 'ERROR', limit: 100, startTime: hoursAgo(1) }),
      ]);

      const byQueue: Record<string, number> = {};
      for (const wf of pending) {
        const queue = wf.queueName ?? 'none';
        byQueue[queue] = (byQueue[queue] ?? 0) + 1;
      }

      return {
        status: 'ok',
        data: {
          executes: this.config.runsWorkflows,
          pending: pending.length,
          failedLastHour: failed.length,
          byQueue,
        },
      };
    });
  }
}

/**
 * A schedule that has not fired since well past its interval is the failure
 * nothing else reports: no error is thrown when a cron simply stops.
 */
@Injectable()
export class ScheduleFreshnessCheck implements HealthCheck {
  readonly name = 'schedules';
  readonly critical = false;

  constructor(private readonly dbos: DbosService) {}

  run(): Promise<HealthCheckResult> {
    return timed(async () => {
      const runtime = this.dbos.runtimeOrNull();
      if (!runtime) {
        return { status: 'unknown', detail: 'the workflow engine has not finished starting' };
      }

      const schedules = await runtime.schedules();
      const active = schedules.filter((s) => s.status.toUpperCase() !== 'PAUSED');
      const stale = active.filter(
        (s) => s.lastFiredAt !== null && Date.now() - s.lastFiredAt.getTime() > 26 * 3_600_000,
      );
      // A schedule that has never fired is not yet evidence of anything — it may
      // have been created a minute ago — so it is reported, not counted stale.
      const neverFired = active.filter((s) => s.lastFiredAt === null);

      return {
        status: stale.length > 0 ? 'degraded' : 'ok',
        detail:
          stale.length > 0
            ? `${stale.length} schedule(s) have not run in over a day: ${stale
                .map((s) => s.name)
                .join(', ')}`
            : undefined,
        data: {
          total: schedules.length,
          paused: schedules.length - active.length,
          neverFired: neverFired.length,
        },
      };
    });
  }
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}
