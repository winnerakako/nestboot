import { Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabases } from '../../../test/setup/database.js';
import { ConfigModule, ConfigService } from '../config/index.js';
import { AppDb } from '../db/app-db.service.js';
import { OpsDb } from '../db/ops-db.service.js';
import { DbosService } from '../dbos/dbos.service.js';
import { PostgresErrorStore } from '../errors/error-store.postgres.js';
import { ErrorsModule } from '../errors/errors.module.js';
import { HttpModule } from '../http/index.js';
import { registerSecurity } from '../security/bootstrap.js';
import { SecurityEvents } from '../security/events/security-events.js';
import { OpsSessions } from '../security/ops-auth/ops-sessions.service.js';
import { RateLimitPolicies } from '../security/rate-limit/policy.js';
import { OpsModule } from './ops.module.js';

/**
 * Every tab, rendered, against real databases and the real stores.
 *
 * The earlier console spec stubbed one store and exercised four tabs; Errors,
 * Requests, Health and Security had never been rendered at all. A template
 * referencing a helper that does not exist, or a controller passing the wrong
 * context key, fails at render time and nothing before this would have caught it.
 */

/** A runtime with plausible data, so the workflow tabs render with content. */
class FakeRuntime {
  async list(query: { queuedOnly?: boolean; status?: string } = {}) {
    if (query.status === 'ERROR') {
      return [
        {
          workflowId: 'wf-failed-1',
          name: 'ChargeInvoice',
          status: 'ERROR',
          queueName: 'default',
          group: 'payments',
          feature: 'invoicing',
          kind: 'workflow' as const,
          createdAt: new Date(Date.now() - 60_000),
          updatedAt: new Date(),
          error: { message: 'card declined' },
        },
      ];
    }
    if (query.queuedOnly) {
      return [
        {
          workflowId: 'wf-queued-1',
          name: 'SendReceipt',
          status: 'ENQUEUED',
          queueName: 'mail',
          group: 'notifications',
          kind: 'job' as const,
          createdAt: new Date(),
        },
      ];
    }
    return [
      {
        workflowId: 'wf-ok-1',
        name: 'ChargeInvoice',
        status: 'SUCCESS',
        queueName: 'default',
        group: 'payments',
        feature: 'invoicing',
        kind: 'workflow' as const,
        createdAt: new Date(Date.now() - 120_000),
        completedAt: new Date(Date.now() - 60_000),
        recoveryAttempts: 2,
      },
    ];
  }

  async get(id: string) {
    return {
      workflowId: id,
      name: 'ChargeInvoice',
      status: 'ERROR',
      queueName: 'default',
      group: 'payments',
      createdAt: new Date(Date.now() - 120_000),
      requestId: 'req-1',
      error: { message: 'card declined' },
    };
  }

  async steps() {
    return [
      { stepNumber: 1, name: 'chargeCard', output: 'ok', error: null, childWorkflowId: null },
      {
        stepNumber: 2,
        name: 'sendReceipt',
        output: undefined,
        error: 'smtp unavailable',
        childWorkflowId: null,
        completedAt: new Date(),
      },
    ];
  }

  /** What the console actually asked the engine to do. */
  readonly calls: Array<{ action: string; arg: string }> = [];

  async cancel(id: string) {
    this.calls.push({ action: 'cancel', arg: id });
  }
  async resume(id: string) {
    this.calls.push({ action: 'resume', arg: id });
  }
  async fork(id: string, step: number) {
    this.calls.push({ action: 'fork', arg: `${id}@${step}` });
    return `forked-${id}`;
  }
  async pauseSchedule(name: string) {
    this.calls.push({ action: 'pauseSchedule', arg: name });
  }
  async resumeSchedule(name: string) {
    this.calls.push({ action: 'resumeSchedule', arg: name });
  }
  async runScheduleNow(name: string) {
    this.calls.push({ action: 'runScheduleNow', arg: name });
    return 'wf-from-schedule';
  }

