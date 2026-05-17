import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_\-.:]+$/;

/**
 * Assigns a unique request ID to every incoming request.
 * If the client sends a valid `x-request-id` header, it's preserved (for distributed tracing).
 * Otherwise, a new UUID is generated.
 *
 * Client-provided IDs are validated:
 * - Max 128 characters
 * - Only alphanumeric, hyphens, underscores, dots, colons (safe for headers and logs)
 *
 * The ID is:
 * - Stored on `req.requestId`
 * - Set as the `x-request-id` response header
 * - Available to loggers, error filters, and interceptors
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const clientId = req.headers[REQUEST_ID_HEADER] as string | undefined;

    const requestId =
      clientId &&
      clientId.length <= MAX_REQUEST_ID_LENGTH &&
      REQUEST_ID_PATTERN.test(clientId)
        ? clientId
        : randomUUID();

    (req as any).requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    next();
  }
}
