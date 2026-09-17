import { ConfigError, loadEnv } from '../config/index.js';
import { type MigrationTarget, migrate } from './migrator.js';
import { createPool } from './pool.js';

/**
 * `pnpm migrate [--dry-run] [--only=app|ops]`
 *
 * Deliberately standalone: it boots no Nest container and launches no DBOS, so
 * a deploy can run it as a release step in a container that never serves
 * traffic, and a failure here stops the deploy before any new code is live.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const only = args.find((a) => a.startsWith('--only='))?.split('=')[1] as
    | MigrationTarget
    | undefined;

  if (only && only !== 'app' && only !== 'ops') {
    throw new Error(`--only must be "app" or "ops", got "${only}"`);
  }

  const env = loadEnv();
  const targets: Array<{ target: MigrationTarget; url: string }> = [
    { target: 'app', url: env.DATABASE_URL },
    { target: 'ops', url: env.OPS_DATABASE_URL },
  ].filter((t) => !only || t.target === only) as Array<{ target: MigrationTarget; url: string }>;

  for (const { target, url } of targets) {
    const pool = createPool({
      url,
      max: 1,
      // A migration on a large table legitimately takes minutes; the request
      // path's 15s ceiling would abort it partway.
      statementTimeoutMs: 0,
      applicationName: `${env.APP_NAME}:migrate:${target}`,
    });
    try {
      await migrate(pool, target, { dryRun, onProgress: (m) => console.log(m) });
    } finally {
      await pool.end();
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