  async schedules() {
    return [
      {
        name: 'ApplyRetention',
        workflowName: 'ApplyRetention',
        crontab: '30 2 * * *',
        status: 'ACTIVE',
        timezone: 'UTC',
        queueName: 'housekeeping',
        lastFiredAt: new Date(Date.now() - 3_600_000),
        backfillMissedRuns: false,
        group: 'housekeeping',
        description: 'Drop telemetry partitions past retention',
      },
      {
        name: 'NeverRun',
        workflowName: 'NeverRun',
        crontab: '0 * * * *',
        status: 'PAUSED',
        timezone: null,
        queueName: null,
        lastFiredAt: null,
        backfillMissedRuns: false,
      },
    ];
  }
}

class StubDbos {
  readonly runtime = new FakeRuntime();
  runtimeOrNull() {
    return this.runtime;
  }
}

class SignedIn {
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
  async active() {
    return [
      {
        tokenHash: 'hash',
        userId: 'user-1',
        username: 'operator',
        createdAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        ip: '127.0.0.1',
        userAgent: 'vitest',
      },
    ];
  }
  clearCookie() {}
}

@Module({ imports: [ConfigModule, ErrorsModule, HttpModule, OpsModule.forRoot()] })
class OpsTestModule {}

describe('the console, against real data', () => {
  useTestDatabases();
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [OpsTestModule] })
      .overrideProvider(DbosService)
      .useClass(StubDbos)
      .overrideProvider(OpsSessions)
      .useClass(SignedIn)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await registerSecurity(
      app.getHttpAdapter().getInstance(),
      app.get(ConfigService),
      app.get(SecurityEvents),
    );
    await app.getHttpAdapter().getInstance().ready();

    await seed(app.get(OpsDb), app.get(AppDb));
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string) => app.inject({ method: 'GET', url });

  it.each([
    ['/ops/workflows', 'Workflows'],
    ['/ops/queues', 'Queues'],
    ['/ops/schedules', 'Schedules'],
    ['/ops/logs', 'Logs'],
    ['/ops/errors', 'Errors'],
    ['/ops/requests', 'Requests'],
    ['/ops/health', 'Checks'],
    ['/ops/security', 'Rate-limit policies'],
  ])('renders %s', async (url, marker) => {
    const response = await get(url);

    expect(response.statusCode, `${url} returned ${response.statusCode}`).toBe(200);
    expect(response.body).toContain(marker);
    // A Handlebars helper that does not exist renders as nothing and a missing
    // context key renders empty — neither throws. The real signal that a
    // template is broken is the 500 above; this catches a truncated render.
    expect(response.body).toContain('</html>');
  });

  it('renders the workflow detail, including the failing step', async () => {
    const response = await get('/ops/workflows/wf-failed-1');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('chargeCard');
    expect(response.body).toContain('smtp unavailable');
    expect(response.body).toContain('Fork here');
  });

  it('renders the error detail with its occurrences', async () => {
    const response = await get('/ops/errors/fingerprint-1');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('TypeError');
    expect(response.body).toContain('Recent occurrences');
  });

  it('shows real log lines it read from Postgres', async () => {
    const response = await get('/ops/logs?window=24h');
    expect(response.body).toContain('seeded log line');
  });

  it('shows per-route request statistics it computed in Postgres', async () => {
    const response = await get('/ops/requests?window=24h');
    expect(response.body).toContain('/loans/:id');
  });

  it('reports the telemetry writers on Health, so a gap is visible', async () => {
    const response = await get('/ops/health');
    expect(response.body).toContain('Telemetry writers');
    expect(response.body).toContain('ops.logs');
  });

  it('lists the shipped rate-limit policies on Security', async () => {
    const response = await get('/ops/security');
    expect(response.body).toContain('Rate-limit policies');
    // The defaults the security migration inserts.
    expect(response.body).toContain('auth');
  });
});

