import compression from 'compression';
import { Request, Response } from 'express';

/**
 * Response compression middleware.
 * Compresses responses with gzip/deflate for responses larger than 1KB.
 * Skips compression for responses that are already compressed (images, etc.)
 * and for server-sent events.
 *
 * Usage in main.ts:
 *   app.use(compressionMiddleware());
 */
export function compressionMiddleware() {
  return compression({
    threshold: 1024, // Only compress responses larger than 1KB
    level: 6, // Compression level (1=fastest, 9=best, 6=balanced)
    filter: (req: Request, res: Response) => {
      // Don't compress server-sent events
      if (req.headers['accept'] === 'text/event-stream') {
        return false;
      }
      // Use compression's default filter (compresses text-based content types)
      return compression.filter(req, res);
    },
  });
}
