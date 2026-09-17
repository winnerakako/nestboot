import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { OpsDb } from '../db/ops-db.service.js';
import { toDate, toDateOrNull } from '../db/raw.js';
import {
  type CursorPage,
  decodeTimeCursor,
  encodeTimeCursor,
  fetchLimit,
  toCursorPage,
} from '../http/cursor.js';
import type {
  ErrorGroup,
  ErrorOccurrence,
  ErrorQuery,
  ErrorStore,
  FacetCount,
} from '../stores/stores.js';

const DEFAULT_WINDOW_HOURS = 24 * 7;

@Injectable()
export class PostgresErrorStore implements ErrorStore {
  constructor(private readonly db: OpsDb) {}

  async groups(query: ErrorQuery): Promise<CursorPage<ErrorGroup>> {
    const limit = query.limit ?? 50;
    const since = query.since ?? new Date(Date.now() - DEFAULT_WINDOW_HOURS * 3_600_000);
    const parts: SQL[] = [sql`last_seen_at >= ${since}`];

    if (query.status) parts.push(sql`status = ${query.status}`);
    if (query.route) parts.push(sql`route = ${query.route}`);
    if (query.feature) parts.push(sql`feature = ${query.feature}`);
    if (query.search) {
      parts.push(sql`(type ILIKE ${`%${query.search}%`} OR message ILIKE ${`%${query.search}%`})`);
    }

    const cursor = query.cursor ? decodeTimeCursor(query.cursor) : null;
    if (cursor) parts.push(sql`(last_seen_at, fingerprint) < (${cursor.ts}, ${cursor.id})`);

    const rows = await this.db.read().execute<RawGroup>(sql`
      SELECT fingerprint, type, message, route, feature, first_seen_at, last_seen_at,
             occurrences, status, muted_until, resolved_at, resolved_by, note
      FROM ops.error_groups
      WHERE ${sql.join(parts, sql` AND `)}
      ORDER BY last_seen_at DESC, fingerprint DESC
      LIMIT ${fetchLimit(limit)}
    `);

    return toCursorPage(rows.rows.map(toGroup), limit, (row) =>
      encodeTimeCursor(row.lastSeenAt, row.fingerprint),
    );
  }

  async group(fingerprint: string): Promise<ErrorGroup | null> {
    const rows = await this.db.read().execute<RawGroup>(sql`
      SELECT fingerprint, type, message, route, feature, first_seen_at, last_seen_at,
             occurrences, status, muted_until, resolved_at, resolved_by, note
      FROM ops.error_groups WHERE fingerprint = ${fingerprint}
    `);
    const row = rows.rows[0];
    return row ? toGroup(row) : null;
  }

  async occurrences(fingerprint: string, query: ErrorQuery): Promise<CursorPage<ErrorOccurrence>> {
    const limit = query.limit ?? 25;
    const since = query.since ?? new Date(Date.now() - DEFAULT_WINDOW_HOURS * 3_600_000);
    const parts: SQL[] = [sql`fingerprint = ${fingerprint}`, sql`ts >= ${since}`];

    const cursor = query.cursor ? decodeTimeCursor(query.cursor) : null;
    if (cursor) parts.push(sql`(ts, id) < (${cursor.ts}, ${cursor.id}::uuid)`);

    const rows = await this.db.read().execute<RawOccurrence>(sql`
      SELECT id, ts, fingerprint, type, message, stack, status, route, feature,
             group_name, request_id, workflow_id, trace_id, user_id
      FROM ops.errors
      WHERE ${sql.join(parts, sql` AND `)}
      ORDER BY ts DESC, id DESC
      LIMIT ${fetchLimit(limit)}
    `);

    return toCursorPage(rows.rows.map(toOccurrence), limit, (row) =>
      encodeTimeCursor(row.ts, row.id),
    );
  }

  async facets(dimension: 'route' | 'feature', query: ErrorQuery): Promise<FacetCount[]> {
    const column = dimension === 'route' ? sql`route` : sql`feature`;
    const since = query.since ?? new Date(Date.now() - DEFAULT_WINDOW_HOURS * 3_600_000);

    const rows = await this.db.read().execute<{ value: string; count: string }>(sql`
      SELECT ${column} AS value, sum(occurrences)::text AS count
      FROM ops.error_groups
      WHERE last_seen_at >= ${since} AND ${column} IS NOT NULL
      GROUP BY ${column}
      ORDER BY 2 DESC
      LIMIT 40
    `);

    return rows.rows.map((r) => ({ value: r.value, count: Number(r.count) }));
  }

  async resolve(fingerprint: string, by: string, note?: string): Promise<void> {
    await this.db.write().execute(sql`
      UPDATE ops.error_groups
      SET status = 'resolved', resolved_at = now(), resolved_by = ${by},
          note = coalesce(${note ?? null}, note), muted_until = NULL
      WHERE fingerprint = ${fingerprint}
    `);
  }

  async mute(fingerprint: string, until: Date, by: string): Promise<void> {
    await this.db.write().execute(sql`
      UPDATE ops.error_groups
      SET status = 'muted', muted_until = ${until}, resolved_by = ${by}
      WHERE fingerprint = ${fingerprint}
    `);
  }

  async reopen(fingerprint: string): Promise<void> {
    await this.db.write().execute(sql`
      UPDATE ops.error_groups
      SET status = 'open', resolved_at = NULL, resolved_by = NULL, muted_until = NULL
      WHERE fingerprint = ${fingerprint}
    `);
  }
}

interface RawGroup {
  // Index signature: drizzle's execute<T>() requires a row type it can
  // treat as a record. The named fields above are what we actually read.
  [column: string]: unknown;
  fingerprint: string;
  type: string;
  message: string;
  route: string | null;
  feature: string | null;
  first_seen_at: string;
  last_seen_at: string;
  occurrences: string;
  status: string;
  muted_until: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  note: string | null;
}

interface RawOccurrence {
  // Index signature: drizzle's execute<T>() requires a row type it can
  // treat as a record. The named fields above are what we actually read.
  [column: string]: unknown;
  id: string;
  ts: string;
  fingerprint: string;
  type: string;
  message: string;
  stack: string | null;
  status: number | null;
  route: string | null;
  feature: string | null;
  group_name: string | null;
  request_id: string | null;
  workflow_id: string | null;
  trace_id: string | null;
  user_id: string | null;
}

function toGroup(row: RawGroup): ErrorGroup {
  return {
    fingerprint: row.fingerprint,
    type: row.type,
    message: row.message,
    route: row.route,
    feature: row.feature,
    firstSeenAt: toDate(row.first_seen_at),
    lastSeenAt: toDate(row.last_seen_at),
    occurrences: Number(row.occurrences),
    status: row.status as ErrorGroup['status'],
    mutedUntil: toDateOrNull(row.muted_until),
    resolvedAt: toDateOrNull(row.resolved_at),
    resolvedBy: row.resolved_by,
    note: row.note,
  };
}

function toOccurrence(row: RawOccurrence): ErrorOccurrence {
  return {
    id: row.id,
    ts: toDate(row.ts),
    fingerprint: row.fingerprint,
    type: row.type,
    message: row.message,
    stack: row.stack,
    status: row.status,
    route: row.route,
    feature: row.feature,
    group: row.group_name,
    requestId: row.request_id,
    workflowId: row.workflow_id,
    traceId: row.trace_id,
    userId: row.user_id,
  };
}
