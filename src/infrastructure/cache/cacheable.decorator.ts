import { CacheService } from './cache.service';

/**
 * Cache key builder type — receives method arguments, returns cache key.
 */
type CacheKeyBuilder = (...args: any[]) => string;

/**
 * Decorator that caches a method's return value in Redis.
 * On subsequent calls with the same key, returns the cached value.
 *
 * Usage:
 *   @Cacheable('user', (id: string) => `user:${id}`, 600)
 *   async findById(id: string): Promise<User> {
 *     return this.prisma.user.findUnique({ where: { id } });
 *   }
 *
 *   // First call: hits DB, caches for 600s
 *   // Second call within 600s: returns from Redis, no DB query
 *
 * With composite keys:
 *   @Cacheable('search', (query, page) => `search:${query}:${page}`, 120)
 *   async search(query: string, page: number) { ... }
 *
 * Requirements:
 *   - The class must have a `cacheService` property (inject CacheService)
 *   - Method must return a Promise
 *   - Return value must be JSON-serializable
 */
export function Cacheable(
  _namespace: string,
  keyBuilder: CacheKeyBuilder,
  ttlSeconds = 300,
): MethodDecorator {
  return function (
    _target: any,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const cache: CacheService | undefined = (this as any).cacheService;

      if (!cache) {
        // No cache service injected — fall through to original method
        return originalMethod.apply(this, args);
      }

      const key = keyBuilder(...args);

      try {
        const cached = await cache.get(key);
        if (cached !== null) return cached;
      } catch {
        // Cache read failure is non-critical.
      }

      const result = await originalMethod.apply(this, args);

      try {
        await cache.set(key, result, ttlSeconds);
      } catch {
        // Cache write failure is non-critical.
      }

      return result;
    };

    return descriptor;
  };
}

/**
 * Decorator that invalidates cache keys when a method is called.
 * Use on mutation methods (create, update, delete).
 *
 * Usage:
 *   @CacheInvalidate((id: string) => [`user:${id}`, `user:${id}:*`])
 *   async updateUser(id: string, data: UpdateUserDto) {
 *     return this.prisma.user.update({ where: { id }, data });
 *   }
 */
export function CacheInvalidate(
  keysBuilder: (...args: any[]) => string[],
): MethodDecorator {
  return function (
    _target: any,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const result = await originalMethod.apply(this, args);

      const cache: CacheService | undefined = (this as any).cacheService;
      if (cache) {
        const keys = keysBuilder(...args);
        for (const key of keys) {
          try {
            if (key.includes('*')) {
              await cache.delByPattern(key);
            } else {
              await cache.del(key);
            }
          } catch {
            // Cache invalidation failure is non-critical
          }
        }
      }

      return result;
    };

    return descriptor;
  };
}
