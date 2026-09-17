import argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import { generateSync } from 'otplib';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabases } from '../../../test/setup/database.js';
import { ConfigService, loadEnv } from '../config/index.js';
import { AppDb } from '../db/app-db.service.js';
import { OpsDb } from '../db/ops-db.service.js';
import { SecurityEvents } from './events/security-events.js';
import { OpsSessions } from './ops-auth/ops-sessions.service.js';
import { OpsUsers } from './ops-auth/ops-users.service.js';
import { RateLimitPolicies } from './rate-limit/policy.js';
import { PostgresRateLimitStore } from './rate-limit/rate-limit.store.postgres.js';

/**
 * The security layer, against real Postgres.
 *
 * Lockout, TOTP, session revocation and policy precedence are all things whose
 * bugs are invisible until the day they matter, and every one of them depends on
 * exact SQL semantics — a concurrent UPDATE, an ON CONFLICT, a row-level lock.
 * Mocking the database here would test nothing worth testing.
 */
describe('the security layer', () => {
  const databases = useTestDatabases();
  let appDb: AppDb;
  let opsDb: OpsDb;
  let config: ConfigService;
  let users: OpsUsers;
  let sessions: OpsSessions;
  let policies: RateLimitPolicies;
  let limits: PostgresRateLimitStore;

  beforeAll(() => {
    config = new ConfigService(
      loadEnv({
        ...process.env,
        DATABASE_URL: databases.appUrl,
        OPS_DATABASE_URL: databases.opsUrl,
        APP_SECRET: 'a'.repeat(32),
        OPS_MAX_LOGIN_ATTEMPTS: '3',
        OPS_LOCKOUT_MINUTES: '15',
        OPS_SESSION_HOURS: '12',
      } as NodeJS.ProcessEnv),
    );
    appDb = new AppDb(config);
    opsDb = new OpsDb(config);
    users = new OpsUsers(appDb, config);
    sessions = new OpsSessions(appDb, config);
    policies = new RateLimitPolicies(appDb);
    limits = new PostgresRateLimitStore(opsDb);
  });

  afterAll(async () => {
    await appDb.onModuleDestroy();
    await opsDb.onModuleDestroy();
  });

  // ---- operator authentication -------------------------------------------

  describe('operator authentication', () => {
    const PASSWORD = 'correct-horse-battery-staple';
    let userId: string;

    beforeEach(async () => {
      await appDb.write().execute(sql`DELETE FROM ops_users`);
      userId = uuidv7();
      await appDb.write().execute(sql`
        INSERT INTO ops_users (id, username, password_hash)
        VALUES (${userId}, 'operator', ${await argon2.hash(PASSWORD, { type: argon2.argon2id })})
      `);
    });

    it('will not let a password alone through — a second factor is enrolled first', async () => {
      const result = await users.authenticate('operator', PASSWORD);

      expect(result.status).toBe('enrol_totp');
      if (result.status !== 'enrol_totp') return;
      expect(result.secret).toMatch(/^[A-Z2-7]{16,}$/);
      expect(result.otpauth).toContain('otpauth://totp/');
    });

    it('completes enrolment only with a code generated from the issued secret', async () => {
      const enrol = await users.authenticate('operator', PASSWORD);
      if (enrol.status !== 'enrol_totp') throw new Error('expected enrolment');

      expect((await users.authenticate('operator', PASSWORD, '000000')).status).toBe(
        'totp_invalid',
      );

      const token = generateSync({ secret: enrol.secret, strategy: 'totp' });
      expect((await users.authenticate('operator', PASSWORD, token)).status).toBe('ok');

      // Enrolled: a password on its own is now refused rather than re-enrolling.
      expect((await users.authenticate('operator', PASSWORD)).status).toBe('totp_required');
    });

    it('rejects a wrong password', async () => {
      expect((await users.authenticate('operator', 'wrong')).status).toBe('invalid');
    });

    it('reports an unknown user exactly as it reports a wrong password', async () => {
      // Distinguishing them would turn the login form into an account-existence
      // oracle, which is the first step of every credential-stuffing run.
      expect((await users.authenticate('nobody', PASSWORD)).status).toBe('invalid');
      expect((await users.authenticate('operator', 'wrong')).status).toBe('invalid');
    });

    it('locks the account after the configured number of failures', async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await users.authenticate('operator', 'wrong');
      }

      const locked = await users.authenticate('operator', PASSWORD);
      expect(locked.status).toBe('locked');
      // Even the CORRECT password is refused while locked — otherwise lockout
      // only inconveniences the attacker who was going to fail anyway.
      if (locked.status === 'locked') {
        expect(locked.until.getTime()).toBeGreaterThan(Date.now());
      }
    });

    it('clears the failure count on a successful sign-in', async () => {
      await users.authenticate('operator', 'wrong');
      await users.authenticate('operator', 'wrong');

      const enrol = await users.authenticate('operator', PASSWORD);
      if (enrol.status !== 'enrol_totp') throw new Error('expected enrolment');
      await users.authenticate(
        'operator',
        PASSWORD,
        generateSync({ secret: enrol.secret, strategy: 'totp' }),
      );

      const rows = await appDb
        .read()
        .execute<{ failed_attempts: number }>(
          sql`SELECT failed_attempts FROM ops_users WHERE id = ${userId}`,
        );
      expect(rows.rows[0]?.failed_attempts).toBe(0);
    });

    it('never stores the password in a recoverable form', async () => {
      const rows = await appDb
        .read()
        .execute<{ password_hash: string }>(
          sql`SELECT password_hash FROM ops_users WHERE id = ${userId}`,
        );
      const hash = rows.rows[0]?.password_hash ?? '';

      expect(hash).toMatch(/^\$argon2id\$/);
      expect(hash).not.toContain(PASSWORD);
    });
  });

  // ---- sessions ------------------------------------------------------------

  describe('sessions', () => {
    let userId: string;
    const cookies: Record<string, string> = {};
    const reply = {
      setCookie: (name: string, value: string) => {
        cookies[name] = value;
        return reply;
      },
      clearCookie: () => reply,
    };

    beforeEach(async () => {
      await appDb.write().execute(sql`DELETE FROM ops_users`);
      userId = uuidv7();
      await appDb.write().execute(sql`
        INSERT INTO ops_users (id, username, password_hash)
        VALUES (${userId}, 'operator', 'x')
      `);
    });

    const request = (token?: string) =>
      ({
        ip: '10.0.0.1',
        headers: { 'user-agent': 'vitest' },
        cookies: token ? { ops_session: token } : {},
      }) as never;

    it('stores only a hash of the cookie, never the cookie itself', async () => {
      const token = await sessions.create(userId, request(), reply as never);

      const rows = await appDb
        .read()
        .execute<{ token_hash: string }>(sql`SELECT token_hash FROM ops_sessions`);

      expect(rows.rows).toHaveLength(1);
      // A database dump must not hand over live sessions.
      expect(rows.rows[0]?.token_hash).not.toBe(token);
      expect(rows.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('resolves a valid cookie to the operator it belongs to', async () => {
      const token = await sessions.create(userId, request(), reply as never);
      const resolved = await sessions.resolve(request(token));

      expect(resolved?.username).toBe('operator');
      expect(resolved?.userId).toBe(userId);
    });

    it('stops accepting a revoked session immediately, not at its expiry', async () => {
      const token = await sessions.create(userId, request(), reply as never);
      await sessions.revokeByToken(token);

      expect(await sessions.resolve(request(token))).toBeNull();
    });

    it('revokes every session at once, which is what an incident needs', async () => {
      const first = await sessions.create(userId, request(), reply as never);
      const second = await sessions.create(userId, request(), reply as never);

      expect(await sessions.revokeAll()).toBe(2);
      expect(await sessions.resolve(request(first))).toBeNull();
      expect(await sessions.resolve(request(second))).toBeNull();
    });

    it('refuses an expired session', async () => {
      const token = await sessions.create(userId, request(), reply as never);
      await appDb
        .write()
        .execute(sql`UPDATE ops_sessions SET expires_at = now() - interval '1 hour'`);

      expect(await sessions.resolve(request(token))).toBeNull();
    });

    it('refuses a session whose operator has been disabled', async () => {
      const token = await sessions.create(userId, request(), reply as never);
      await appDb
        .write()
        .execute(sql`UPDATE ops_users SET disabled_at = now() WHERE id = ${userId}`);

      // Disabling an account must cut off the sessions it already has, or it
      // does nothing until they expire.
      expect(await sessions.resolve(request(token))).toBeNull();
    });

    it('refuses a forged cookie', async () => {
      await sessions.create(userId, request(), reply as never);
      expect(await sessions.resolve(request('not-a-real-token'))).toBeNull();
    });
  });

  // ---- rate limiting -------------------------------------------------------

  describe('rate limiting', () => {
    beforeEach(async () => {
      await opsDb.write().execute(sql`DELETE FROM ops.rate_limit_counters`);
      policies.invalidate();
    });

    it('ships defaults that are tight where it matters', async () => {
      const auth = await policies.resolve({ kind: 'ip', id: '1.2.3.4' }, 'auth');
      const api = await policies.resolve({ kind: 'ip', id: '1.2.3.4' }, 'api');

      expect(auth?.maxRequests).toBe(10);
      expect(api?.maxRequests).toBe(100);
      // The login endpoint must be far tighter than the general API.
      expect(auth!.maxRequests).toBeLessThan(api!.maxRequests);
    });

    it('prefers a policy for a specific subject over a general one', async () => {
      await policies.upsert({
        routeGroup: 'api',
        subjectKind: 'ip',
        subjectId: '9.9.9.9',
        maxRequests: 5000,
        windowSeconds: 60,
        burst: null,
        action: 'reject',
        priority: 0,
        enabled: true,
        note: 'a partner with a bigger allowance',
        expiresAt: null,
      });

      const specific = await policies.resolve({ kind: 'ip', id: '9.9.9.9' }, 'api');
      const general = await policies.resolve({ kind: 'ip', id: '1.1.1.1' }, 'api');

      expect(specific?.maxRequests).toBe(5000);
      expect(general?.maxRequests).toBe(100);
    });

    it('returns a real Date for the window, which the guard does arithmetic on', async () => {
      const hit = await limits.increment({ kind: 'ip', id: 'window-type' }, 'api', 60);

      // Not pedantry. `window_start` arrives as a string on the raw-execute
      // path, and typing it `Date` made `windowStart.getTime()` throw inside
      // the guard — which fail-open then swallowed, leaving the limiter
      // silently off while every counter still incremented.
      expect(hit.windowStart).toBeInstanceOf(Date);
      expect(Number.isNaN(hit.windowStart.getTime())).toBe(false);
    });

    it('enforces the limit once the allowance is spent', async () => {
      const subject = { kind: 'ip', id: 'enforced' } as const;
      await policies.upsert({
        routeGroup: 'api',
        subjectKind: 'ip',
        subjectId: subject.id,
        maxRequests: 3,
        windowSeconds: 60,
        burst: null,
        action: 'reject',
        priority: 0,
        enabled: true,
        note: 'enforcement test',
        expiresAt: null,
      });

      const policy = await policies.resolve(subject, 'api');
      const allowance = policy!.maxRequests + (policy!.burst ?? 0);

      const outcomes: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        const hit = await limits.increment(subject, 'api', policy!.windowSeconds);
        outcomes.push(hit.count <= allowance);
      }

      // Three allowed, then refused — and the refusal is derived from the same
      // arithmetic the guard performs.
      expect(outcomes).toEqual([true, true, true, false, false]);
    });

    it('counts atomically, so concurrent requests cannot both slip through', async () => {
      const subject = { kind: 'ip', id: '10.1.1.1' } as const;

      // Fifty at once against one counter. A SELECT-then-UPDATE implementation
      // loses increments here and reports a number below fifty.
      const results = await Promise.all(
        Array.from({ length: 50 }, () => limits.increment(subject, 'api', 60)),
      );

      expect(Math.max(...results.map((r) => r.count))).toBe(50);
      expect((await limits.peek(subject, 'api', 60)).count).toBe(50);
    });

    it('keeps subjects and route groups in separate buckets', async () => {
      await limits.increment({ kind: 'ip', id: 'a' }, 'api', 60);
      await limits.increment({ kind: 'ip', id: 'a' }, 'api', 60);
      await limits.increment({ kind: 'ip', id: 'b' }, 'api', 60);
      await limits.increment({ kind: 'ip', id: 'a' }, 'auth', 60);

      expect((await limits.peek({ kind: 'ip', id: 'a' }, 'api', 60)).count).toBe(2);
      expect((await limits.peek({ kind: 'ip', id: 'b' }, 'api', 60)).count).toBe(1);
      expect((await limits.peek({ kind: 'ip', id: 'a' }, 'auth', 60)).count).toBe(1);
    });

    it('blocks a subject with an expiring policy rather than a permanent list', async () => {
      const subject = { kind: 'ip', id: '6.6.6.6' } as const;
      await policies.block(subject, 60, 'blocked during an incident');

      const policy = await policies.resolve(subject, 'api');
      expect(policy?.maxRequests).toBe(0);
      // It lifts itself, rather than outliving everyone's memory of why it exists.
      expect(policy?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    });

    it('surfaces the busiest subjects for the Security tab', async () => {
      for (let i = 0; i < 5; i++) await limits.increment({ kind: 'ip', id: 'noisy' }, 'api', 60);
      await limits.increment({ kind: 'ip', id: 'quiet' }, 'api', 60);

      const top = await limits.topOffenders(undefined, 10);
      expect(top[0]).toMatchObject({ id: 'noisy', count: 5 });
    });

    it('supports shadow mode, so a new limit can be proven before it bites', async () => {
      await policies.upsert({
        routeGroup: 'api',
        subjectKind: 'ip',
        subjectId: 'shadowed',
        maxRequests: 1,
        windowSeconds: 60,
        burst: null,
        action: 'log_only',
        priority: 0,
        enabled: true,
        note: 'shadow',
        expiresAt: null,
      });

      const policy = await policies.resolve({ kind: 'ip', id: 'shadowed' }, 'api');
      expect(policy?.action).toBe('log_only');
    });
  });

  // ---- security events -----------------------------------------------------

  describe('the security audit trail', () => {
    it('records what the guards did, without recording credentials', async () => {
      const events = new SecurityEvents(opsDb);
      events.record({
        kind: 'login',
        outcome: 'failure',
        subject: { kind: 'user', id: 'operator' },
        detail: { reason: 'invalid' },
      });
      await events.flush();

      const page = await events.query({ kind: 'login', limit: 10 });
      expect(page.data[0]).toMatchObject({
        kind: 'login',
        outcome: 'failure',
        subjectId: 'operator',
      });
      // A password-spray attempt is the last thing worth storing durably.
      expect(JSON.stringify(page.data[0]?.detail)).not.toMatch(/password|secret/i);
      await events.onApplicationShutdown();
    });
  });
});
