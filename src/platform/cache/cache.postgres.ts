import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OpsDb } from '../db/ops-db.service.js';
import type { CacheStats, CacheStore } from '../stores/stores.js';

/**
 * A cache on Postgres, because the alternative is worse.
 *
 * Postgres is not a fast cache. It is here anyway, on day one, because without
 * a cache *interface* the first thing anybody writes when they need one is a
 * module-level `Map` — which in a long-lived process is a cross-request leak
 * that serves one user's data to the next, and is invisible in development
 * where requests arrive one at a time.
 *
 * So the interface exists from the start, `static-state.spec.ts` points at it
 * by name, and swapping in Redis later is one provider.
 */
@Injectable()
export class PostgresCacheStore implements CacheStore {
  // Hit/miss are process-local and approximate — they are an operability
  // signal, not an accounting record, and counting them in the database would
  // cost a write on every read.
  private hits = 0;
  private misses = 0;
  private expired = 0;

  constructor(private readonly db: OpsDb) {}

  async get<T>(key: string): Promise<T | null> {
    const rows = await this.db.read().execute<{ value: T; stale: boolean }>(sql`
      SELECT value, (expires_at <= now()) AS stale FROM ops.cache WHERE key = ${key}
    `);

    const row = rows.rows[0];
    if (!row) {
      this.misses++;
      return null;
    }
    // Expiry is enforced on read, not by a sweeper: a sweeper that falls behind
    // would otherwise start serving stale values.
    if (row.stale) {
      this.expired++;
      this.misses++;
      return null;
    }

    this.hits++;
    return row.value;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.db.write().execute(sql`
      INSERT INTO ops.cache (key, value, expires_at)
      VALUES (${key}, ${JSON.stringify(value)}::jsonb, now() + make_interval(secs => ${ttlSeconds}))
      ON CONFLICT (key) DO UPDATE SET
        value = excluded.value, expires_at = excluded.expires_at, created_at = now()
    `);
  }

  /**
   * Read through.
   *
   * Intentional: NOT locked. Two concurrent misses both compute, and the second
   * write wins — a duplicated computation, which is cheap. The alternative is
   * an advisory lock held across an arbitrary callback, which turns a slow
   * computation into a pile-up of blocked connections and can deadlock. If a
   * particular value is genuinely too expensive to compute twice, that one call
   * site should take a lock, not every caller of `remember`.
   */
  async remember<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const value = await compute();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  async forget(key: string): Promise<void> {
    await this.db.write().execute(sql`DELETE FROM ops.cache WHERE key = ${key}`);
  }

  /** Invalidate a whole namespace: `forgetPrefix('user:42:')`. */
  async forgetPrefix(prefix: string): Promise<number> {
    // `LIKE 'prefix%'` with the text_pattern_ops index, so this is an index
    // range scan rather than a sequential scan of the whole cache.
    const result = await this.db.write().execute(sql`
      DELETE FROM ops.cache WHERE key LIKE ${`${prefix}%`}
    `);
    return result.rowCount ?? 0;
  }

  async stats(): Promise<CacheStats> {
    const rows = await this.db.read().execute<{ entries: string }>(sql`
      SELECT count(*)::text AS entries FROM ops.cache WHERE expires_at > now()
    `);
    return {
      entries: Number(rows.rows[0]?.entries ?? 0),
      hits: this.hits,
      misses: this.misses,
      expired: this.expired,
    };
  }

  /** Housekeeping: expired rows are unreadable and only cost space. */
  async sweep(): Promise<number> {
    const result = await this.db.write().execute(sql`
      DELETE FROM ops.cache WHERE expires_at < now() - interval '1 hour'
    `);
    return result.rowCount ?? 0;
  }
}
