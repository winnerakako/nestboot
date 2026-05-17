import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { LogBufferService } from './log-buffer.service';
import { LogContext } from './log-context.service';
import { redact, normalizePath, inferUserType } from './log-redaction.service';

@Injectable()
export class RequestLoggerInterceptor implements NestInterceptor {
  constructor(
    private readonly buffer: LogBufferService,
    private readonly configService: ConfigService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const requestId = (request as any).requestId || '-';
    const userId = (request as any).user?.sub;
    const memBefore = process.memoryUsage().heapUsed;
    const start = Date.now();

    // Set context BEFORE the handler runs — context persists via AsyncLocalStorage
    // for the entire async chain (DB queries, service calls, etc.)
    LogContext.enter({ requestId, userId });

    return next.handle().pipe(
      tap({
        next: (body) => {
          const duration = Date.now() - start;
          this.recordLog(request, response, duration, memBefore, body);
        },
        error: (error) => {
          const duration = Date.now() - start;
          this.recordLog(request, response, duration, memBefore, null, error);
        },
      }),
    );
  }

  private recordLog(
    request: Request,
    response: Response,
    duration: number,
    memBefore: number,
    body: any,
    error?: any,
  ) {
    const statusCode =
      error?.status || error?.statusCode || (error ? 500 : response.statusCode);
    const isError = statusCode >= 400;
    const sampling = this.configService.get('logging.sampling');

    if (!sampling) return;

    // Sampling logic: always log errors and slow requests
    if (!isError && duration < sampling.slowThresholdMs) {
      if (Math.random() > sampling.requestRate) return;
    } else if (isError) {
      if (Math.random() > sampling.errorRate) return;
    } else {
      if (Math.random() > sampling.slowRate) return;
    }

    const ctx = LogContext.get();
    const route = request.route as { path?: unknown } | undefined;
    const routePath =
      typeof route?.path === 'string' ? route.path : request.path;
    const normalizedPath = normalizePath(routePath);
    const routeKey = `${request.method}:${normalizedPath}`;

    const dbQueries = ctx?.dbQueries || [];
    const dbTotalDuration = dbQueries.reduce((sum, q) => sum + q.duration, 0);
    const slowThreshold = this.configService.get<number>(
      'logging.query.slowThresholdMs',
      100,
    );
    const slowDbQueries = dbQueries.filter((q) => q.duration >= slowThreshold);
    const memDelta = process.memoryUsage().heapUsed - memBefore;

    const spans = (ctx?.spans || [])
      .filter((s) => s.duration !== undefined)
      .map((s) => ({ name: s.name, duration: s.duration! }));

    const requestSize = parseInt(request.headers['content-length'] || '0', 10);
    const responseSummary = this.summarizeBody(body);
    const responseSize = responseSummary
      ? Buffer.byteLength(responseSummary)
      : 0;

    const logEntry = {
      requestId: (request as any).requestId,
      method: request.method,
      path: request.path,
      routeKey,
      statusCode,
      duration,
      requestSize,
      responseSize,
      ip: request.ip || request.headers['x-forwarded-for'],
      userAgent: request.get('user-agent'),
      userId: (request as any).user?.sub,
      userType: inferUserType(request.path),
      requestQuery: Object.keys(request.query).length
        ? redact(request.query)
        : undefined,
      requestBody: this.hasKeys(request.body)
        ? redact(request.body)
        : undefined,
      requestParams:
        request.params && Object.keys(request.params).length
          ? redact(request.params)
          : undefined,
      responseMessage: body?.message,
      responseSummary,
      error: error
        ? {
            message: error.message || 'Unknown error',
            name: error.name || error.constructor?.name,
            stack: error.stack,
          }
        : undefined,
      dbQueryCount: dbQueries.length,
      dbTotalDuration,
      dbSlowQueryCount: slowDbQueries.length,
      slowDbQueries: slowDbQueries.slice(0, 5),
      spans,
      memoryDelta: memDelta,
      performanceHint: this.buildPerformanceHint(
        duration,
        dbTotalDuration,
        responseSize,
        spans,
      ),
      timestamp: new Date(),
    };

    this.buffer.add('RequestLog', logEntry, isError);
  }

  private buildPerformanceHint(
    totalDuration: number,
    dbDuration: number,
    responseSize: number,
    spans: { name: string; duration: number }[],
  ): string | undefined {
    if (totalDuration < 500) return undefined;

    const hints: string[] = [];
    const dbPercent =
      totalDuration > 0 ? (dbDuration / totalDuration) * 100 : 0;

    if (dbPercent > 50) {
      hints.push(
        `DB queries took ${Math.round(dbPercent)}% of total time (${dbDuration}ms/${totalDuration}ms)`,
      );
    }

    if (responseSize > 1024 * 1024) {
      hints.push(`Large response: ${Math.round(responseSize / 1024)}KB`);
    }

    for (const span of spans) {
      const spanPercent = (span.duration / totalDuration) * 100;
      if (spanPercent > 30) {
        hints.push(
          `${span.name} took ${Math.round(spanPercent)}% (${span.duration}ms)`,
        );
      }
    }

    if (hints.length === 0 && dbPercent < 20) {
      hints.push(
        'Most time spent outside DB and tracked spans — check business logic',
      );
    }

    return hints.join('; ');
  }

  private hasKeys(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
    );
  }

  private summarizeBody(body: any): string | undefined {
    if (!body) return undefined;
    try {
      let str: string;
      if (typeof body === 'string') {
        try {
          str = JSON.stringify(redact(JSON.parse(body)));
        } catch {
          str = body;
        }
      } else {
        str = JSON.stringify(redact(body));
      }
      return str.length > 1024 ? str.slice(0, 1024) + '...[truncated]' : str;
    } catch {
      return undefined;
    }
  }
}
