import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

const RAW_RESPONSE = 'platform:raw-response';

/**
 * Opt out of the envelope: server-rendered HTML, redirects, file downloads and
 * anything whose body shape is dictated by a third party (a webhook
 * acknowledgement a provider parses).
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);

/**
 * Wraps every JSON body as `{ "data": ... }`.
 *
 * The envelope exists so that adding a top-level member later — pagination
 * cursors, a deprecation notice, rate-limit state — is an additive change
 * rather than a breaking one. A bare array at the top level has nowhere to put
 * those, and every API that started with one eventually broke its clients to
 * get one.
 *
 * `{ data, nextCursor, hasMore }` from a cursor page is passed through as-is
 * rather than nested twice.
 */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw) return next.handle();

    return next.handle().pipe(
      map((body: unknown) => {
        if (body === undefined || body === null) return body;
        if (isEnveloped(body)) return body;
        return { data: body };
      }),
    );
  }
}

function isEnveloped(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'data' in body;
}
