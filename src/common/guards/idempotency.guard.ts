import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { BusinessException } from '../filters';

export const IDEMPOTENCY_KEY = 'idempotency';
const IDEMPOTENCY_HEADER = 'x-idempotency-key';
const DEFAULT_TTL = 86400; // 24 hours

interface CachedIdempotentResponse {
  statusCode: number;
  completed: true;
  body: any;
}

interface RedisResult<T> {
  value: T;
}

@Injectable()
export class IdempotencyGuard implements CanActivate {
  private readonly logger = new Logger(IdempotencyGuard.name);

  constructor(
    private readonly cache: CacheService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      return true;
    }

    const idempotencyKey = request.headers[IDEMPOTENCY_HEADER] as string;

    if (!idempotencyKey) {
      const required = this.reflector.get<boolean>(
        IDEMPOTENCY_KEY,
        context.getHandler(),
      );
      if (required) {
        throw new BusinessException(
          `${IDEMPOTENCY_HEADER} header is required for this endpoint`,
          HttpStatus.BAD_REQUEST,
        );
      }
      return true;
    }

    const cacheKey = `idempotency:${request.method}:${request.url}:${idempotencyKey}`;
    const redisKey = `cache:${cacheKey}`;
    const ttl =
      this.reflector.get<number>(IDEMPOTENCY_KEY, context.getHandler()) ||
      DEFAULT_TTL;

    // Atomic SET NX — only succeeds if key doesn't exist, prevents race conditions
    const acquiredResult = await this.redisFailOpen(
      this.cache
        .getClient()
        .set(
          redisKey,
          JSON.stringify({ statusCode: 202, completed: false, body: null }),
          'EX',
          ttl,
          'NX',
        ),
    );

    if (!acquiredResult) {
      return true;
    }

    const acquired = acquiredResult.value;
    if (!acquired) {
      // Key already exists — check if it has a real response cached
      const cachedResult = await this.redisFailOpen(
        this.cache.get<CachedIdempotentResponse>(cacheKey),
      );
      const cached = cachedResult?.value;

      if (cached?.completed) {
        response.status(cached.statusCode).json(cached.body);
        return false;
      }

      // Still processing from another request — return 409
      throw new BusinessException(
        'Request is already being processed',
        HttpStatus.CONFLICT,
      );
    }

    // Hook into response to cache the actual result
    let committed = false;
    let finished = false;
    const originalJson = response.json.bind(response);
    const originalSend = response.send.bind(response);

    const releasePlaceholder = (): void => {
      void this.redisFailOpen(this.cache.del(cacheKey));
    };

    const commitJson = (body: any) => {
      if (committed) return;
      committed = true;

      if (response.statusCode >= 400) {
        releasePlaceholder();
        return;
      }

      void this.cacheCompletedResponse(cacheKey, {
        statusCode: response.statusCode,
        completed: true,
        body,
        ttl,
      });
    };

    response.json = (body: any) => {
      commitJson(body);
      return originalJson(body);
    };

    response.send = (body: any) => {
      if (!committed) {
        releasePlaceholder();
      }
      return originalSend(body);
    };

    response.once('finish', () => {
      finished = true;
      if (!committed) releasePlaceholder();
    });

    response.once('close', () => {
      if (!finished && !committed) releasePlaceholder();
    });

    return true;
  }

  private async redisFailOpen<T>(
    operation: Promise<T>,
  ): Promise<RedisResult<T> | null> {
    try {
      return { value: await operation };
    } catch (error) {
      this.logger.warn(
        `Redis idempotency check failed open: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async cacheCompletedResponse(
    cacheKey: string,
    response: CachedIdempotentResponse & { ttl: number },
  ): Promise<void> {
    const { ttl, ...cachedResponse } = response;
    const result = await this.redisFailOpen(
      this.cache.set(cacheKey, cachedResponse, ttl),
    );

    if (!result) {
      await this.redisFailOpen(this.cache.del(cacheKey));
    }
  }
}
