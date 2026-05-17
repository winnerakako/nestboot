import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Low-level Redis client wrapper.
 * Used by infrastructure (rate limiting, cron locks, streams, idempotency).
 *
 * For application-level caching, use CacheService instead — it provides
 * namespacing, mandatory TTL, and cache-aside patterns.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(private readonly configService: ConfigService) {
    this.client = new Redis({
      host: this.configService.get<string>('redis.host'),
      port: this.configService.get<number>('redis.port'),
      password: this.configService.get<string>('redis.password'),
      db: this.configService.get<number>('redis.db'),
      connectTimeout: 3000,
      commandTimeout: 3000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 100, 1000),
    });

    this.client.on('error', (err) => {
      this.logger.error('Redis connection error', err);
    });
  }

  async onModuleInit() {
    // Validate Redis connectivity at startup — fail fast if misconfigured
    try {
      const pong = await this.client.ping();
      if (pong !== 'PONG') {
        throw new Error(`Unexpected PING response: ${pong}`);
      }
      this.logger.log('Redis connected (PING OK)');
    } catch (error) {
      this.logger.error(
        `Redis connection failed at startup: ${(error as Error).message}. ` +
          `Rate limiting, caching, queues, and streams will not function correctly.`,
      );
    }
  }

  /**
   * Get the raw ioredis client.
   * Use for atomic operations (EVAL, MULTI, pipelines).
   */
  getClient(): Redis {
    return this.client;
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
