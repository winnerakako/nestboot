import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';

/**
 * Forward-only migrations, in plain SQL, run by us rather than by an ORM.
 *
 * There is no `down()`. A rollback that has run in production is a second,
 * forward migration written with knowledge of what actually broke; a `down()`
 * written months earlier is a guess that gets run in the worst ten minutes of
 * the quarter. Roll forward, or restore from backup.
 */

export type MigrationTarget = 'app' | 'ops';

export interface MigrationFile {
  /** Tracked identity: `<source>/<basename>`, unique across features. */
  readonly key: string;
  readonly name: string;
  readonly path: string;
  readonly source: string;
  readonly target: MigrationTarget;
  readonly sql: string;
  readonly checksum: string;
  /** False when the file declares `-- nontransactional` (CREATE INDEX CONCURRENTLY). */
  readonly transactional: boolean;
  readonly lockTimeout: string;
}

/** This file's directory. `__dirname` does not exist under ESM. */
const HERE = import.meta.dirname;

export const DEFAULT_LOCK_TIMEOUT = '5s';
const MIGRATION_FILENAME = /^\d{14}_[a-z0-9_]+\.sql$/;

/** Everything runs under one advisory lock, so two deploys cannot interleave. */
const ADVISORY_LOCK_KEY = 8_014_552_190_014_552n;

function platformMigrationsDir(target: MigrationTarget): string {
  return join(HERE, 'migrations', target);
}

function featuresDir(): string {
  return resolve(HERE, '..', '..', 'features');
}

function readDir(dir: string, source: string, target: MigrationTarget): MigrationFile[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((file) => {
      const path = join(dir, file);
      const sql = readFileSync(path, 'utf8');
      const header = sql.slice(0, 2000);
      const lockTimeout = /--\s*lock-timeout:\s*([0-9]+(?:ms|s|min)?)/i.exec(header)?.[1];

      return {
        key: `${source}/${file}`,
        name: basename(file, '.sql'),
        path,
        source,
        target,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16),
        transactional: !/--\s*nontransactional/i.test(header),
        lockTimeout: lockTimeout ?? DEFAULT_LOCK_TIMEOUT,
      } satisfies MigrationFile;
    });
}

/**
 * Discover every migration, ordered by filename timestamp so platform and
 * feature migrations interleave in the order they were written. A feature's
 * migrations always target the app database — a feature never writes to `ops`.
 */
export function discoverMigrations(target?: MigrationTarget): MigrationFile[] {
  const found: MigrationFile[] = [];

  if (!target || target === 'app') {
    found.push(...readDir(platformMigrationsDir('app'), 'platform', 'app'));

    const features = featuresDir();
    if (existsSync(features)) {
      for (const feature of readdirSync(features)) {
        const dir = join(features, feature, 'database', 'migrations');
        found.push(...readDir(dir, feature, 'app'));
      }
    }
  }
  if (!target || target === 'ops') {
    found.push(...readDir(platformMigrationsDir('ops'), 'platform', 'ops'));
  }

  return found.sort((a, b) => (basename(a.path) < basename(b.path) ? -1 : 1));
}

export function isValidMigrationFilename(file: string): boolean {
  return MIGRATION_FILENAME.test(basename(file));
}

export interface MigrationResult {
  key: string;
  durationMs: number;
}

export interface MigrateOptions {
  /** Report what would run without running it. */
  dryRun?: boolean;
  onProgress?: (message: string) => void;
}

const TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS _migrations (
    key         text PRIMARY KEY,
    checksum    text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer     NOT NULL
  )`;

export async function migrate(
  pool: Pool,
  target: MigrationTarget,
  options: MigrateOptions = {},
): Promise<MigrationResult[]> {
  const log = options.onProgress ?? (() => {});
  const files = discoverMigrations(target);

  // Intentional: zero discovered migrations is an error, not "nothing to do".
  // The two are indistinguishable in the output, and the usual cause is a build
  // that failed to ship the .sql files — which would otherwise report success
  // against a completely empty production database.
  if (files.length === 0) {
    throw new Error(
      `No migrations found for "${target}".\n` +
        `  looked in: ${platformMigrationsDir(target)}\n` +
        'FIX: this is almost always a packaging problem — the .sql files were not copied ' +
        'next to the compiled output. Check `pnpm build` (scripts/copy-assets.mjs). ' +
        'Reporting "up to date" here would mean reporting success against an empty database.',
    );
  }

  const badName = files.find((f) => !isValidMigrationFilename(f.path));
  if (badName) {
    throw new Error(
      `Migration ${badName.path} is misnamed.\n` +
        'FIX: rename it to <YYYYMMDDHHMMSS>_<snake_case>.sql — the timestamp is what orders ' +
        'migrations across features, so a file without one has no defined position.',
    );
  }

  const client = await pool.connect();
  try {
    await client.query(TRACKING_TABLE);
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY.toString()]);

    const { rows } = await client.query<{ key: string; checksum: string }>(
      'SELECT key, checksum FROM _migrations',
    );
    const applied = new Map(rows.map((r) => [r.key, r.checksum]));

    const drifted = files.filter((f) => applied.has(f.key) && applied.get(f.key) !== f.checksum);
    if (drifted.length > 0) {
      throw new Error(
        `These migrations changed after being applied to "${target}":\n` +
          drifted.map((f) => `  - ${f.key}`).join('\n') +
          '\nFIX: migrations are forward-only. Restore the file to what ran, and write a new ' +
          'migration for the change you wanted.',
      );
    }

    const pending = files.filter((f) => !applied.has(f.key));
    if (pending.length === 0) {
      log(`${target}: up to date (${applied.size} applied)`);
      return [];
    }
    if (options.dryRun) {
      for (const f of pending) log(`${target}: would run ${f.key}`);
      return pending.map((f) => ({ key: f.key, durationMs: 0 }));
    }

    const results: MigrationResult[] = [];
    for (const file of pending) {
      const startedAt = Date.now();
      await runOne(client, file);
      const durationMs = Date.now() - startedAt;

      await client.query(
        'INSERT INTO _migrations (key, checksum, duration_ms) VALUES ($1, $2, $3)',
        [file.key, file.checksum, durationMs],
      );
      results.push({ key: file.key, durationMs });
      log(`${target}: applied ${file.key} (${durationMs}ms)`);
    }
    return results;
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY.toString()])
      .catch(() => {});
    client.release();
  }
}

async function runOne(client: PoolClient, file: MigrationFile): Promise<void> {
  // lock_timeout bounds how long an ALTER waits behind an open transaction. A
  // migration that cannot get its lock in seconds must fail the deploy, not
  // queue behind a long read and block every writer that arrives after it.
  if (!file.transactional) {
    await client.query(`SET lock_timeout = '${file.lockTimeout}'`);
    try {
      await client.query(file.sql);
    } finally {
      await client.query('RESET lock_timeout').catch(() => {});
    }
    return;
  }

  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '${file.lockTimeout}'`);
    await client.query(file.sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(
      `Migration ${file.key} failed: ${(error as Error).message}\n  file: ${file.path}`,
      { cause: error },
    );
  }
}
