import {
  bigint,
  index,
  inet,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The telemetry database: logs, requests, errors, security events, rate-limit
 * counters and cache.
 *
 * Everything append-only here is time-partitioned, because retention is
 * `DROP PARTITION` — at this volume a `DELETE` of one day produces more WAL
 * than the writes it removes and leaves bloat only `VACUUM FULL` reclaims.
 *
 * These declarations describe the schema for querying;
 * `migrations/ops/*.sql` is what creates it, and `schema.spec.ts` asserts the
 * two agree against a live database.
 */

export const ops = pgSchema('ops');

/** `group` is reserved in SQL, so the column is `group_name` and only the property is `group`. */
export const logs = ops.table(
  'logs',
  {
    id: uuid('id').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    /** pino numeric levels: 10 trace … 60 fatal. */
    level: smallint('level').notNull(),
    msg: text('msg').notNull(),
    ctx: jsonb('ctx').notNull().default({}),
    requestId: text('request_id'),
    workflowId: text('workflow_id'),
    jobId: text('job_id'),
    step: text('step'),
    traceId: text('trace_id'),
    route: text('route'),
    method: text('method'),
    status: smallint('status'),
    feature: text('feature'),
    group: text('group_name'),
  },
  (table) => [
    index('logs_ts_idx').on(table.ts),
    index('logs_level_ts_idx').on(table.level, table.ts),
    index('logs_request_ts_idx').on(table.requestId, table.ts),
    index('logs_workflow_ts_idx').on(table.workflowId, table.ts),
  ],
);

export const requests = ops.table(
  'requests',
  {
    id: uuid('id').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    route: text('route').notNull(),
    method: text('method').notNull(),
    status: smallint('status').notNull(),
    durationMs: integer('duration_ms').notNull(),
    feature: text('feature'),
    requestId: text('request_id'),
    traceId: text('trace_id'),
    userId: text('user_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    bytesOut: integer('bytes_out'),
    /** Volume is `sum(1 / sampleRate)`, never `count(*)`. See the migration. */
    sampleRate: real('sample_rate').notNull().default(1),
  },
  (table) => [
    index('requests_ts_idx').on(table.ts),
    index('requests_route_ts_idx').on(table.route, table.ts),
    index('requests_status_ts_idx').on(table.status, table.ts),
  ],
);

export const errors = ops.table(
  'errors',
  {
    id: uuid('id').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    fingerprint: text('fingerprint').notNull(),
    type: text('type').notNull(),
    message: text('message').notNull(),
    stack: text('stack'),
    status: smallint('status'),
    route: text('route'),
    feature: text('feature'),
    group: text('group_name'),
    requestId: text('request_id'),
    workflowId: text('workflow_id'),
    traceId: text('trace_id'),
    userId: text('user_id'),
  },
  (table) => [
    index('errors_ts_idx').on(table.ts),
    index('errors_fingerprint_idx').on(table.fingerprint, table.ts),
  ],
);

/** Operator state per fingerprint. Not partitioned: small, mutable, long-lived. */
export const errorGroups = ops.table('error_groups', {
  fingerprint: text('fingerprint').primaryKey(),
  type: text('type').notNull(),
  message: text('message').notNull(),
  route: text('route'),
  feature: text('feature'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  occurrences: bigint('occurrences', { mode: 'number' }).notNull().default(1),
  status: text('status').notNull().default('open'),
  mutedUntil: timestamp('muted_until', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: text('resolved_by'),
  note: text('note'),
});

export const securityEvents = ops.table(
  'security_events',
  {
    id: uuid('id').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    kind: text('kind').notNull(),
    outcome: text('outcome').notNull(),
    subjectKind: text('subject_kind'),
    subjectId: text('subject_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    route: text('route'),
    detail: jsonb('detail').notNull().default({}),
    requestId: text('request_id'),
  },
  (table) => [
    index('security_events_ts_idx').on(table.ts),
    index('security_events_kind_ts_idx').on(table.kind, table.ts),
  ],
);

export const rateLimitCounters = ops.table('rate_limit_counters', {
  subjectKind: text('subject_kind').notNull(),
  subjectId: text('subject_id').notNull(),
  routeGroup: text('route_group').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
});

export const cache = ops.table('cache', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  hits: bigint('hits', { mode: 'number' }).notNull().default(0),
});

/** Written by the migration runner itself, so it lives in `public`, not `ops`. */
export const migrations = pgTable('_migrations', {
  key: text('key').primaryKey(),
  checksum: text('checksum').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  durationMs: integer('duration_ms').notNull(),
});
