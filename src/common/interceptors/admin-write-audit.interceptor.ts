import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, tap } from 'rxjs';
import {
  AppLoggerService,
  redact,
} from '../../infrastructure/logging/services';
import { RequestWithUser } from '../interfaces';

const MAX_PAYLOAD_SUMMARY_LENGTH = 1024;

type AdminRequest = Request &
  Partial<RequestWithUser> & {
    requestId?: string;
    user?: {
      sub?: string;
      email?: string;
      role?: string;
    };
  };

function getClientIp(request: AdminRequest): string | undefined {
  return request.ip || request.socket.remoteAddress;
}

function summarizePayload(payload: unknown): string | undefined {
  if (payload === undefined) return undefined;

  const summary = JSON.stringify(redact(payload));
  if (!summary) return undefined;

  return summary.length > MAX_PAYLOAD_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_PAYLOAD_SUMMARY_LENGTH)}...[truncated]`
    : summary;
}

@Injectable()
export class AdminWriteAuditInterceptor implements NestInterceptor {
  constructor(private readonly appLogger: AppLoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const userId = request.user?.sub || request.auditUserId || undefined;
    const route = request.route?.path || request.path;
    const metadata = {
      userId,
      userRole: request.user?.role,
      ip: getClientIp(request),
      method: request.method,
      route,
      url: request.originalUrl || request.url,
      params: request.params,
      query: request.query,
      payloadSummary: summarizePayload(request.body),
    };

    return next.handle().pipe(
      tap({
        next: () => {
          this.appLogger.warn('Admin monitoring write action completed', {
            context: AdminWriteAuditInterceptor.name,
            userId,
            requestId: request.requestId,
            metadata: { ...metadata, status: 'success' },
          });
        },
        error: (error: Error & { status?: number }) => {
          this.appLogger.error('Admin monitoring write action failed', {
            context: AdminWriteAuditInterceptor.name,
            userId,
            requestId: request.requestId,
            metadata: {
              ...metadata,
              status: 'failed',
              errorStatus: error.status,
              errorMessage: error.message,
            },
            error,
          });
        },
      }),
    );
  }
}
