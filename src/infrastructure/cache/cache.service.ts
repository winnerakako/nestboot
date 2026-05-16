import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

const CACHE_PREFIX = 'cache:';
const DEFAULT_TTL = 300; // 5 minutes
const MAX_TTL = 86400 * 30; // 30 days
const RELEASE_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

/**
 * Application-level cache service with safety guarantees.
 *
 * Features:
 * - All keys are namespaced with 'cache:' prefix (isolated from infrastructure Redis)
 * - Mandatory TTL on every set (no keys that live forever)
 * - getOrSet() cache-aside pattern (compute on miss, cache the result)
 * - Pattern-based invalidation using SCAN (not KEYS)
 * - No flush() — can't accidentally wipe infrastructure data
 *
 * Usage:
 *   // Simple get/set
 *   await this.cache.set('user:123', userData, 600); // 10 min TTL
 *   const user = await this.cache.get<User>('user:123');
 *
 *   // Cache-aside (most common pattern)
 *   const user = await this.cache.getOrSet(
 *     'user:123',
 *     () => this.userService.findById('123'), // only called on miss
 *     600, // TTL in seconds
 *   );
 *
 *   // Invalidate
 *   await this.cache.del('user:123');
 *   await this.cache.delByPattern('user:123:*'); // all sub-keys
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly client: Redis;

  constructor(private readonly redis: RedisService) {
    this.client = this.redis.getClient();
  }

  /**
   * Get the raw ioredis client for infrastructure use.
   * Throttle guard, cron locks, streams, idempotency — NOT for caching.
   */
  getClient(): Redis {
    return this.client;
  }

  // ─── Get / Set ─────────────────────────────────────────

  /**
   * Get a cached value by key.
   */
  async get<T>(key: string): Promise<T | null> {
    const value = await this.client.get(this.prefixKey(key));
    if (value === null) return null;

    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }

  /**
   * Set a cached value with mandatory TTL.
   * @param key - Cache key
   * @param value - Value to cache (serialized as JSON)
   * @param ttlSeconds - Time to live in seconds (default: 300 = 5 min, max: 30 days)
   */
  async set(key: string, value: any, ttlSeconds = DEFAULT_TTL): Promise<void> {
    const ttl = Math.min(Math.max(1, ttlSeconds), MAX_TTL);
    const serialized = JSON.stringify(value);
    await this.client.set(this.prefixKey(key), serialized, 'EX', ttl);
  }

  /**
   * Cache-aside pattern: get from cache, compute on miss, cache the result.
   * The most common caching pattern — use this instead of manual get/set.
   *
   * @param key - Cache key
   * @param fn - Function to compute the value on cache miss
   * @param ttlSeconds - TTL in seconds (default: 300)
   * @returns Cached or freshly computed value
   */
  async getOrSet<T>(
    key: string,
    fn: () => Promise<T>,
    ttlSeconds = DEFAULT_TTL,
  ): Promise<T> {
    // Check cache first
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    // Stampede protection: acquire a lock so only one caller computes.
    // Others wait and read the cached result once the winner populates it.
    const lockKey = `${CACHE_PREFIX}lock:${key}`;
    const lockOwner = randomUUID();
    const lockAcquired = await this.client.set(
      lockKey,
      lockOwner,
      'EX',
      30,
      'NX',
    );

    if (!lockAcquired) {
      // Another caller is computing — wait and retry from cache
      return this.waitForCache<T>(key, fn, ttlSeconds);
    }

    try {
      const value = await fn();

      if (value !== null && value !== undefined) {
        await this.set(key, value, ttlSeconds);
      }

      return value;
    } finally {
      await this.releaseLock(lockKey, lockOwner);
    }
  }

  /**
   * Wait for another caller to populate the cache, with timeout fallback.
   * If the cache isn't populated within 5 seconds, compute directly.
   */
  private async waitForCache<T>(
    key: string,
    fn: () => Promise<T>,
    ttlSeconds: number,
    maxWaitMs = 5000,
  ): Promise<T> {
    const start = Date.now();
    const interval = 50; // Check every 50ms

    while (Date.now() - start < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, interval));

      const cached = await this.get<T>(key);
      if (cached !== null) return cached;
    }

    // Timeout — compute directly (lock holder may have failed)
    this.logger.warn(
      `Cache stampede wait timeout for key: ${key} — computing directly`,
    );
    const value = await fn();

    if (value !== null && value !== undefined) {
      await this.set(key, value, ttlSeconds);
    }

    return value;
  }

  // ─── Deletion / Invalidation ───────────────────────────

  /**
   * Delete a specific cache key.
   */
  async del(key: string): Promise<void> {
    await this.client.del(this.prefixKey(key));
  }

  /**
   * Delete multiple cache keys.
   */
  async delMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const prefixed = keys.map((k) => this.prefixKey(k));
    await this.client.del(...prefixed);
  }

  /**
   * Delete all cache keys matching a pattern.
   * Uses SCAN (non-blocking) instead of KEYS.
   *
   * @param pattern - Glob pattern (e.g. 'user:123:*')
   */
  async delByPattern(pattern: string): Promise<number> {
    const fullPattern = this.prefixKey(pattern);
    let deleted = 0;
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH',
        fullPattern,
        'COUNT',
        '100',
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        await this.client.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');

    if (deleted > 0) {
      this.logger.debug(`Cache invalidated: ${pattern} (${deleted} keys)`);
    }

    return deleted;
  }

  // ─── Utilities ─────────────────────────────────────────

  /**
   * Check if a cache key exists.
   */
  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(this.prefixKey(key));
    return result === 1;
  }

  /**
   * Get remaining TTL for a key in seconds.
   * Returns -1 if key has no expiry, -2 if key doesn't exist.
   */
  async ttl(key: string): Promise<number> {
    return this.client.ttl(this.prefixKey(key));
  }

  /**
   * Increment a numeric cache value atomically.
   * Creates the key with value 1 if it doesn't exist.
   * Note: sets TTL only on first creation.
   */
  async incr(key: string, ttlSeconds = DEFAULT_TTL): Promise<number> {
    const prefixed = this.prefixKey(key);
    const value = await this.client.incr(prefixed);

    // Set TTL on first creation (when value becomes 1)
    if (value === 1) {
      await this.client.expire(prefixed, Math.min(ttlSeconds, MAX_TTL));
    }

    return value;
  }

  /**
   * Decrement a numeric cache value atomically.
   */
  async decr(key: string): Promise<number> {
    return this.client.decr(this.prefixKey(key));
  }

  // ─── Hash Operations (for structured cache) ────────────

  /**
   * Set a field in a hash.
   */
  async hset(
    key: string,
    field: string,
    value: any,
    ttlSeconds = DEFAULT_TTL,
  ): Promise<void> {
    const prefixed = this.prefixKey(key);
    const serialized = JSON.stringify(value);
    await this.client.hset(prefixed, field, serialized);
    await this.client.expire(prefixed, Math.min(ttlSeconds, MAX_TTL));
  }

  /**
   * Get a field from a hash.
   */
  async hget<T>(key: string, field: string): Promise<T | null> {
    const value = await this.client.hget(this.prefixKey(key), field);
    if (value === null) return null;

    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }

  /**
   * Get all fields from a hash.
   */
  async hgetall<T = Record<string, any>>(key: string): Promise<T | null> {
    const result = await this.client.hgetall(this.prefixKey(key));
    if (!result || Object.keys(result).length === 0) return null;

    const parsed: Record<string, any> = {};
    for (const [field, value] of Object.entries(result)) {
      try {
        parsed[field] = JSON.parse(value);
      } catch {
        parsed[field] = value;
      }
    }

    return parsed as T;
  }

  /**
   * Delete a field from a hash.
   */
  async hdel(key: string, ...fields: string[]): Promise<void> {
    await this.client.hdel(this.prefixKey(key), ...fields);
  }

  // ─── Internal ──────────────────────────────────────────

  private prefixKey(key: string): string {
    return `${CACHE_PREFIX}${key}`;
  }

  private async releaseLock(lockKey: string, owner: string): Promise<void> {
    await this.client.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, owner);
  }
}
