import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabases } from '../../../test/setup/database.js';
import {
  DEFAULT_LOCK_TIMEOUT,
  discoverMigrations,
  isValidMigrationFilename,
  migrate,
} from './migrator.js';
import { createPool } from './pool.js';

describe('migrations', () => {
  const databases = useTestDatabases();

  describe('discovery', () => {
    it('finds the platform telemetry migration and targets it at ops', () => {
      const ops = discoverMigrations('ops');
      const telemetry = ops.find((m) => m.name.endsWith('create_telemetry'));

      expect(telemetry).toBeDefined();
      expect(telemetry?.target).toBe('ops');
      expect(telemetry?.source).toBe('platform');
      expect(telemetry?.key).toBe('platform/20260101000000_create_telemetry.sql');
    });

    it('never hands an ops migration to the app database, or the reverse', () => {
      expect(discoverMigrations('app').every((m) => m.target === 'app')).toBe(true);
      expect(discoverMigrations('ops').every((m) => m.target === 'ops')).toBe(true);
    });

    it('orders by the filename timestamp so features interleave with platform', () => {
      const names = discoverMigrations().map((m) => m.key.split('/')[1] ?? '');
      expect(names).toEqual([...names].sort());
    });

    it('defaults every migration to a lock timeout', () => {
      for (const migration of discoverMigrations()) {
        expect(migration.lockTimeout).toBe(DEFAULT_LOCK_TIMEOUT);
      }
    });

    it('rejects a filename without a sortable timestamp', () => {
      expect(isValidMigrationFilename('20260101000000_create_telemetry.sql')).toBe(true);
      expect(isValidMigrationFilename('create_telemetry.sql')).toBe(false);
      expect(isValidMigrationFilename('2026_create.sql')).toBe(false);
      expect(isValidMigrationFilename('20260101000000_CreateTelemetry.sql')).toBe(false);
    });
  });

  describe('running', () => {
    it('is idempotent: a second run against a migrated database applies nothing', async () => {
      const pool = createPool({
        url: databases.opsUrl,
        max: 1,
        statementTimeoutMs: 0,
        applicationName: 'test',
      });
      try {
        // The template this database was cloned from is already migrated, so a
        // rerun must be a no-op rather than an error.
        expect(await migrate(pool, 'ops')).toEqual([]);
      } finally {
        await pool.end();
      }
    });

    it('refuses to run when an already-applied migration has been edited', async () => {
      const pool = createPool({
        url: databases.opsUrl,
        max: 1,
        statementTimeoutMs: 0,
        applicationName: 'test',
      });
      try {
        await pool.query("UPDATE _migrations SET checksum = 'tampered'");
        await expect(migrate(pool, 'ops')).rejects.toThrow(/forward-only/);
      } finally {
        await pool.end();
      }
    });
  });
});

describe('the telemetry schema the first migration creates', () => {
  const databases = useTestDatabases();
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databases.opsUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it('partitions every append-only table by day', async () => {
    const { rows } = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'ops' AND c.relkind = 'p'
       ORDER BY c.relname`,
    );

    expect(rows.map((r) => r.relname)).toEqual(['errors', 'logs', 'requests', 'security_events']);
  });

  it('seeds a window of partitions plus a default so a write can never fail', async () => {
    const { rows } = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'logs'`,
    );

    // Yesterday through seven days out, plus the default.
    expect(rows).toHaveLength(10);
    expect(rows.some((r) => r.relname === 'logs_default')).toBe(true);
  });

  it('keeps the counter and cache tables unlogged', async () => {
    const { rows } = await client.query<{ relname: string; relpersistence: string }>(
      `SELECT c.relname, c.relpersistence FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'ops' AND c.relname IN ('cache', 'rate_limit_counters')`,
    );

    expect(rows).toHaveLength(2);
    // 'u' = unlogged. These are rebuilt by use; paying WAL for them buys nothing.
    expect(rows.every((r) => r.relpersistence === 'u')).toBe(true);
  });

  it('creates and drops partitions through the helpers housekeeping uses', async () => {
    await client.query("SELECT ops.ensure_partition('logs', '2019-03-04'::date)");
    expect(await partitionExists(client, 'logs_20190304')).toBe(true);

    // Calling it twice must not raise — housekeeping reruns are normal.
    await client.query("SELECT ops.ensure_partition('logs', '2019-03-04'::date)");

    const { rows } = await client.query<{ drop_partitions_before: string }>(
      "SELECT * FROM ops.drop_partitions_before('logs', '2019-03-05'::date)",
    );
    expect(rows.map((r) => r.drop_partitions_before)).toContain('logs_20190304');
    expect(await partitionExists(client, 'logs_20190304')).toBe(false);
  });

  it('searches with the simple dictionary, so exact tokens and stop-words match', async () => {
    await client.query(
      `INSERT INTO ops.logs (id, ts, level, msg, ctx)
       VALUES (gen_random_uuid(), now(), 30, $1, '{}'::jsonb)`,
      ['user as wf_8f3a2b failed'],
    );

    // 'english' would stem these away and silently return nothing.
    for (const term of ['as', 'wf_8f3a2b']) {
      const { rows } = await client.query(
        "SELECT 1 FROM ops.logs WHERE search @@ plainto_tsquery('simple', $1)",
        [term],
      );
      expect(rows, `expected the simple dictionary to match ${term}`).toHaveLength(1);
    }
  });
});

async function partitionExists(client: Client, name: string): Promise<boolean> {
  const { rows } = await client.query('SELECT to_regclass($1) AS oid', [`ops.${name}`]);
  return rows[0]?.oid !== null;
}

describe('the migration pool', () => {
  it('treats a zero timeout as no limit on both sides', async () => {
    const { createPool } = await import('./pool.js');
    const pool = createPool({
      url: 'postgres://unused:unused@127.0.0.1:1/unused',
      max: 1,
      statementTimeoutMs: 0,
      applicationName: 'test',
    });

    try {
      const options = (pool as unknown as { options: Record<string, unknown> }).options;
      // `0 + 1000` here would give a one-second client timeout to exactly the
      // pool that asked for none, and kill any migration slower than that.
      expect(options.statement_timeout).toBe(0);
      expect(options.query_timeout).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('keeps the client timeout just beyond the server timeout elsewhere', async () => {
    const { createPool } = await import('./pool.js');
    const pool = createPool({
      url: 'postgres://unused:unused@127.0.0.1:1/unused',
      max: 1,
      statementTimeoutMs: 15_000,
      applicationName: 'test',
    });

    try {
      const options = (pool as unknown as { options: Record<string, unknown> }).options;
      expect(options.statement_timeout).toBe(15_000);
      expect(options.query_timeout).toBe(16_000);
    } finally {
      await pool.end();
    }
  });
});
