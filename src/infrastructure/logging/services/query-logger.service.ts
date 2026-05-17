import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import { LogBufferService } from './log-buffer.service';
import { LogContext } from './log-context.service';

/**
 * Monitors Prisma queries by hooking into Prisma's $on('query') event.
 * Detects slow queries and N+1 patterns per request.
 *
 * Automatically initialized on module start — no setup needed in services.
 */
@Injectable()
export class QueryLoggerService implements OnModuleInit {
  private readonly logger = new Logger(QueryLoggerService.name);
  private slowThresholdMs: number;
  private sampleRate: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly buffer: LogBufferService,
    private readonly configService: ConfigService,
  ) {
    this.slowThresholdMs = this.configService.get<number>(
      'logging.query.slowThresholdMs',
      100,
    );
    this.sampleRate = this.configService.get<number>(
      'logging.query.sampleRate',
      1.0,
    );
  }

  onModuleInit() {
    this.hookIntoQuery();
  }

  private hookIntoQuery() {
    try {
      // Prisma $on('query') requires logging to be enabled in PrismaClient constructor.
      // For Prisma 7, we use the event system.
      (this.prisma as any).$on?.('query', (event: any) => {
        this.handleQueryEvent(event);
      });

      this.logger.log(
        `Query logger initialized (slow threshold: ${this.slowThresholdMs}ms)`,
      );
    } catch {
      this.logger.warn(
        'Could not hook into Prisma query events. Enable { log: ["query"] } in PrismaClient to use query logging.',
      );
    }
  }

  /**
   * Manually record a query — use this if Prisma event hooks aren't available.
   * Can also be used for non-Prisma queries (e.g., raw SQL, external APIs).
   */
  recordQuery(params: {
    model: string;
    operation: string;
    duration: number;
    query?: string;
  }) {
    this.processQuery(
      params.model,
      params.operation,
      params.duration,
      params.query,
    );
  }

  private handleQueryEvent(event: unknown) {
    const queryEvent = event as { duration?: unknown; query?: unknown };
    const duration =
      typeof queryEvent.duration === 'number' ? queryEvent.duration : 0;
    const query = typeof queryEvent.query === 'string' ? queryEvent.query : '';
    const { model, operation } = this.parseQuery(query);

    this.processQuery(model, operation, duration, query);
  }

  private processQuery(
    model: string,
    operation: string,
    duration: number,
    query?: string,
  ) {
    // Record in request context (always, for per-request stats)
    LogContext.recordQuery(model, operation, duration);

    // Only persist slow queries
    if (duration < this.slowThresholdMs) return;

    // Sampling
    if (Math.random() > this.sampleRate) return;

    const requestId = LogContext.getRequestId();
    const queryShape = query ? this.normalizeQuery(query) : undefined;
    const queryHash = queryShape
      ? createHash('sha1').update(queryShape).digest('hex').slice(0, 12)
      : undefined;

    // N+1 detection: same model+operation > 5 times in one request
    const ctx = LogContext.get();
    let isN1 = false;
    if (ctx) {
      const sameQueries = ctx.dbQueries.filter(
        (q) => q.model === model && q.operation === operation,
      );
      if (sameQueries.length > 5) {
        isN1 = true;
      }
    }

    // Capture call site from stack trace
    const { sourceFile, sourceLine, sourceFunction, sourceStack } =
      this.captureSource();

    const logEntry = {
      requestId,
      modelName: model,
      operation,
      duration,
      query: query ? query.slice(0, 2048) : undefined,
      queryShape,
      queryHash,
      sourceFile,
      sourceLine,
      sourceFunction,
      sourceStack,
      isN1,
      timestamp: new Date(),
    };

    this.buffer.add('QueryLog', logEntry, false);

    if (isN1) {
      this.logger.warn(
        `N+1 detected: ${model}.${operation} called ${ctx?.dbQueries.filter((q) => q.model === model && q.operation === operation).length} times in request ${requestId}`,
      );
    }
  }

  private parseQuery(query: string): { model: string; operation: string } {
    // Prisma query format: SELECT ... FROM "schema"."table" ...
    const modelMatch = query.match(
      /\b(?:from|join|into|update)\s+(?:"[^"]+"\.)?"?([A-Za-z_][\w]*)"?/i,
    );
    const model = modelMatch ? modelMatch[1] : 'unknown';

    let operation = 'unknown';
    const lower = query.trimStart().toLowerCase();
    if (lower.startsWith('select')) operation = 'findMany';
    else if (lower.startsWith('insert')) operation = 'create';
    else if (lower.startsWith('update')) operation = 'update';
    else if (lower.startsWith('delete')) operation = 'delete';
    else if (lower.startsWith('begin')) operation = 'transaction';
    else if (lower.startsWith('commit')) operation = 'commit';

    return { model, operation };
  }

  private normalizeQuery(query: string): string {
    return query
      .replace(/'[^']*'/g, "'?'") // String values
      .replace(/\b\d+\b/g, '?') // Numeric values
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        '?',
      ) // UUIDs
      .replace(/\s+/g, ' ')
      .trim();
  }

  private captureSource(): {
    sourceFile?: string;
    sourceLine?: number;
    sourceFunction?: string;
    sourceStack?: string[];
  } {
    const err = new Error();
    const stack = err.stack?.split('\n').slice(1) || [];

    // Filter to app code only
    const appFrames = stack.filter(
      (line) =>
        !line.includes('node_modules') &&
        !line.includes('query-logger') &&
        !line.includes('log-buffer') &&
        !line.includes('prisma.service') &&
        !line.includes('internal/'),
    );

    if (appFrames.length === 0) {
      return {};
    }

    const firstFrame = appFrames[0];
    const match = firstFrame.match(/at\s+(.+?)\s+\((.+?):(\d+):\d+\)/);
    if (match) {
      return {
        sourceFunction: match[1],
        sourceFile: match[2],
        sourceLine: parseInt(match[3], 10),
        sourceStack: appFrames.slice(0, 6).map((f) => f.trim()),
      };
    }

    return { sourceStack: appFrames.slice(0, 6).map((f) => f.trim()) };
  }
}
