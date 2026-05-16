import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Assigns a unique request ID to every incoming request.
 * If the client sends an `x-request-id` header, it's preserved (for distributed tracing).
 * Otherwise, a new UUID is generated.
 *
 * The ID is:
 * - Stored on `req.requestId`
 * - Set as the `x-request-id` response header
 * - Available to loggers, error filters, and interceptors
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const requestId =
      (req.headers[REQUEST_ID_HEADER] as string) || randomUUID();

    (req as any).requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    next();
  }
}
