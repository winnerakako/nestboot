import { uuidv7 } from 'uuidv7';
import type { OpsDb } from '../db/ops-db.service.js';
import { logs } from '../db/schema/ops.js';
import { BatchWriter, type BatchWriterStats } from '../stores/batch-writer.js';

/**
 * A pino destination that batches log lines into `ops.logs`.
 *
 * Deliberately *not* a pino "transport": a transport runs in a worker thread
 * with its own module graph, which means it cannot see the correlation
 * AsyncLocalStorage and would need its own database pool. Writing in-process
 * and batching gets the same throughput without either problem.
 *
 * It is one of two destinations — stdout keeps receiving every line, so the
 * container logs remain complete and an outside observer (Nightwatch, the
 * platform's log drain) still sees everything even when Postgres is the thing
 * that is broken.
 */

/** Fields promoted to their own indexed column; the rest stay in `ctx`. */
const PROMOTED = new Set([
  'requestId',
  'workflowId',
  'jobId',
  'step',
  'traceId',
  'route',
  'method',
  'status',
  'feature',
  'group',
  'level',
  'time',
  'msg',
  'pid',
  'hostname',
]);

interface LogRow {
  id: string;
  ts: Date;
  level: number;
  msg: string;
  ctx: Record<string, unknown>;
  requestId: string | null;
  workflowId: string | null;
  jobId: string | null;
  step: string | null;
  traceId: string | null;
  route: string | null;
  method: string | null;
  status: number | null;
  feature: string | null;
  group: string | null;
}

export class OpsLogStream {
  private readonly writer: BatchWriter<LogRow>;

  constructor(
    private readonly db: OpsDb,
    options: { maxRows?: number; maxWaitMs?: number } = {},
  ) {
    this.writer = new BatchWriter<LogRow>({
      name: 'ops.logs',
      maxRows: options.maxRows ?? 100,
      maxWaitMs: options.maxWaitMs ?? 500,
      flush: async (rows) => {
        await this.db.write().insert(logs).values(rows);
      },
    });
  }

  /** pino's destination contract: one newline-terminated JSON object per call. */
  write(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A line pino could not serialise is not worth crashing the logger over.
      return;
    }

    const ctx: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!PROMOTED.has(key)) ctx[key] = value;
    }

    this.writer.add({
      id: uuidv7(),
      ts: typeof parsed.time === 'number' ? new Date(parsed.time) : new Date(),
      level: typeof parsed.level === 'number' ? parsed.level : 30,
      msg: typeof parsed.msg === 'string' ? parsed.msg : '',
      ctx,
      requestId: str(parsed.requestId),
      workflowId: str(parsed.workflowId),
      jobId: str(parsed.jobId),
      step: str(parsed.step),
      traceId: str(parsed.traceId),
      route: str(parsed.route),
      method: str(parsed.method),
      status: typeof parsed.status === 'number' ? parsed.status : null,
      feature: str(parsed.feature),
      group: str(parsed.group),
    });
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  stop(): Promise<void> {
    return this.writer.stop();
  }

  stats(): BatchWriterStats {
    return this.writer.stats();
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
