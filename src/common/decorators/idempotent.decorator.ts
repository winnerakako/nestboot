import { SetMetadata } from '@nestjs/common';
import { IDEMPOTENCY_KEY } from '../guards/idempotency.guard';

/**
 * Marks a route as idempotent.
 * Requires clients to send an `x-idempotency-key` header.
 * Duplicate requests with the same key return the cached response.
 *
 * @param ttlSeconds - How long to cache the response (default: 86400 = 24h)
 *
 * Usage:
 *   @Post('payment')
 *   @Idempotent(3600) // cache for 1 hour
 *   @UseGuards(IdempotencyGuard)
 *   createPayment() { ... }
 */
export const Idempotent = (ttlSeconds = 86400) =>
  SetMetadata(IDEMPOTENCY_KEY, ttlSeconds);
