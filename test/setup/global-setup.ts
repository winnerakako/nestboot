import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';

/**
 * One Postgres container for the whole run.
 *
 * Tests run against a real database rather than a mock, because every rule this
 * template enforces — partitioning, RLS-shaped queries, `lock_timeout`, cursor
 * pagination, DBOS's own tables — is a fact about Postgres that a fake would
 * cheerfully agree with while production disagreed.
 *
 * Each test file then clones a template database (see `each-file.ts`), so files
 * stay isolated and parallel without paying container startup each.
 */

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  // An externally provided database is honoured so CI can use a service
  // container and skip Docker-in-Docker entirely.
  const external = process.env.TEST_POSTGRES_URL;

  let adminUrl: string;
  if (external) {
    adminUrl = external;
  } else {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      // Intentional NOT a template database. The connection URI points at the
      // container's default database, so naming it `template_app` would mean
      // every admin client is connected *to* the template it is about to clone
      // — and `CREATE DATABASE ... TEMPLATE` refuses while anyone is connected
      // to the source. That produced an intermittent
      // "source database is being accessed by other users" that looked exactly
      // like a race between parallel files, and was not one.
      .withDatabase('bootstrap')
      .withUsername('nestboot')
      .withPassword('nestboot')
      // tmpfs: these databases die with the run, so durability is pure cost.
      .withTmpFs({ '/var/lib/postgresql/data': 'rw,size=1g' })
      .withCommand(['postgres', '-c', 'fsync=off', '-c', 'full_page_writes=off'])
      .start();
    adminUrl = container.getConnectionUri();
  }

  await createTemplates(adminUrl);
  project.provide('postgresUrl', adminUrl);
}

/**
 * Build `template_app` and `template_ops` once, migrated. Every test file then
 * does `CREATE DATABASE x TEMPLATE template_app`, which is a file copy inside
 * Postgres rather than a re-run of every migration.
 */
async function createTemplates(adminUrl: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const name of ['template_app', 'template_ops']) {
      const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        name,
      ]);
      if (rowCount === 0) await client.query(`CREATE DATABASE ${name}`);
    }
  } finally {
    await client.end();
  }

  const { migrate } = await import('../../src/platform/db/migrator.js');
  const { createPool } = await import('../../src/platform/db/pool.js');

  for (const [target, database] of [
    ['app', 'template_app'],
    ['ops', 'template_ops'],
  ] as const) {
    const pool = createPool({
      url: withDatabase(adminUrl, database),
      max: 1,
      statementTimeoutMs: 0,
      applicationName: `nestboot:test:migrate:${target}`,
    });
    try {
      await migrate(pool, target);
    } finally {
      await pool.end();
    }
  }
}

export async function teardown(): Promise<void> {
  await container?.stop();
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

declare module 'vitest' {
  interface ProvidedContext {
    postgresUrl: string;
  }
}