/** Rows in the shapes the real writers produce. */
async function seed(opsDb: OpsDb, appDb: AppDb): Promise<void> {
  await opsDb.write().execute(sql`
    INSERT INTO ops.logs (id, ts, level, msg, ctx, request_id, route, method, status, feature)
    VALUES (${uuidv7()}, now(), 50, 'seeded log line', '{"detail":"x"}'::jsonb,
            'req-1', '/loans/:id', 'GET', 500, 'loans')
  `);

  await opsDb.write().execute(sql`
    INSERT INTO ops.requests (id, ts, route, method, status, duration_ms, feature, request_id, sample_rate)
    VALUES (${uuidv7()}, now(), '/loans/:id', 'GET', 500, 1200, 'loans', 'req-1', 1)
  `);

  await opsDb.write().execute(sql`
    INSERT INTO ops.errors (id, ts, fingerprint, type, message, stack, status, route, feature, request_id)
    VALUES (${uuidv7()}, now(), 'fingerprint-1', 'TypeError', 'x is not a function',
            'at thing (file.ts:1:1)', 500, '/loans/:id', 'loans', 'req-1')
  `);

  await opsDb.write().execute(sql`
    INSERT INTO ops.error_groups (fingerprint, type, message, route, feature, first_seen_at, last_seen_at, occurrences, status)
    VALUES ('fingerprint-1', 'TypeError', 'x is not a function', '/loans/:id', 'loans', now(), now(), 3, 'open')
  `);

  await opsDb.write().execute(sql`
    INSERT INTO ops.security_events (id, ts, kind, outcome, subject_kind, subject_id, ip, route)
    VALUES (${uuidv7()}, now(), 'login', 'failure', 'user', 'operator', '10.0.0.1'::inet, '/ops/auth/login')
  `);

  await opsDb.write().execute(sql`
    INSERT INTO ops.rate_limit_counters (subject_kind, subject_id, route_group, window_start, count)
    VALUES ('ip', '10.0.0.1', 'api', date_trunc('minute', now()), 42)
  `);

  await appDb.write().execute(sql`
    INSERT INTO ops_users (id, username, password_hash) VALUES (${uuidv7()}, 'operator', 'x')
  `);
}

/**
 * The buttons, actually clicked.
 *
 * Cancel, fork, retry, run-now, resolve, block: these are the entire reason the
 * console exists rather than being a set of dashboards. Every one of them is a
 * form POST guarded by CSRF, so "the template renders" proves nothing about
 * whether pressing the button does anything.
 *
 * Each test does what a browser does — GET the page, take the token and the
 * cookie it was issued with, then post the form — because a token that is
 * issued but never checked, or checked against the wrong cookie, looks
 * identical from the outside until an operator needs it at 3am.
 */
