import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { IdempotencyGuard } from './idempotency.guard';

describe('IdempotencyGuard', () => {
  const handler = () => undefined;

  type TestResponse = {
    statusCode: number;
    status: jest.Mock<TestResponse, [number]>;
    json: jest.Mock<TestResponse, [unknown?]>;
    send: jest.Mock<TestResponse, [unknown?]>;
    once: jest.Mock<TestResponse, [string, () => void]>;
  };

  function createContext(
    request: unknown,
    response: unknown,
  ): ExecutionContext {
    return {
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
  }

  function createResponse(statusCode = 200): TestResponse {
    const response = {} as TestResponse;
    response.statusCode = statusCode;
    response.status = jest.fn((code: number) => {
      response.statusCode = code;
      return response;
    });
    response.json = jest.fn(() => response);
    response.send = jest.fn(() => response);
    response.once = jest.fn(
      (_event: string, _listener: () => void) => response,
    );

    return response;
  }

  function createGuard(overrides?: {
    redisSet?: jest.Mock;
    cacheGet?: jest.Mock;
    cacheSet?: jest.Mock;
    cacheDel?: jest.Mock;
  }) {
    const redisSet = overrides?.redisSet ?? jest.fn().mockResolvedValue('OK');
    const cache = {
      getClient: () => ({ set: redisSet }),
      get: overrides?.cacheGet ?? jest.fn().mockResolvedValue(null),
      set: overrides?.cacheSet ?? jest.fn().mockResolvedValue(undefined),
      del: overrides?.cacheDel ?? jest.fn().mockResolvedValue(undefined),
    };
    const reflector = { get: jest.fn().mockReturnValue(undefined) };

    return {
      guard: new IdempotencyGuard(
        cache as unknown as CacheService,
        reflector as unknown as Reflector,
      ),
      cache,
      redisSet,
    };
  }

  it('caches successful JSON responses', async () => {
    const { guard, cache } = createGuard();
    const request = {
      method: 'POST',
      url: '/payments',
      headers: { 'x-idempotency-key': 'abc' },
    };
    const response = createResponse(201);

    await expect(
      guard.canActivate(createContext(request, response)),
    ).resolves.toBe(true);

    response.json({ ok: true });

    expect(cache.set).toHaveBeenCalledWith(
      'idempotency:anon:POST:/payments:abc',
      { statusCode: 201, completed: true, body: { ok: true } },
      86400,
    );
    expect(cache.del).not.toHaveBeenCalled();
  });

  it('releases the placeholder for error responses', async () => {
    const { guard, cache } = createGuard();
    const request = {
      method: 'POST',
      url: '/payments',
      headers: { 'x-idempotency-key': 'abc' },
    };
    const response = createResponse(500);

    await guard.canActivate(createContext(request, response));
    response.json({ success: false });

    expect(cache.del).toHaveBeenCalledWith(
      'idempotency:anon:POST:/payments:abc',
    );
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('replays cached responses for duplicate keys', async () => {
    const cacheGet = jest.fn().mockResolvedValue({
      statusCode: 201,
      completed: true,
      body: { ok: true },
    });
    const { guard } = createGuard({
      redisSet: jest.fn().mockResolvedValue(null),
      cacheGet,
    });
    const request = {
      method: 'POST',
      url: '/payments',
      headers: { 'x-idempotency-key': 'abc' },
    };
    const response = createResponse();

    await expect(
      guard.canActivate(createContext(request, response)),
    ).resolves.toBe(false);

    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.json).toHaveBeenCalledWith({ ok: true });
  });

  it('rejects duplicate idempotency headers instead of coercing them into one key', async () => {
    const { guard } = createGuard();
    const request = {
      method: 'POST',
      url: '/payments',
      headers: { 'x-idempotency-key': ['a,b', 'c'] },
    };
    const response = createResponse();

    await expect(
      guard.canActivate(createContext(request, response)),
    ).rejects.toThrow('x-idempotency-key header must be a single value');
  });

  it('replays cached null JSON responses', async () => {
    const cacheGet = jest.fn().mockResolvedValue({
      statusCode: 204,
      completed: true,
      body: null,
    });
    const { guard } = createGuard({
      redisSet: jest.fn().mockResolvedValue(null),
      cacheGet,
    });
    const request = {
      method: 'POST',
      url: '/payments',
      headers: { 'x-idempotency-key': 'abc' },
    };
    const response = createResponse();

    await expect(
      guard.canActivate(createContext(request, response)),
    ).resolves.toBe(false);

    expect(response.status).toHaveBeenCalledWith(204);
    expect(response.json).toHaveBeenCalledWith(null);
  });

  it('releases the placeholder when caching the successful response fails', async () => {
    const cacheSet = jest.fn().mockRejectedValue(new Error('redis down'));
    const cacheDel = jest.fn().mockResolvedValue(undefined);
    const { guard } = createGuard({ cacheSet, cacheDel });
    const request = {
      method: 'POST',
      url: '/payments',
      headers: { 'x-idempotency-key': 'abc' },
    };
    const response = createResponse(201);

    await guard.canActivate(createContext(request, response));
    response.json({ ok: true });
    await new Promise((resolve) => setImmediate(resolve));

    expect(cacheSet).toHaveBeenCalled();
    expect(cacheDel).toHaveBeenCalledWith(
      'idempotency:anon:POST:/payments:abc',
    );
  });
});
