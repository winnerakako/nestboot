import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, inject } from 'vitest';
import { withDatabase } from './global-setup.js';

export interface TestDatabases {
  /** Connection string for this file's private copy of the product database. */
  readonly appUrl: string;
  /** Connection string for this file's private copy of the telemetry database. */
  readonly opsUrl: string;
}

/**
 * Give this test file its own pair of databases, cloned from the migrated
 * templates.
 *
 * `CREATE DATABASE ... TEMPLATE` is a file-level copy inside Postgres, so this
 * costs milliseconds rather than re-running every migration — which is what
 * makes real-database tests fast enough to stay parallel and therefore fast
 * enough that people keep running them.
 */
export function useTestDatabases(): TestDatabases {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const appName = `t_app_${suffix}`;
  const opsName = `t_ops_${suffix}`;
  const databases: { appUrl: string; opsUrl: string } = { appUrl: '', opsUrl: '' };

  beforeAll(async () => {
    const adminUrl = inject('postgresUrl');
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await cloneTemplate(admin, appName, 'template_app');
      await cloneTemplate(admin, opsName, 'template_ops');
    } finally {
      await admin.end();
    }

    databases.appUrl = withDatabase(adminUrl, appName);
    databases.opsUrl = withDatabase(adminUrl, opsName);
    process.env.DATABASE_URL = databases.appUrl;
    process.env.OPS_DATABASE_URL = databases.opsUrl;
  });

  afterAll(async () => {
    const admin = new Client({ connectionString: inject('postgresUrl') });
    await admin.connect();
    try {
      for (const name of [appName, opsName]) {
        // WITH (FORCE) evicts connections a test left open; without it a leaked
        // pool turns cleanup into a hang that looks like a slow test.
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
    } finally {
      await admin.end();
    }
  });

  return databases;
}

/**
 * Clone a template database, one at a time across the whole run.
 *
 * `CREATE DATABASE ... TEMPLATE` requires that NO other session is connected to
 * the source, and it holds that source open for the duration of the copy. Test
 * files run in parallel, so without coordination eight clones stampede one
 * template: each one fails the others, and a plain retry loop turns into a
 * thundering herd that can starve for minutes.
 *
 * So they take a Postgres advisory lock and queue instead. The copies were
 * always going to serialise inside Postgres; the lock just makes them wait in
 * an orderly line rather than failing and re-colliding.
 *
 * The other half of this — and the half that actually bit — is that the
 * container's default database must NOT be a template; see `global-setup.ts`.
 */
const CLONE_LOCK = '7701332211';

async function cloneTemplate(admin: Client, target: string, template: string): Promise<void> {
  const ATTEMPTS = 40;

  await admin.query('SELECT pg_advisory_lock($1)', [CLONE_LOCK]);
  try {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        await admin.query(`CREATE DATABASE ${target} TEMPLATE ${template}`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('being accessed by other users') || attempt === ATTEMPTS) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 150));
      }
    }
  } finally {
    await admin.query('SELECT pg_advisory_unlock($1)', [CLONE_LOCK]).catch(() => {});
  }
}