describe('the console’s controls', () => {
  useTestDatabases();
  let app: NestFastifyApplication;
  let dbos: StubDbos;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [OpsTestModule] })
      .overrideProvider(DbosService)
      .useClass(StubDbos)
      .overrideProvider(OpsSessions)
      .useClass(SignedIn)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await registerSecurity(
      app.getHttpAdapter().getInstance(),
      app.get(ConfigService),
      app.get(SecurityEvents),
    );
    await app.getHttpAdapter().getInstance().ready();

    dbos = app.get(DbosService) as unknown as StubDbos;
    await seed(app.get(OpsDb), app.get(AppDb));
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  /** Everything a browser carries from the rendered page to the form POST. */
  async function openForm(url: string): Promise<{ token: string; cookie: string }> {
    const page = await app.inject({ method: 'GET', url });
    expect(page.statusCode, `${url} did not render`).toBe(200);

    const token = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1];
    const cookie = /ops_csrf=[^;]+/.exec(String(page.headers['set-cookie']))?.[0];

    expect(token, `${url} rendered no CSRF token`).toBeTruthy();
    expect(cookie, `${url} issued no CSRF cookie`).toBeTruthy();
    return { token: token!, cookie: cookie! };
  }

  function submit(
    url: string,
    form: { token: string; cookie: string },
    fields: Record<string, string> = {},
  ) {
    const body = new URLSearchParams({ _csrf: form.token, ...fields }).toString();
    return app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: form.cookie },
      payload: body,
    });
  }

  describe('workflows', () => {
    it('cancels the workflow the operator was looking at', async () => {
      const form = await openForm('/ops/workflows/wf-failed-1');
      const response = await submit('/ops/workflows/wf-failed-1/cancel', form);

      expect(response.statusCode).toBe(303);
      expect(dbos.runtime.calls).toContainEqual({ action: 'cancel', arg: 'wf-failed-1' });
    });

    it('resumes a workflow', async () => {
      const form = await openForm('/ops/workflows/wf-failed-1');
      await submit('/ops/workflows/wf-failed-1/resume', form);

      expect(dbos.runtime.calls).toContainEqual({ action: 'resume', arg: 'wf-failed-1' });
    });

    it('forks from the chosen step and lands on the new workflow', async () => {
      const form = await openForm('/ops/workflows/wf-failed-1');
      const response = await submit('/ops/workflows/wf-failed-1/fork?step=2', form);

      expect(dbos.runtime.calls).toContainEqual({ action: 'fork', arg: 'wf-failed-1@2' });
      // The operator's next question is always "did the re-run work", and that
      // is a different row.
      expect(response.headers.location).toBe('/ops/workflows/forked-wf-failed-1');
    });

    it('refuses a fork without a valid step rather than guessing', async () => {
      const form = await openForm('/ops/workflows/wf-failed-1');
      const response = await submit('/ops/workflows/wf-failed-1/fork?step=nonsense', form);

      expect(response.statusCode).toBe(404);
    });
  });

  describe('queues', () => {
    it('retries a failed workflow by resuming it, not re-running it', async () => {
      const form = await openForm('/ops/queues');
      await submit('/ops/queues/workflows/wf-failed-1/retry', form);

      // Resume, so completed steps keep their results and a retry cannot repeat
      // an effect that already happened.
      expect(dbos.runtime.calls).toContainEqual({ action: 'resume', arg: 'wf-failed-1' });
    });

    it('cancels from the queues tab', async () => {
      const form = await openForm('/ops/queues');
      await submit('/ops/queues/workflows/wf-queued-1/cancel', form);

      expect(dbos.runtime.calls).toContainEqual({ action: 'cancel', arg: 'wf-queued-1' });
    });
  });

  describe('schedules', () => {
    it('pauses and resumes a schedule', async () => {
      const pause = await openForm('/ops/schedules');
      await submit('/ops/schedules/ApplyRetention/pause', pause);
      expect(dbos.runtime.calls).toContainEqual({
        action: 'pauseSchedule',
        arg: 'ApplyRetention',
      });

      const resume = await openForm('/ops/schedules');
      await submit('/ops/schedules/NeverRun/resume', resume);
      expect(dbos.runtime.calls).toContainEqual({ action: 'resumeSchedule', arg: 'NeverRun' });
    });

    it('runs a schedule now and sends the operator to the run it started', async () => {
      const form = await openForm('/ops/schedules');
      const response = await submit('/ops/schedules/ApplyRetention/run', form);

      expect(dbos.runtime.calls).toContainEqual({
        action: 'runScheduleNow',
        arg: 'ApplyRetention',
      });
      // The out-of-band run is a row in the same list, not a memory.
      expect(response.headers.location).toBe('/ops/workflows/wf-from-schedule');
    });
  });

  describe('errors', () => {
    it('resolves a group, and records who did it', async () => {
      const form = await openForm('/ops/errors/fingerprint-1');
      const response = await submit('/ops/errors/fingerprint-1/resolve', form);

      expect(response.statusCode).toBe(303);
      const group = await app.get(PostgresErrorStore).group('fingerprint-1');
      expect(group?.status).toBe('resolved');
      expect(group?.resolvedBy).toBe('operator');
    });

    it('reopens a group that was resolved', async () => {
      const form = await openForm('/ops/errors/fingerprint-1');
      await submit('/ops/errors/fingerprint-1/reopen', form);

      expect((await app.get(PostgresErrorStore).group('fingerprint-1'))?.status).toBe('open');
    });

    it('mutes a group for a day', async () => {
      const form = await openForm('/ops/errors/fingerprint-1');
      await submit('/ops/errors/fingerprint-1/mute', form);

      const group = await app.get(PostgresErrorStore).group('fingerprint-1');
      expect(group?.status).toBe('muted');
      // Long enough to get through the incident, short enough that it resurfaces
      // rather than being forgotten forever.
      expect(group?.mutedUntil?.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('security', () => {
    it('saves a rate-limit policy without a deploy', async () => {
      const form = await openForm('/ops/security');
      const response = await submit('/ops/security/policies', form, {
        routeGroup: 'api',
        subjectKind: 'ip',
        subjectId: '203.0.113.7',
        maxRequests: '25',
        windowSeconds: '60',
        action: 'reject',
        priority: '5',
        note: 'set from the console',
      });

      expect(response.statusCode).toBe(303);
      const policies = app.get(RateLimitPolicies);
      policies.invalidate();
      const saved = await policies.resolve({ kind: 'ip', id: '203.0.113.7' }, 'api');
      expect(saved?.maxRequests).toBe(25);
      expect(saved?.note).toBe('set from the console');
    });

    it('blocks a subject with a policy that expires by itself', async () => {
      const form = await openForm('/ops/security');
      await submit('/ops/security/block', form, {
        subjectKind: 'ip',
        subjectId: '203.0.113.9',
        minutes: '60',
      });

      const policies = app.get(RateLimitPolicies);
      policies.invalidate();
      const blocked = await policies.resolve({ kind: 'ip', id: '203.0.113.9' }, 'api');

      expect(blocked?.maxRequests).toBe(0);
      // It lifts itself rather than outliving everyone's memory of why it exists.
      expect(blocked?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('CSRF', () => {
    it('refuses every mutation posted without a token', async () => {
      const unguarded = [
        '/ops/workflows/wf-failed-1/cancel',
        '/ops/workflows/wf-failed-1/resume',
        '/ops/workflows/wf-failed-1/fork?step=2',
        '/ops/queues/workflows/wf-failed-1/retry',
        '/ops/queues/workflows/wf-failed-1/cancel',
        '/ops/schedules/ApplyRetention/pause',
        '/ops/schedules/ApplyRetention/resume',
        '/ops/schedules/ApplyRetention/run',
        '/ops/errors/fingerprint-1/resolve',
        '/ops/errors/fingerprint-1/mute',
        '/ops/security/policies',
        '/ops/security/block',
        '/ops/security/sessions/revoke-all',
      ];

      for (const url of unguarded) {
        const response = await app.inject({ method: 'POST', url, payload: {} });
        // Eight of these were unprotected once. The check now lives in the
        // guard, so a new controller cannot reintroduce the gap by omission.
        expect(response.statusCode, `${url} accepted a POST with no CSRF token`).toBe(403);
      }
    });

    it('refuses a token that does not match the cookie it was issued with', async () => {
      const first = await openForm('/ops/errors/fingerprint-1');
      const second = await openForm('/ops/errors/fingerprint-1');

      // A signed token paired with someone else's cookie is exactly what a
      // double-submit scheme has to reject.
      const response = await submit('/ops/errors/fingerprint-1/resolve', {
        token: first.token,
        cookie: second.cookie,
      });

      expect(response.statusCode).toBe(403);
    });

    it('refuses a forged token against a real cookie', async () => {
      const form = await openForm('/ops/errors/fingerprint-1');
      const nonce = form.cookie.split('=')[1];

      const response = await submit('/ops/errors/fingerprint-1/resolve', {
        token: `${nonce}.forged-signature`,
        cookie: form.cookie,
      });

      // The HMAC is what stops a cookie an attacker can set from becoming a
      // token the server accepts.
      expect(response.statusCode).toBe(403);
    });
  });
});
