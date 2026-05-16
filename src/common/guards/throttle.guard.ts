import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpStatus,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { BusinessException } from '../filters';

// ─── Metadata Keys ───────────────────────────────────────

export const THROTTLE_KEY = 'throttle';
export const SKIP_THROTTLE_KEY = 'skipThrottle';

// ─── Decorators ──────────────────────────────────────────

/**
 * Configure rate limiting for a specific route or controller.
 *
 * @param limit - Max requests per window
 * @param windowSeconds - Time window in seconds
 *
 * Usage:
 *   @Throttle(10, 60)    → 10 requests per minute
 *   @Throttle(5, 60)     → 5 requests per minute (sensitive routes)
 *   @Throttle(100, 60)   → 100 requests per minute (high-traffic routes)
 */
export const Throttle = (limit: number, windowSeconds: number) =>
  SetMetadata(THROTTLE_KEY, { limit, windowSeconds });

/**
 * Skip rate limiting for a route or controller.
 *
 * Usage:
 *   @SkipThrottle()
 *   @Get('health')
 *   health() { ... }
 */
export const SkipThrottle = () => SetMetadata(SKIP_THROTTLE_KEY, true);

// ─── Pre-built Presets ───────────────────────────────────

/** Standard: 60 req/min */
export const ThrottleStandard = () => Throttle(60, 60);

/** Strict: 10 req/min (login, password reset, OTP) */
export const ThrottleStrict = () => Throttle(10, 60);

/** Very strict: 5 req/min (OTP verify, payment confirm) */
export const ThrottleVeryStrict = () => Throttle(5, 60);

/** Relaxed: 200 req/min (search, listing endpoints) */
export const ThrottleRelaxed = () => Throttle(200, 60);

/** Per-second burst: 5 req/sec */
export const ThrottleBurst = () => Throttle(5, 1);

// ─── Guard ───────────────────────────────────────────────

interface ThrottleConfig {
  limit: number;
  windowSeconds: number;
}

const DEFAULT_CONFIG: ThrottleConfig = {
  limit: 60,
  windowSeconds: 60,
};

const REDIS_GUARD_TIMEOUT_MS = 250;

/**
 * Redis-backed distributed rate limiting guard.
 *
 * Features:
 * - Per-user rate limiting (falls back to IP for unauthenticated requests)
 * - Per-route counters (different routes have separate limits)
 * - Configurable per controller or per route via @Throttle() decorator
 * - Presets for common patterns (@ThrottleStrict, @ThrottleVeryStrict, etc.)
 * - Returns standard rate limit headers (RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset)
 * - Distributed across multiple instances via Redis
 *
 * Register globally in AppModule:
 *   { provide: APP_GUARD, useClass: DistributedThrottleGuard }
 */
@Injectable()
export class DistributedThrottleGuard implements CanActivate {
  private readonly logger = new Logger(DistributedThrottleGuard.name);

  constructor(
    private readonly cache: CacheService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    // Check if throttling is skipped
    const skipThrottle = this.reflector.getAllAndOverride<boolean>(
      SKIP_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (skipThrottle) {
      return true;
    }

    // Get config from route → controller → default
    const config =
      this.reflector.getAllAndOverride<ThrottleConfig>(THROTTLE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) || DEFAULT_CONFIG;

    // Build key: user-specific + route-specific
    const userId =
      (request as any).user?.sub ||
      request.ip ||
      request.headers['x-forwarded-for'] ||
      'anonymous';
    const routeKey = `${request.method}:${request.route?.path || request.path}`;
    const redisKey = `throttle:${userId}:${routeKey}`;

    // Atomic increment with TTL using Redis pipeline
    const client = this.cache.getClient();
    const results = await this.failOpen(
      client.multi().incr(redisKey).ttl(redisKey).exec(),
    );

    if (!results) {
      // Redis error — allow the request (fail open)
      return true;
    }

    const [[incrErr, currentCount], [ttlErr, ttl]] = results as [
      [Error | null, number],
      [Error | null, number],
    ];

    if (incrErr || ttlErr) {
      return true; // Fail open on Redis errors
    }

    // Set TTL on first request in window
    if (currentCount === 1 || ttl === -1) {
      await this.failOpen(client.expire(redisKey, config.windowSeconds));
    }

    // Calculate remaining
    const remaining = Math.max(0, config.limit - (currentCount as number));
    const resetTime = Math.ceil(Date.now() / 1000) + config.windowSeconds;

    // Set standard rate limit headers
    response.setHeader('RateLimit-Limit', config.limit);
    response.setHeader('RateLimit-Remaining', remaining);
    response.setHeader('RateLimit-Reset', resetTime);
    response.setHeader(
      'RateLimit-Policy',
      `${config.limit};w=${config.windowSeconds}`,
    );

    if ((currentCount as number) > config.limit) {
      const retryAfter = ttl > 0 ? ttl : config.windowSeconds;
      response.setHeader('Retry-After', retryAfter);

      throw new BusinessException(
        'Too many requests, please try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private async failOpen<T>(operation: Promise<T>): Promise<T | null> {
    let timeout: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        operation,
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), REDIS_GUARD_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      this.logger.warn(
        `Redis throttle check failed open: ${(error as Error).message}`,
      );
      return null;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
