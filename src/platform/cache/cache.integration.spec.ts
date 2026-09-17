import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabases } from '../../../test/setup/database.js';
import { ConfigService, loadEnv } from '../config/index.js';
import { OpsDb } from '../db/ops-db.service.js';
import { fingerprint } from '../errors/error-sink.js';
import { PostgresErrorSink } from '../errors/error-sink.postgres.js';
import { PostgresErrorStore } from '../errors/error-store.postgres.js';
import { PostgresCacheStore } from './cache.postgres.js';

describe('cache and error grouping, against real Postgres', () => {
  const databases = useTestDatabases();
  let opsDb: OpsDb;
  let cache: PostgresCacheStore;
  let sink: PostgresErrorSink;
  let errors: PostgresErrorStore;

  beforeAll(() => {
    const config = new ConfigService(
      loadEnv({
        ...process.env,
        DATABASE_URL: databases.appUrl,
        OPS_DATABASE_URL: databases.opsUrl,
        APP_SECRET: 'a'.repeat(32),
      } as NodeJS.ProcessEnv),
    );
    opsDb = new OpsDb(config);
    cache = new PostgresCacheStore(opsDb);
    sink = new PostgresErrorSink(opsDb);
    errors = new PostgresErrorStore(opsDb);
  });

  afterAll(async () => {
    await sink.onApplicationShutdown();
    await opsDb.onModuleDestroy();
  });

  describe('the cache', () => {
    beforeEach(async () => {
      await opsDb.write().execute(sql`DELETE FROM ops.cache`);
    });

    it('round-trips a value', async () => {
      await cache.set('k', { hello: 'world' }, 60);
      expect(await cache.get('k')).toEqual({ hello: 'world' });
    });

    it('misses on a key it has never seen', async () => {
      expect(await cache.get('absent')).toBeNull();
    });

    it('treats an expired entry as a miss, rather than serving it', async () => {
      await cache.set('gone', 'stale', 60);
      await opsDb
        .write()
        .execute(sql`UPDATE ops.cache SET expires_at = now() - interval '1 second'`);

      // Expiry is enforced on read, not by a sweeper — a sweeper that falls
      // behind would otherwise start serving stale values.
      expect(await cache.get('gone')).toBeNull();
      expect((await cache.stats()).expired).toBeGreaterThan(0);
    });

    it('overwrites rather than failing on a repeated key', async () => {
      await cache.set('k', 'first', 60);
      await cache.set('k', 'second', 60);
      expect(await cache.get('k')).toBe('second');
    });

    it('computes once and serves the cached value afterwards', async () => {
      let computed = 0;
      const compute = async () => {
        computed++;
        return { expensive: true };
      };

      expect(await cache.remember('k', 60, compute)).toEqual({ expensive: true });
      expect(await cache.remember('k', 60, compute)).toEqual({ expensive: true });
      expect(computed).toBe(1);
    });

    it('recomputes once the cached value has expired', async () => {
      let computed = 0;
      await cache.remember('k', 60, async () => ++computed);
      await opsDb
        .write()
        .execute(sql`UPDATE ops.cache SET expires_at = now() - interval '1 second'`);
      await cache.remember('k', 60, async () => ++computed);

      expect(computed).toBe(2);
    });

    it('forgets one key, and a whole namespace by prefix', async () => {
      await cache.set('user:1:profile', 'a', 60);
      await cache.set('user:1:settings', 'b', 60);
      await cache.set('user:2:profile', 'c', 60);

      await cache.forget('user:1:profile');
      expect(await cache.get('user:1:profile')).toBeNull();
      expect(await cache.get('user:1:settings')).toBe('b');

      expect(await cache.forgetPrefix('user:1:')).toBe(1);
      expect(await cache.get('user:1:settings')).toBeNull();
      // A prefix invalidation must not reach into a neighbouring namespace.
      expect(await cache.get('user:2:profile')).toBe('c');
    });

    it('stores falsy values without confusing them for a miss', async () => {
      await cache.set('zero', 0, 60);
      await cache.set('false', false, 60);
      await cache.set('empty', '', 60);

      // A `get` that returned null for a legitimately-cached 0 would recompute
      // it on every request, forever, and look like the cache simply not working.
      expect(await cache.get('zero')).toBe(0);
      expect(await cache.get('false')).toBe(false);
      expect(await cache.get('empty')).toBe('');
    });
  });

  describe('error grouping', () => {
    beforeEach(async () => {
      await opsDb.write().execute(sql`DELETE FROM ops.errors`);
      await opsDb.write().execute(sql`DELETE FROM ops.error_groups`);
    });

    /**
     * The fingerprint is passed in rather than derived from this call site.
     *
     * `fingerprint()` walks the stack, so two calls on two different LINES of
     * this file are correctly two different groups — which is right for real
     * code and useless for testing the roll-up. Stack-derived grouping is
     * asserted separately below.
     */
    const GROUP = 'spec-fingerprint';

    const record = (message: string, fp: string = GROUP) => {
      const error = new Error(message);
      sink.record({
        fingerprint: fp,
        type: 'TypeError',
        message: error.message,
        stack: error.stack,
        status: 500,
        context: { route: '/loans/:id', feature: 'loans', requestId: 'req-1' },
        occurredAt: new Date(),
      });
    };

    it('rolls repeated occurrences of one bug into a single group', async () => {
      record('no user with id 41');
      record('no user with id 42');
      record('no user with id 43');
      await sink.flush();

      const page = await errors.groups({ limit: 10 });

      // Deliberately one group: a fingerprint that included the message would
      // produce one group per request, which is the same as no grouping at all.
      expect(page.data).toHaveLength(1);
      expect(page.data[0]?.occurrences).toBe(3);
      expect(page.data[0]?.route).toBe('/loans/:id');
    });

    it('keeps the first-seen time while advancing the last-seen time', async () => {
      record('first');
      await sink.flush();
      const initial = await errors.groups({ limit: 10 });

      record('second');
      await sink.flush();
      const updated = await errors.groups({ limit: 10 });

      expect(updated.data[0]?.firstSeenAt.getTime()).toBe(initial.data[0]?.firstSeenAt.getTime());
      expect(updated.data[0]?.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
        initial.data[0]?.lastSeenAt.getTime() ?? 0,
      );
    });

    it('does not reopen a resolved group when a straggler arrives', async () => {
      record('boom');
      await sink.flush();
      const [group] = (await errors.groups({ limit: 10 })).data;
      await errors.resolve(group!.fingerprint, 'operator');

      record('boom');
      await sink.flush();

      // An operator's judgement must not be silently undone by a request that
      // was already in flight. A genuine recurrence shows as a climbing count
      // and a fresh last-seen, which is what the tab sorts on.
      const after = await errors.group(group!.fingerprint);
      expect(after?.status).toBe('resolved');
      expect(after?.occurrences).toBe(2);
    });

    it('keeps the occurrences readable from the group', async () => {
      record('boom');
      await sink.flush();
      const [group] = (await errors.groups({ limit: 10 })).data;

      const occurrences = await errors.occurrences(group!.fingerprint, { limit: 10 });
      expect(occurrences.data).toHaveLength(1);
      expect(occurrences.data[0]?.stack).toContain('Error');
      expect(occurrences.data[0]?.requestId).toBe('req-1');
    });

    it('can be reopened after being resolved', async () => {
      record('boom');
      await sink.flush();
      const [group] = (await errors.groups({ limit: 10 })).data;

      await errors.resolve(group!.fingerprint, 'operator');
      await errors.reopen(group!.fingerprint);

      expect((await errors.group(group!.fingerprint))?.status).toBe('open');
    });
  });

  describe('fingerprinting', () => {
    it('groups two errors raised from the same place', () => {
      const raise = (message: string) => new Error(message);
      expect(fingerprint(raise('a'))).toBe(fingerprint(raise('b')));
    });

    it('separates two different error types', () => {
      expect(fingerprint(new TypeError('x'))).not.toBe(fingerprint(new RangeError('x')));
    });

    it('stays stable for an error with no application frames', () => {
      const bare = new Error('no stack');
      bare.stack = undefined;
      expect(fingerprint(bare)).toBe(fingerprint(bare));
      expect(fingerprint(bare)).toHaveLength(32);
    });
  });
});
