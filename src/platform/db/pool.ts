import { Pool, type PoolConfig } from 'pg';

export interface PoolOptions {
  url: string;
  max: number;
  statementTimeoutMs: number;
  applicationName: string;
  /** Telemetry writes are allowed to lose the last few rows on a crash. */
  synchronousCommitOff?: boolean;
}

/**
 * Every pool in the app is built here so the pooler-safe settings are impossible
 * to forget. Timeouts are sent in the startup packet rather than as `SET`
 * statements, because a transaction-pooling PgBouncer in front of us would
 * discard session-level `SET`s between statements.
 */
export function createPool(options: PoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.url,
    max: options.max,
    application_name: options.applicationName,
    statement_timeout: options.statementTimeoutMs,
    // A query cancelled server-side must not leave the client waiting — so the
    // client-side timeout sits just beyond the server's.
    //
    // Intentional: 0 means "no limit" and must propagate as 0. Computing
    // `0 + 1000` here would give a one-second client timeout to exactly the
    // pools that asked for none — the migration runner — and kill any migration
    // that takes longer than a second.
    query_timeout: options.statementTimeoutMs === 0 ? 0 : options.statementTimeoutMs + 1_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: false,
  };

  if (options.synchronousCommitOff) {
    // Intentional: durability traded for throughput, on the ops database only.
    // Losing the last few milliseconds of log rows in a crash is acceptable;
    // losing them from the product database would not be. Some hosts forbid
    // this, in which case the parameter is ignored rather than fatal.
    config.options = '-c synchronous_commit=off';
  }

  const pool = new Pool(config);

  // An unhandled 'error' on an idle client takes the process down. A pool that
  // loses a connection must degrade, not crash — health reporting is the thing
  // that tells the operator, and it cannot do that from a dead process.
  pool.on('error', (err) => {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'idle postgres client error',
        pool: options.applicationName,
        err: err.message,
      }),
    );
  });

  return pool;
}
