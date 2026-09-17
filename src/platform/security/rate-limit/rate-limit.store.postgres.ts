import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OpsDb } from '../../db/ops-db.service.js';
import { toDate } from '../../db/raw.js';
import type { RateLimitHit, RateLimitStore, RateLimitSubject } from '../../stores/stores.js';

/**
 * Counters in the telemetry database, on an UNLOGGED table.
 *
 * Fixed windows rather than a sliding log: a sliding window needs a row per
 * request, which at the volume a rate limiter sees is more write traffic than
 * the application itself. A fixed window admits at most 2× the limit across a
 * boundary, which is the accepted trade and is what almost every limiter does.
 *
 * The whole table is expendable — losing it costs one window of unlimited
 * requests, which is why it can afford to be UNLOGGED and live next to the logs.
 */
@Injectable()
export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly db: OpsDb) {}

  /**
   * One statement: upsert and read back the running count.
   *
   * Doing this as SELECT-then-UPDATE would let two concurrent requests both see
   * `count = limit - 1` and both proceed — the exact race a limiter exists to
   * prevent. `ON CONFLICT DO UPDATE ... RETURNING` is atomic under the row lock.
   */
  async increment(
    subject: RateLimitSubject,
    routeGroup: string,
    windowSeconds: number,
  ): Promise<RateLimitHit> {
    const windowStart = floorWindow(windowSeconds);

    // `window_start` is declared as a string, not a Date: on the raw-execute
    // path drizzle's type parsers return timestamptz as text. Typing it Date
    // here compiled fine and made `hit.windowStart.getTime()` throw on every
    // request — which the limiter's fail-open then swallowed, so the control was
    // silently off. See platform/db/raw.ts.
    const rows = await this.db.write().execute<{ count: number; window_start: string }>(sql`
      INSERT INTO ops.rate_limit_counters (subject_kind, subject_id, route_group, window_start, count)
      VALUES (${subject.kind}, ${subject.id}, ${routeGroup}, ${windowStart}, 1)
      ON CONFLICT (subject_kind, subject_id, route_group, window_start)
      DO UPDATE SET count = ops.rate_limit_counters.count + 1
      RETURNING count, window_start
    `);

    const row = rows.rows[0];
    return {
      count: row?.count ?? 1,
      windowStart: row ? toDate(row.window_start) : windowStart,
    };
  }

  async peek(
    subject: RateLimitSubject,
    routeGroup: string,
    windowSeconds: number,
  ): Promise<RateLimitHit> {
    const windowStart = floorWindow(windowSeconds);
    const rows = await this.db.read().execute<{ count: number }>(sql`
      SELECT count FROM ops.rate_limit_counters
      WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}
        AND route_group = ${routeGroup} AND window_start = ${windowStart}
    `);
    return { count: rows.rows[0]?.count ?? 0, windowStart };
  }

  async reset(subject: RateLimitSubject, routeGroup: string): Promise<void> {
    await this.db.write().execute(sql`
      DELETE FROM ops.rate_limit_counters
      WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}
        AND route_group = ${routeGroup}
    `);
  }

  /** Who is burning the most budget right now — the Security tab's live list. */
  async topOffenders(
    routeGroup: string | undefined,
    limit: number,
  ): Promise<Array<RateLimitSubject & { count: number }>> {
    const since = new Date(Date.now() - 5 * 60_000);
    const rows = await this.db.read().execute<{
      subject_kind: string;
      subject_id: string;
      total: string;
    }>(sql`
      SELECT subject_kind, subject_id, sum(count)::text AS total
      FROM ops.rate_limit_counters
      WHERE window_start >= ${since}
        ${routeGroup ? sql`AND route_group = ${routeGroup}` : sql``}
      GROUP BY subject_kind, subject_id
      ORDER BY 3 DESC
      LIMIT ${limit}
    `);

    return rows.rows.map((row) => ({
      kind: row.subject_kind as RateLimitSubject['kind'],
      id: row.subject_id,
      count: Number(row.total),
    }));
  }

  /** Housekeeping: windows older than an hour can never be read again. */
  async prune(): Promise<number> {
    const result = await this.db.write().execute(sql`
      DELETE FROM ops.rate_limit_counters WHERE window_start < now() - interval '1 hour'
    `);
    return result.rowCount ?? 0;
  }
}

/** The start of the current fixed window, so every pod agrees on the boundary. */
function floorWindow(windowSeconds: number, now = Date.now()): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now / ms) * ms);
}
