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
import type {
  FacetCount,
  RequestQuery,
  RequestRecord,
  RequestStore,
  RouteStats,
} from '../stores/stores.js';

const DEFAULT_WINDOW_HOURS = 24;
const MAX_FACETS = 40;

@Injectable()
export class PostgresRequestStore implements RequestStore {
  constructor(private readonly db: OpsDb) {}

  async query(query: RequestQuery): Promise<CursorPage<RequestRecord>> {
    const limit = query.limit ?? 50;
    const rows = await this.db.read().execute<RawRequest>(sql`
      SELECT id, ts, route, method, status, duration_ms, feature, request_id,
             trace_id, user_id, ip::text AS ip, user_agent, bytes_out, sample_rate
      FROM ops.requests
      WHERE ${this.predicate(query)}
      ORDER BY ts DESC, id DESC
      LIMIT ${fetchLimit(limit)}
    `);

    return toCursorPage(rows.rows.map(toRecord), limit, (row) => encodeTimeCursor(row.ts, row.id));
  }

  /**
   * Per-route volume, error rate and latency percentiles for the window.
   *
   * Volume is `sum(1 / sample_rate)`, never `count(*)`. With sampling at 0.1 a
   * count understates traffic tenfold and does it silently — the number looks
   * entirely plausible, which is what makes it dangerous.
   */
  async byRoute(query: RequestQuery): Promise<RouteStats[]> {
    const rows = await this.db.read().execute<RawRouteStats>(sql`
      SELECT
        route,
        method,
        sum(1.0 / greatest(sample_rate, 0.000001))            AS volume,
        sum(CASE WHEN status >= 500 THEN 1.0 / greatest(sample_rate, 0.000001) ELSE 0 END)
                                                              AS errors,
        percentile_disc(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
        percentile_disc(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99,
        max(duration_ms)                                      AS max_duration_ms
      FROM ops.requests
      WHERE ${this.predicate({ ...query, cursor: undefined })}
      GROUP BY route, method
      ORDER BY volume DESC
      LIMIT 200
    `);

    return rows.rows.map((r) => {
      const volume = Number(r.volume);
      return {
        route: r.route,
        method: r.method,
        volume,
        errorRate: volume > 0 ? Number(r.errors) / volume : 0,
        p50: Number(r.p50 ?? 0),
        p95: Number(r.p95 ?? 0),
        p99: Number(r.p99 ?? 0),
        maxDurationMs: Number(r.max_duration_ms ?? 0),
      };
    });
  }

  async facets(dimension: 'route' | 'feature', query: RequestQuery): Promise<FacetCount[]> {
    const column = dimension === 'route' ? sql`route` : sql`feature`;
    const rows = await this.db.read().execute<{ value: string; count: string }>(sql`
      SELECT ${column} AS value,
             sum(1.0 / greatest(sample_rate, 0.000001))::bigint::text AS count
      FROM ops.requests
      WHERE ${this.predicate({ ...query, cursor: undefined })} AND ${column} IS NOT NULL
      GROUP BY ${column}
      ORDER BY 2 DESC
      LIMIT ${MAX_FACETS}
    `);

    return rows.rows.map((r) => ({ value: r.value, count: Number(r.count) }));
  }

  private predicate(query: RequestQuery): SQL {
    const since = query.since ?? new Date(Date.now() - DEFAULT_WINDOW_HOURS * 3_600_000);
    const parts: SQL[] = [sql`ts >= ${since}`];

    if (query.before) parts.push(sql`ts < ${query.before}`);

    const cursor = query.cursor ? decodeTimeCursor(query.cursor) : null;
    if (cursor) parts.push(sql`(ts, id) < (${cursor.ts}, ${cursor.id}::uuid)`);

    if (query.route) parts.push(sql`route = ${query.route}`);
    if (query.feature) parts.push(sql`feature = ${query.feature}`);
    if (query.method) parts.push(sql`method = ${query.method}`);
    if (query.minStatus !== undefined) parts.push(sql`status >= ${query.minStatus}`);
    if (query.maxStatus !== undefined) parts.push(sql`status <= ${query.maxStatus}`);
    if (query.minDurationMs !== undefined) parts.push(sql`duration_ms >= ${query.minDurationMs}`);
    if (query.search) parts.push(sql`search @@ plainto_tsquery('simple', ${query.search})`);

    return sql.join(parts, sql` AND `);
  }
}

interface RawRequest {
  // Index signature: drizzle's execute<T>() requires a row type it can
  // treat as a record. The named fields above are what we actually read.
  [column: string]: unknown;
  id: string;
  ts: string;
  route: string;
  method: string;
  status: number;
  duration_ms: number;
  feature: string | null;
  request_id: string | null;
  trace_id: string | null;
  user_id: string | null;
  ip: string | null;
  user_agent: string | null;
  bytes_out: number | null;
  sample_rate: number;
}

interface RawRouteStats {
  // Index signature: drizzle's execute<T>() requires a row type it can
  // treat as a record. The named fields above are what we actually read.
  [column: string]: unknown;
  route: string;
  method: string;
  volume: string;
  errors: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max_duration_ms: number | null;
}

function toRecord(row: RawRequest): RequestRecord {
  return {
    id: row.id,
    ts: toDate(row.ts),
    route: row.route,
    method: row.method,
    status: row.status,
    durationMs: row.duration_ms,
    feature: row.feature,
    requestId: row.request_id,
    traceId: row.trace_id,
    userId: row.user_id,
    ip: row.ip,
    userAgent: row.user_agent,
    bytesOut: row.bytes_out,
    sampleRate: row.sample_rate,
  };
}
