import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';

/**
 * Extracts the current user ID from the JWT payload and attaches it
 * to `req.auditUserId` so services can pass it to
 * `prisma.auditCreate(userId)` / `prisma.auditUpdate(userId)`.
 *
 * Register globally in AppModule:
 *   { provide: APP_INTERCEPTOR, useClass: AuditContextInterceptor }
 */
@Injectable()
export class AuditContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    request.auditUserId = request.user?.sub ?? null;
    return next.handle();
  }
}
