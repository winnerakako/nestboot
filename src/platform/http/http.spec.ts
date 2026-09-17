import { Controller, Get, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigModule, ConfigService, loadEnv } from '../config/index.js';
import { NoopErrorSink } from '../errors/error-sink.js';
import { ErrorsModule } from '../errors/errors.module.js';
import { RawResponse } from './envelope.interceptor.js';
import { HttpModule } from './http.module.js';
import {
  ConflictException,
  NotFoundException,
  RateLimitedException,
} from './platform.exception.js';
import { ProblemFilter } from './problem.filter.js';
import { ZodBody } from './zod-validation.pipe.js';

const CreateThingSchema = z.object({
  name: z.string().min(3),
  quantity: z.number().int().positive(),
});

@Controller('things')
class ThingsController {
  @Get('ok')
  ok() {
    return { id: '1', name: 'thing' };
  }

  @Get('raw')
  @RawResponse()
  raw() {
    return { notEnveloped: true };
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException('thing', 'abc123');
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException('That name is already taken.', { field: 'name' });
  }

  @Get('limited')
  limited(): never {
    throw new RateLimitedException('Slow down.', 30, { scope: 'ip' });
  }

  @Get('boom')
  boom(): never {
    throw new Error('connection to postgres://user:hunter2@db failed');
  }

  @Post('create')
  create(@ZodBody(CreateThingSchema) body: z.infer<typeof CreateThingSchema>) {
    return body;
  }
}

@Module({ imports: [ConfigModule, ErrorsModule, HttpModule], controllers: [ThingsController] })
class TestAppModule {}

describe('the HTTP response contract', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(TestAppModule, new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as never });

  describe('success', () => {
    it('wraps the body so a top-level member can be added later without breaking clients', async () => {
      const response = await call('GET', '/things/ok');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { id: '1', name: 'thing' } });
    });

    it('leaves an opted-out response alone', async () => {
      expect((await call('GET', '/things/raw')).json()).toEqual({ notEnveloped: true });
    });
  });

  describe('failure', () => {
    it('answers problem+json, not the framework default shape', async () => {
      const response = await call('GET', '/things/missing');

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({
        type: 'http://localhost:3000/problems/not-found',
        title: 'Not found',
        status: 404,
        detail: 'No thing with id abc123.',
        instance: '/things/missing',
        // The extension a client can actually branch on.
        resource: 'thing',
        id: 'abc123',
      });
    });

    it('merges an exception’s extensions into the document', async () => {
      expect((await call('GET', '/things/conflict')).json()).toMatchObject({
        status: 409,
        field: 'name',
      });
    });

    it('sets Retry-After when it tells a caller to slow down', async () => {
      const response = await call('GET', '/things/limited');
      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('30');
      expect(response.json()).toMatchObject({ scope: 'ip', retryAfterSeconds: 30 });
    });

    it('turns an unmatched route into a problem document too', async () => {
      const response = await call('GET', '/nope');
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
    });

    it('reports a validation failure as 422 with per-field errors', async () => {
      const response = await call('POST', '/things/create', { name: 'no', quantity: -1 });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        type: 'http://localhost:3000/problems/validation-failed',
        status: 422,
      });
      expect(Object.keys(response.json().errors)).toEqual(['name', 'quantity']);
    });

    it('strips unknown keys rather than passing them to an action', async () => {
      const response = await call('POST', '/things/create', {
        name: 'valid',
        quantity: 2,
        isAdmin: true,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().data).toEqual({ name: 'valid', quantity: 2 });
    });
  });

  describe('an unexpected error', () => {
    it('is reported as a bare 500 problem', async () => {
      const body = (await call('GET', '/things/boom')).json();
      expect(body.status).toBe(500);
      expect(body.type).toBe('http://localhost:3000/problems/internal-error');
    });

    it('shows the message and stack outside production, where they are the point', async () => {
      const body = (await call('GET', '/things/boom')).json();
      expect(body.detail).toContain('connection to postgres');
      expect(body.stack).toBeInstanceOf(Array);
    });
  });
});

describe('an unexpected error in production', () => {
  // Exercised directly rather than over HTTP, because the whole behaviour under
  // test is the NODE_ENV branch and booting a second app just to set it is
  // slower and no more convincing.
  function renderInProduction(error: unknown): Record<string, unknown> {
    const config = new ConfigService(
      loadEnv({
        NODE_ENV: 'production',
        APP_URL: 'https://example.com',
        TRUST_PROXY: '10.0.0.0/8',
        APP_SECRET: 'a'.repeat(32),
        DATABASE_URL: 'postgres://u:p@db/app',
        OPS_DATABASE_URL: 'postgres://u:p@db/ops',
      } as NodeJS.ProcessEnv),
    );

    let sent: Record<string, unknown> = {};
    const reply = {
      status: () => reply,
      header: () => reply,
      headers: () => reply,
      send: (body: Record<string, unknown>) => {
        sent = body;
      },
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ url: '/things/boom' }),
        getResponse: () => reply,
      }),
    };

    new ProblemFilter(config, new NoopErrorSink()).catch(error, host as never);
    return sent;
  }

  it('withholds the message, which routinely contains credentials', () => {
    const body = renderInProduction(new Error('connection to postgres://user:hunter2@db failed'));

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('postgres://');
    expect(body.detail).toBe('An unexpected error occurred.');
    expect(body.stack).toBeUndefined();
  });

  it('still shows the detail of a deliberate failure, which is written for the caller', () => {
    const body = renderInProduction(new NotFoundException('invoice', 'inv_9'));
    expect(body.detail).toBe('No invoice with id inv_9.');
    expect(body.status).toBe(404);
  });
});

describe('the problem type registry', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(TestAppModule, new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('makes every type URI it publishes dereferenceable', async () => {
    const response = await app.inject({ method: 'GET', url: '/problems/not-found' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ slug: 'not-found', title: 'Not found', status: 404 });
  });

  it('404s an unregistered slug instead of inventing documentation', async () => {
    expect((await app.inject({ method: 'GET', url: '/problems/made-up' })).statusCode).toBe(404);
  });
});
