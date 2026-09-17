import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { OpsDb } from '../db/ops-db.service.js';
import { toDate } from '../db/raw.js';
import {
  type CursorPage,
  decodeTimeCursor,
  encodeTimeCursor,
  fetchLimit,
  toCursorPage,
} from '../http/cursor.js';
import type { FacetCount, LogQuery, LogRecord, LogStore } from '../stores/stores.js';

/** Nothing reads the whole table. An unwindowed query cannot prune partitions. */
export const DEFAULT_WINDOW_HOURS = 24;
const MAX_FACETS = 40;

@Injectable()
export class PostgresLogStore implements LogStore {
  constructor(private readonly db: OpsDb) {}

  async query(query: LogQuery): Promise<CursorPage<LogRecord>> {
    const limit = query.limit ?? 50;
    const rows = await this.db.read().execute<RawLog>(sql`
      SELECT id, ts, level, msg, ctx, request_id, workflow_id, job_id, step,
             trace_id, route, method, status, feature, group_name
      FROM ops.logs
      WHERE ${this.predicate(query)}
      ORDER BY ts DESC, id DESC
      LIMIT ${fetchLimit(limit)}
    `);

    return toCursorPage(rows.rows.map(toRecord), limit, (row) => encodeTimeCursor(row.ts, row.id));
  }

  async facets(dimension: 'route' | 'feature' | 'group', query: LogQuery): Promise<FacetCount[]> {
    const column =
      dimension === 'route' ? sql`route` : dimension === 'feature' ? sql`feature` : sql`group_name`;

    const rows = await this.db.read().execute<{ value: string; count: string }>(sql`
      SELECT ${column} AS value, count(*)::text AS count
      FROM ops.logs
      WHERE ${this.predicate({ ...query, cursor: undefined })} AND ${column} IS NOT NULL
      GROUP BY ${column}
      ORDER BY count(*) DESC
      LIMIT ${MAX_FACETS}
    `);

    return rows.rows.map((r) => ({ value: r.value, count: Number(r.count) }));
  }

  async countsByLevel(query: LogQuery): Promise<Record<number, number>> {
    const rows = await this.db.read().execute<{ level: number; count: string }>(sql`
      SELECT level, count(*)::text AS count
      FROM ops.logs
      WHERE ${this.predicate({ ...query, cursor: undefined, levels: undefined, minLevel: undefined })}
      GROUP BY level
    `);

    return Object.fromEntries(rows.rows.map((r) => [r.level, Number(r.count)]));
  }

  private predicate(query: LogQuery): SQL {
    const since = query.since ?? new Date(Date.now() - DEFAULT_WINDOW_HOURS * 3_600_000);
    const parts: SQL[] = [sql`ts >= ${since}`];

    if (query.before) parts.push(sql`ts < ${query.before}`);

    const cursor = query.cursor ? decodeTimeCursor(query.cursor) : null;
    if (cursor) {
      // Row-value comparison matches the (ts DESC, id DESC) ordering exactly and
      // still prunes on ts, which a chain of ORs would not.
      parts.push(sql`(ts, id) < (${cursor.ts}, ${cursor.id}::uuid)`);
    }

    if (query.minLevel !== undefined) parts.push(sql`level >= ${query.minLevel}`);
    if (query.levels?.length) parts.push(sql`level = ANY(${query.levels})`);
    if (query.route) parts.push(sql`route = ${query.route}`);
    if (query.feature) parts.push(sql`feature = ${query.feature}`);
    if (query.group) parts.push(sql`group_name = ${query.group}`);
    if (query.requestId) parts.push(sql`request_id = ${query.requestId}`);
    if (query.workflowId) parts.push(sql`workflow_id = ${query.workflowId}`);
    if (query.jobId) parts.push(sql`job_id = ${query.jobId}`);

    if (query.search) {
      // Intentional: plainto_tsquery with the 'simple' dictionary, matching the
      // generated column. 'english' would stem the query terms while the index
      // holds unstemmed ones, and the search would silently return nothing.
      parts.push(sql`search @@ plainto_tsquery('simple', ${query.search})`);
    }

    return sql.join(parts, sql` AND `);
  }
}

interface RawLog {
  // Index signature: drizzle's execute<T>() requires a row type it can
  // treat as a record. The named fields above are what we actually read.
  [column: string]: unknown;
  id: string;
  ts: string;
  level: number;
  msg: string;
  ctx: Record<string, unknown>;
  request_id: string | null;
  workflow_id: string | null;
  job_id: string | null;
  step: string | null;
  trace_id: string | null;
  route: string | null;
  method: string | null;
  status: number | null;
  feature: string | null;
  group_name: string | null;
}

function toRecord(row: RawLog): LogRecord {
  return {
    id: row.id,
    ts: toDate(row.ts),
    level: row.level,
    msg: row.msg,
    ctx: row.ctx ?? {},
    requestId: row.request_id,
    workflowId: row.workflow_id,
    jobId: row.job_id,
    step: row.step,
    traceId: row.trace_id,
    route: row.route,
    method: row.method,
    status: row.status,
    feature: row.feature,
    group: row.group_name,
  };
}
