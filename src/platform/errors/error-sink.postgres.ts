import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { OpsDb } from '../db/ops-db.service.js';
import { errors as errorsTable } from '../db/schema/ops.js';
import { BatchWriter, type BatchWriterStats } from '../stores/batch-writer.js';
import type { ErrorEvent, ErrorSink } from './error-sink.js';

interface ErrorRow {
  id: string;
  ts: Date;
  fingerprint: string;
  type: string;
  message: string;
  stack: string | null;
  status: number | null;
  route: string | null;
  feature: string | null;
  group: string | null;
  requestId: string | null;
  workflowId: string | null;
  traceId: string | null;
  userId: string | null;
}

/** Stacks are truncated: the top frames identify the bug, the rest is noise. */
const MAX_STACK_CHARS = 8_000;
const MAX_MESSAGE_CHARS = 2_000;

@Injectable()
export class PostgresErrorSink implements ErrorSink, OnApplicationShutdown {
  private readonly writer: BatchWriter<ErrorRow>;

  constructor(private readonly db: OpsDb) {
    this.writer = new BatchWriter<ErrorRow>({
      name: 'ops.errors',
      // Smaller and more eager than logs: during an incident the operator is
      // refreshing the errors tab, and a 500ms-stale view is the difference
      // between "it stopped" and "I cannot tell yet".
      maxRows: 25,
      maxWaitMs: 250,
      flush: (rows) => this.persist(rows),
    });
  }

  record(event: ErrorEvent): void {
    this.writer.add({
      id: uuidv7(),
      ts: event.occurredAt,
      fingerprint: event.fingerprint,
      type: event.type,
      message: event.message.slice(0, MAX_MESSAGE_CHARS),
      stack: event.stack?.slice(0, MAX_STACK_CHARS) ?? null,
      status: event.status,
      route: event.context.route ?? null,
      feature: event.context.feature ?? null,
      group: event.context.group ?? null,
      requestId: event.context.requestId ?? null,
      workflowId: event.context.workflowId ?? null,
      traceId: event.context.traceId ?? null,
      userId: event.context.userId ?? null,
    });
  }

  /**
   * Write the occurrences and roll up the groups in one transaction.
   *
   * The group upsert deliberately does NOT reopen a resolved group: an operator
   * who marked something resolved should not have that judgement silently
   * undone by a straggler from a request that was already in flight. A group
   * that genuinely recurs shows a climbing `occurrences` and a fresh
   * `last_seen_at`, which is what the tab sorts on.
   */
  private async persist(rows: ErrorRow[]): Promise<void> {
    await this.db.write().transaction(async (tx) => {
      await tx.insert(errorsTable).values(rows);

      const grouped = new Map<string, { row: ErrorRow; count: number; latest: Date }>();
      for (const row of rows) {
        const existing = grouped.get(row.fingerprint);
        if (existing) {
          existing.count++;
          if (row.ts > existing.latest) existing.latest = row.ts;
        } else {
          grouped.set(row.fingerprint, { row, count: 1, latest: row.ts });
        }
      }

      for (const { row, count, latest } of grouped.values()) {
        await tx.execute(sql`
          INSERT INTO ops.error_groups
            (fingerprint, type, message, route, feature, first_seen_at, last_seen_at, occurrences, status)
          VALUES
            (${row.fingerprint}, ${row.type}, ${row.message}, ${row.route}, ${row.feature},
             ${row.ts}, ${latest}, ${count}, 'open')
          ON CONFLICT (fingerprint) DO UPDATE SET
            last_seen_at = greatest(ops.error_groups.last_seen_at, excluded.last_seen_at),
            occurrences  = ops.error_groups.occurrences + excluded.occurrences,
            message      = excluded.message,
            route        = coalesce(excluded.route, ops.error_groups.route),
            feature      = coalesce(excluded.feature, ops.error_groups.feature)
        `);
      }
    });
  }

  stats(): BatchWriterStats {
    return this.writer.stats();
  }

  /** Test seam: assertions must not race the 250ms flush timer. */
  flush(): Promise<void> {
    return this.writer.flush();
  }

  async onApplicationShutdown(): Promise<void> {
    // The errors buffered at shutdown are frequently the reason for it.
    await this.writer.stop();
  }
}
