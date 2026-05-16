import type { RedisService } from './redis.service';
import { CacheService } from './cache.service';

describe('CacheService', () => {
  it('preserves scalar string values when writing and reading', async () => {
    const values = new Map<string, string>();
    const client = {
      get: jest.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
      set: jest.fn((key: string, value: string) => {
        values.set(key, value);
        return Promise.resolve('OK');
      }),
    };
    const redis = {
      getClient: () => client,
    };
    const cache = new CacheService(redis as unknown as RedisService);

    await cache.set('number-like', '123');
    await cache.set('boolean-like', 'true');
    await cache.set('null-like', 'null');

    await expect(cache.get('number-like')).resolves.toBe('123');
    await expect(cache.get('boolean-like')).resolves.toBe('true');
    await expect(cache.get('null-like')).resolves.toBe('null');
  });

  it('returns cached empty strings instead of treating them as misses', async () => {
    const client = {
      get: jest.fn().mockResolvedValue(''),
    };
    const redis = {
      getClient: () => client,
    };
    const cache = new CacheService(redis as unknown as RedisService);

    await expect(cache.get('empty')).resolves.toBe('');
  });

  it('returns empty strings from hash reads', async () => {
    const client = {
      hget: jest.fn().mockResolvedValue(''),
    };
    const redis = {
      getClient: () => client,
    };
    const cache = new CacheService(redis as unknown as RedisService);

    await expect(cache.hget('hash', 'field')).resolves.toBe('');
  });

  it('releases getOrSet locks only for the owner that acquired them', async () => {
    const client = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    };
    const redis = {
      getClient: () => client,
    };
    const cache = new CacheService(redis as unknown as RedisService);

    await expect(cache.getOrSet('user:1', async () => 'fresh')).resolves.toBe(
      'fresh',
    );

    const lockOwner = client.set.mock.calls[0][1];
    expect(client.set).toHaveBeenNthCalledWith(
      1,
      'cache:lock:user:1',
      expect.any(String),
      'EX',
      30,
      'NX',
    );
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("GET", KEYS[1]) == ARGV[1]'),
      1,
      'cache:lock:user:1',
      lockOwner,
    );
  });
});
