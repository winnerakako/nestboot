import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { ConfigService } from '../config/index.js';
import { OpsDb } from '../db/ops-db.service.js';
import { requests as requestsTable } from '../db/schema/ops.js';
import { Correlation } from '../logging/correlation.js';
import { BatchWriter, type BatchWriterStats } from '../stores/batch-writer.js';

const TRACEPARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

interface RequestRow {
  id: string;
  ts: Date;
  route: string;
  method: string;
  status: number;
  durationMs: number;
  feature: string | null;
  requestId: string | null;
  traceId: string | null;
  userId: string | null;
  ip: string | null;
  userAgent: string | null;
  bytesOut: number | null;
  sampleRate: number;
}

/**
 * Opens the correlation scope and records the request.
 *
 * Implemented as Fastify hooks rather than Nest middleware for two reasons:
 * `onRequest` is the earliest point in the lifecycle, so an error thrown by
 * anything afterwards still has a request id; and `onResponse` is the only
 * place where the *matched route pattern* is known, which is the dimension
 * every /ops page groups by.
 */
@Injectable()
export class RequestRecorder implements OnApplicationShutdown {
  private readonly writer: BatchWriter<RequestRow> | null;
  private readonly sampleRate: number;
  private readonly slowMs: number;

  constructor(config: ConfigService, db: OpsDb) {
    this.sampleRate = config.get('OPS_REQUEST_SAMPLE');
    this.slowMs = config.get('OPS_SLOW_REQUEST_MS');
    this.writer = config.get('OPS_REQUESTS_ENABLED')
      ? new BatchWriter<RequestRow>({
          name: 'ops.requests',
          maxRows: 200,
          maxWaitMs: 1_000,
          flush: async (rows) => {
            await db.write().insert(requestsTable).values(rows);
          },
        })
      : null;
  }

  register(fastify: FastifyInstance): void {
    fastify.addHook('onRequest', (request, reply, done) => {
      const requestId = inboundId(request.headers['x-request-id']) ?? uuidv7();
      const traceId = TRACEPARENT.exec(single(request.headers.traceparent) ?? '')?.[1];

      // Echoed so a caller can quote it in a support ticket and an operator can
      // paste it straight into the /ops search box.
      void reply.header('x-request-id', requestId);

      // Intentional: `done` is invoked INSIDE run(), which is what makes the
      // store visible for the whole remaining lifecycle — the same mechanism
      // @fastify/request-context uses. Calling run() and then done() outside it
      // would give every handler an empty context.
      Correlation.run(
        {
          requestId,
          method: request.method,
          ...(traceId ? { traceId } : {}),
        },
        done,
      );
    });

    fastify.addHook('onResponse', (request, reply, done) => {
      this.record(request, reply);
      done();
    });
  }

  private record(request: FastifyRequest, reply: FastifyReply): void {
    // The pattern (`/loans/:id`), never the concrete URL: grouping by URL
    // produces one group per id and answers no question anyone asked.
    const route = request.routeOptions?.url ?? 'unmatched';
    const status = reply.statusCode;
    const durationMs = Math.round(reply.elapsedTime);

    // Make the route visible to any log line still being written for this
    // request, and to the error sink if this response is an error.
    Correlation.merge({ route, status, feature: featureOf(route) ?? undefined });

    if (!this.writer) return;

    // Errors and slow requests bypass sampling entirely: they are the rows
    // somebody will go looking for, and a sampled-away 500 is indistinguishable
    // from a 500 that never happened.
    const alwaysKeep = status >= 500 || durationMs >= this.slowMs;
    if (!alwaysKeep && this.sampleRate < 1 && Math.random() >= this.sampleRate) return;

    const correlation = Correlation.get();
    this.writer.add({
      id: uuidv7(),
      ts: new Date(),
      route,
      method: request.method,
      status,
      durationMs,
      feature: featureOf(route),
      requestId: correlation.requestId ?? null,
      traceId: correlation.traceId ?? null,
      userId: correlation.userId ?? null,
      ip: request.ip ?? null,
      userAgent: single(request.headers['user-agent'])?.slice(0, 500) ?? null,
      bytesOut: numeric(reply.getHeader('content-length')),
      // Stored per row so that volume stays correct across a change of sampling
      // rate: volume is sum(1 / sample_rate), and an old row must keep the rate
      // it was actually recorded at.
      sampleRate: alwaysKeep ? 1 : this.sampleRate,
    });
  }

  stats(): BatchWriterStats | null {
    return this.writer?.stats() ?? null;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.writer?.stop();
  }
}

/**
 * The feature a route belongs to, from its first meaningful path segment:
 * `/api/v1/loans/:id` -> `loans`. Derived rather than declared so that a new
 * controller is filterable in /ops without anyone remembering to label it.
 */
export function featureOf(route: string): string | null {
  for (const segment of route.split('/')) {
    if (!segment) continue;
    if (segment === 'api' || /^v\d+$/.test(segment)) continue;
    if (segment.startsWith(':') || segment.startsWith('*')) return null;
    return segment;
  }
  return null;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function inboundId(value: string | string[] | undefined): string | undefined {
  const raw = single(value);
  // A client-supplied id is echoed into logs and rendered in /ops, so it is
  // bounded and stripped of anything that could forge a log line.
  return raw && raw.length > 0 && raw.length <= 200 ? raw.replace(/[^\w.:-]/g, '') : undefined;
}

function numeric(value: number | string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
