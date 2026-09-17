import { Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigModule, ConfigService } from '../config/index.js';
import { DbosService } from '../dbos/dbos.service.js';
import { ErrorsModule } from '../errors/errors.module.js';
import { HttpModule } from '../http/index.js';
import { registerSecurity } from '../security/bootstrap.js';
import { SecurityEvents } from '../security/events/security-events.js';
import { OpsSessions } from '../security/ops-auth/ops-sessions.service.js';
import { RateLimitPolicies } from '../security/rate-limit/policy.js';
import { LOG_STORE, type LogRecord, type LogStore } from '../stores/stores.js';
import { inCidr } from './ops.guard.js';
import { OpsModule } from './ops.module.js';

/**
 * A DBOS service that is reachable but has no engine behind it.
 *
 * This is not a convenience for the test — it is the exact state a `ROLE=web`
 * pod is in during a database incident, and the behaviour it produces (say so,
 * do not render an empty list) is the console's single most important rule.
 */
class UnavailableDbos {
  runtimeOrNull(): null {
    return null;
  }
}

/** No policies configured, so the limiter has nothing to enforce. */
class NoPolicies {
  async all() {
    return [];
  }
  async resolve() {
    return undefined;
  }
  invalidate() {}
}

/** Every request in these tests arrives already signed in. */
class SignedInSessions {
  async resolve() {
    return {
      tokenHash: 'hash',
      userId: 'user-1',
      username: 'operator',
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      ip: '127.0.0.1',
      userAgent: 'vitest',
    };
  }
  clearCookie() {}
}

class StubLogStore implements LogStore {
  constructor(private readonly records: LogRecord[] = []) {}
  async query() {
    return { data: this.records, nextCursor: null, hasMore: false };
  }
  async facets() {
    return [{ value: '/loans/:id', count: 3 }];
  }
  async countsByLevel() {
    return { 50: 2, 30: 1 };
  }
}

const sampleLog = (overrides: Partial<LogRecord> = {}): LogRecord => ({
  id: '018f0000-0000-7000-8000-000000000001',
  ts: new Date('2026-09-16T12:00:00Z'),
  level: 30,
  msg: 'handled',
  ctx: {},
  requestId: 'req-1',
  route: '/loans/:id',
  method: 'GET',
  status: 200,
  ...overrides,
});

@Module({
  imports: [ConfigModule, ErrorsModule, HttpModule, OpsModule.forRoot()],
})
class OpsTestModule {}

/**
 * Boots the real console module with the engine and the log store replaced.
 * Everything else — routing, the guard, the CSP middleware, the templates — is
 * the production wiring.
 */
async function boot(logs: LogStore): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [OpsTestModule] })
    .overrideProvider(DbosService)
    .useClass(UnavailableDbos)
    .overrideProvider(LOG_STORE)
    .useValue(logs)
    .overrideProvider(RateLimitPolicies)
    .useClass(NoPolicies)
    .overrideProvider(OpsSessions)
    .useClass(SignedInSessions)
    .compile();

  return start(moduleRef);
}

/**
 * Boots exactly the way `main.ts` does, including the Fastify-level plugins.
 *
 * Cookies, CSRF and the security headers are registered on the Fastify instance
 * rather than by a Nest module, so a test that skipped that step would pass
 * against a console that cannot issue a session in production.
 */
