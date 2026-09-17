import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { OpsDb } from '../../db/ops-db.service.js';
import { toDate } from '../../db/raw.js';
import { securityEvents } from '../../db/schema/ops.js';
import {
  type CursorPage,
  decodeTimeCursor,
  encodeTimeCursor,
  fetchLimit,
  toCursorPage,
} from '../../http/cursor.js';
import { Correlation } from '../../logging/correlation.js';
import { BatchWriter, type BatchWriterStats } from '../../stores/batch-writer.js';
import type { RateLimitSubject } from '../../stores/stores.js';

export type SecurityEventKind =
  | 'login'
  | 'logout'
  | 'lockout'
  | 'rate_limit'
  | 'cors_rejected'
  | 'ip_blocked'
  | 'csrf_failed'
  | 'session_revoked'
  | 'webhook_signature'
  | 'policy_changed';

export interface SecurityEventInput {
  kind: SecurityEventKind;
  /** `success` · `failure` · `blocked` · `would_block` — past tense, always. */
  outcome: string;
  subject?: RateLimitSubject | { kind: string; id: string };
  request?: FastifyRequest;
  detail?: Record<string, unknown>;
}

export interface SecurityEventRecord {
  id: string;
  ts: Date;
  kind: string;
  outcome: string;
  subjectKind: string | null;
  subjectId: string | null;
  ip: string | null;
  userAgent: string | null;
  route: string | null;
  detail: Record<string, unknown>;
  requestId: string | null;
}

export interface SecurityEventQuery {
  kind?: string;
  outcome?: string;
  subjectId?: string;
  ip?: string;
  since?: Date;
  cursor?: string;
  limit?: number;
}

/**
 * The audit trail for everything that guards the app.
 *
 * Batched and best-effort like the rest of the telemetry — a failed write here
 * must never turn a rejected login into a 500, because "the security log is
 * down" is not a reason to let requests through *or* to stop serving them.
 *
 * Never record the credential itself: a failed-login event says which account
 * and from where, never what was tried. Password-spray attempts are exactly the
 * strings you least want durably stored.
 */
@Injectable()
export class SecurityEvents implements OnApplicationShutdown {
  private readonly writer: BatchWriter<typeof securityEvents.$inferInsert>;

  constructor(private readonly db: OpsDb) {
    this.writer = new BatchWriter({
      name: 'ops.security_events',
      maxRows: 20,
      maxWaitMs: 250,
      flush: async (rows) => {
        await this.db.write().insert(securityEvents).values(rows);
      },
    });
  }

  record(event: SecurityEventInput): void {
    const correlation = Correlation.get();
    this.writer.add({
      id: uuidv7(),
      ts: new Date(),
      kind: event.kind,
      outcome: event.outcome,
      subjectKind: event.subject?.kind ?? null,
      subjectId: event.subject?.id ?? null,
      ip: event.request?.ip ?? null,
      userAgent: header(event.request)?.slice(0, 500) ?? null,
      route: event.request?.routeOptions?.url ?? correlation.route ?? null,
      detail: event.detail ?? {},
      requestId: correlation.requestId ?? null,
    });
  }

  async query(query: SecurityEventQuery): Promise<CursorPage<SecurityEventRecord>> {
    const limit = query.limit ?? 50;
    const since = query.since ?? new Date(Date.now() - 24 * 3_600_000);
    const parts: SQL[] = [sql`ts >= ${since}`];

    if (query.kind) parts.push(sql`kind = ${query.kind}`);
    if (query.outcome) parts.push(sql`outcome = ${query.outcome}`);
    if (query.subjectId) parts.push(sql`subject_id = ${query.subjectId}`);
    if (query.ip) parts.push(sql`ip = ${query.ip}::inet`);

    const cursor = query.cursor ? decodeTimeCursor(query.cursor) : null;
    if (cursor) parts.push(sql`(ts, id) < (${cursor.ts}, ${cursor.id}::uuid)`);

    const rows = await this.db.read().execute<RawEvent>(sql`
      SELECT id, ts, kind, outcome, subject_kind, subject_id, ip::text AS ip,
             user_agent, route, detail, request_id
      FROM ops.security_events
      WHERE ${sql.join(parts, sql` AND `)}
      ORDER BY ts DESC, id DESC
      LIMIT ${fetchLimit(limit)}
    `);

    return toCursorPage(rows.rows.map(toRecord), limit, (row) => encodeTimeCursor(row.ts, row.id));
  }

  /** Counts by kind and outcome for the Security tab's summary row. */
  async summary(since: Date): Promise<Array<{ kind: string; outcome: string; count: number }>> {
    const rows = await this.db.read().execute<{
      kind: string;
      outcome: string;
      count: string;
    }>(sql`
      SELECT kind, outcome, count(*)::text AS count
      FROM ops.security_events
      WHERE ts >= ${since}
      GROUP BY kind, outcome
      ORDER BY 3 DESC
    `);
    return rows.rows.map((r) => ({ kind: r.kind, outcome: r.outcome, count: Number(r.count) }));
  }

  stats(): BatchWriterStats {
    return this.writer.stats();
  }

  /** Test seam: security assertions must not race a 250ms timer. */
  flush(): Promise<void> {
    return this.writer.flush();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.writer.stop();
  }
}

function header(request: FastifyRequest | undefined): string | undefined {
  const value = request?.headers['user-agent'];
  return Array.isArray(value) ? value[0] : value;
}

interface RawEvent {
  [column: string]: unknown;
  id: string;
  ts: string;
  kind: string;
  outcome: string;
  subject_kind: string | null;
  subject_id: string | null;
  ip: string | null;
  user_agent: string | null;
  route: string | null;
  detail: Record<string, unknown>;
  request_id: string | null;
}

function toRecord(row: RawEvent): SecurityEventRecord {
  return {
    id: row.id,
    ts: toDate(row.ts),
    kind: row.kind,
    outcome: row.outcome,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    ip: row.ip,
    userAgent: row.user_agent,
    route: row.route,
    detail: row.detail ?? {},
    requestId: row.request_id,
  };
}
