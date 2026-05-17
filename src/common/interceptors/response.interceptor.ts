import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface StandardResponse<T> {
  success: boolean;
  message: string;
  data: T;
  meta?: unknown;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  StandardResponse<T>
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<StandardResponse<T>> {
    return next.handle().pipe(
      map((data) => {
        // If the response already has our standard shape, pass through
        if (data && typeof data === 'object' && 'success' in data) {
          return data;
        }

        if (data && typeof data === 'object') {
          const record = data as Record<string, unknown>;
          const keys = Object.keys(record);
          const hasData = Object.prototype.hasOwnProperty.call(record, 'data');
          const hasMeta = Object.prototype.hasOwnProperty.call(record, 'meta');
          const isControllerEnvelope =
            (hasData || hasMeta) &&
            keys.every((key) => ['data', 'message', 'meta'].includes(key));

          if (isControllerEnvelope) {
            return {
              success: true,
              message:
                typeof record.message === 'string' ? record.message : 'Success',
              data: record.data ?? null,
              ...(hasMeta ? { meta: record.meta } : {}),
            } as StandardResponse<T>;
          }
        }

        return {
          success: true,
          message: 'Success',
          data,
        };
      }),
    );
  }
}