async function start(moduleRef: TestingModule): Promise<NestFastifyApplication> {
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await registerSecurity(
    app.getHttpAdapter().getInstance(),
    app.get(ConfigService),
    app.get(SecurityEvents),
  );
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('the operator console', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await boot(new StubLogStore([sampleLog(), sampleLog({ level: 50, msg: 'it broke' })]));
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string) => app.inject({ method: 'GET', url });

  describe('routing and chrome', () => {
    it('lands on Workflows, because that is the question people arrive with', async () => {
      const response = await get('/ops');
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/ops/workflows');
    });

    it('renders every tab in the nav', async () => {
      const html = (await get('/ops/workflows')).body;
      for (const tab of [
        'Workflows',
        'Queues',
        'Schedules',
        'Logs',
        'Errors',
        'Requests',
        'Health',
        'Security',
      ]) {
        expect(html, `expected the ${tab} tab in the nav`).toContain(tab);
      }
    });

    it('serves its own htmx and stylesheet, so the CSP can stay self-only', async () => {
      const htmx = await get('/ops/assets/htmx.min.js');
      expect(htmx.statusCode).toBe(200);
      expect(htmx.headers['content-type']).toContain('javascript');
      expect(htmx.body.length).toBeGreaterThan(10_000);

      const css = await get('/ops/assets/ops.css');
      expect(css.statusCode).toBe(200);
      expect(css.headers['content-type']).toContain('text/css');
    });

    it('sends a content policy that forbids inline script and framing', async () => {
      const headers = (await get('/ops/workflows')).headers;
      const csp = String(headers['content-security-policy']);

      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['x-robots-tag']).toContain('noindex');
    });
  });

  describe('when it cannot read what it reports on', () => {
    it('says so on Workflows instead of rendering an empty list', async () => {
      const html = (await get('/ops/workflows')).body;

      expect(html).toContain('This view is incomplete');
      expect(html).toContain('workflow engine is not connected');
      // The distinction this whole rule exists for.
      expect(html).not.toContain('No workflows in this window');
    });

    it('says so on Queues', async () => {
      const html = (await get('/ops/queues')).body;
      expect(html).toContain('This view is incomplete');
      expect(html).toContain('cannot read');
    });

    it('says so on Schedules', async () => {
      const html = (await get('/ops/schedules')).body;
      expect(html).toContain('This view is incomplete');
    });
  });

  describe('logs', () => {
    it('groups lines under the request that produced them', async () => {
      const html = (await get('/ops/logs')).body;
      expect(html).toContain('log-group');
      expect(html).toContain('/loans/:id');
      expect(html).toContain('it broke');
    });

    it('renders the level rail and the facet counts', async () => {
      const html = (await get('/ops/logs')).body;
      expect(html).toContain('error');
      expect(html).toContain('by feature');
    });

    it('keeps filter state in the URL so a view is a shareable link', async () => {
      const html = (await get('/ops/logs?q=level%3Aerror&window=1h')).body;
      expect(html).toContain('value="level:error"');
      expect(html).toContain('<option value="1h" selected>');
    });
  });

  describe('escaping', () => {
    it('escapes a log message rather than rendering it as markup', async () => {
      // A log line is attacker-controlled: it contains whatever a request
      // header, a URL, or a thrown message contained.
      const hostile = await boot(
        new StubLogStore([sampleLog({ msg: '<script>alert(1)</script>' })]),
      );
      const html = (await hostile.inject({ method: 'GET', url: '/ops/logs' })).body;
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');

      await hostile.close();
    });
  });
});

describe('the console refuses anonymous access', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // The real OpsSessions, against a database it cannot reach — which resolves
    // to "no session", exactly like an unauthenticated visitor.
    const moduleRef = await Test.createTestingModule({ imports: [OpsTestModule] })
      .overrideProvider(DbosService)
      .useClass(UnavailableDbos)
      .overrideProvider(LOG_STORE)
      .useValue(new StubLogStore())
      .overrideProvider(RateLimitPolicies)
      .useClass(NoPolicies)
      .overrideProvider(OpsSessions)
      .useValue({ resolve: async () => null, clearCookie: () => {} })
      .compile();

    app = await start(moduleRef);
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    '/ops/workflows',
    '/ops/queues',
    '/ops/schedules',
    '/ops/logs',
    '/ops/errors',
    '/ops/requests',
    '/ops/health',
    '/ops/security',
  ])('refuses %s without a session', async (url) => {
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    // Nothing about the app's internals leaks to an anonymous visitor.
    expect(response.body).not.toContain('<table');
  });

  it('still serves the sign-in page, which is the one public route', async () => {
    const response = await app.inject({ method: 'GET', url: '/ops/auth/login' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Operator sign-in');
    // No nav: the shape of the console is not published to a stranger.
    expect(response.body).not.toContain('Workflows');
  });

  it('issues a CSRF cookie with the sign-in form', async () => {
    const response = await app.inject({ method: 'GET', url: '/ops/auth/login' });
    const cookies = String(response.headers['set-cookie']);

    expect(cookies).toContain('ops_csrf=');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('SameSite=Lax');
    expect(response.body).toContain('name="_csrf"');
  });

  it('rejects a sign-in posted without the CSRF token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ops/auth/login',
      payload: { username: 'operator', password: 'whatever' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('the ops IP allowlist', () => {
  it('matches exact addresses and CIDR ranges', () => {
    expect(inCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(inCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(inCidr('192.168.1.5', '192.168.1.0/24')).toBe(true);
    expect(inCidr('192.168.2.5', '192.168.1.0/24')).toBe(false);
    expect(inCidr('10.0.0.1', '0.0.0.0/0')).toBe(true);
  });

  it('treats an IPv4-mapped IPv6 address as the address it is', () => {
    // Node reports this form on dual-stack sockets; without it every rule
    // would silently stop matching behind a load balancer.
    expect(inCidr('::ffff:10.1.2.3', '10.0.0.0/8')).toBe(true);
  });

  it('refuses malformed input rather than matching it', () => {
    expect(inCidr('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(inCidr('10.0.0.1', '10.0.0.0/99')).toBe(false);
    expect(inCidr('10.0.0.1', 'garbage')).toBe(false);
  });
});
