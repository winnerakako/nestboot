import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { ConfigService } from '../config/index.js';
import { createPool } from './pool.js';
import * as schema from './schema/ops.js';

export type OpsDatabase = NodePgDatabase<typeof schema>;

/**
 * The telemetry database: logs, requests, errors, security events, rate-limit
 * counters, cache.
 *
 * It is a separate client from `AppDb`, not a second schema on the same one, so
 * that "no query joins across the two databases" is a fact about the code
 * rather than a rule someone has to remember. Splitting them on day one costs
 * one environment variable; splitting them at 100M rows costs a migration
 * weekend.
 */
@Injectable()
export class OpsDb implements OnModuleDestroy {
  private readonly opsPool: Pool;
  private readonly db: OpsDatabase;

  constructor(config: ConfigService) {
    this.opsPool = createPool({
      url: config.get('OPS_DATABASE_URL'),
      max: config.get('OPS_DATABASE_POOL_SIZE'),
      statementTimeoutMs: config.get('DATABASE_STATEMENT_TIMEOUT_MS'),
      applicationName: `${config.get('APP_NAME')}:ops`,
      synchronousCommitOff: true,
    });
    this.db = drizzle(this.opsPool, { schema });
  }

  read(): OpsDatabase {
    return this.db;
  }

  write(): OpsDatabase {
    return this.db;
  }

  get pool(): Pool {
    return this.opsPool;
  }

  async onModuleDestroy(): Promise<void> {
    await this.opsPool.end();
  }
}
