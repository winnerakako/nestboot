import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { ConfigService } from '../config/index.js';
import { createPool } from './pool.js';
import * as schema from './schema/app.js';

export type AppDatabase = NodePgDatabase<typeof schema>;

/**
 * The product database.
 *
 * `read()` and `write()` are separate from the first commit even though they
 * point at the same host. Adding a replica later is then a URL, not an audit of
 * every query in the codebase.
 */
@Injectable()
export class AppDb implements OnModuleDestroy {
  private readonly writePool: Pool;
  private readonly readPool: Pool;
  private readonly writeDb: AppDatabase;
  private readonly readDb: AppDatabase;
  private readonly sameHost: boolean;

  constructor(config: ConfigService) {
    const appName = config.get('APP_NAME');
    const statementTimeoutMs = config.get('DATABASE_STATEMENT_TIMEOUT_MS');

    this.writePool = createPool({
      url: config.get('DATABASE_URL'),
      max: config.get('DATABASE_POOL_SIZE'),
      statementTimeoutMs,
      applicationName: `${appName}:app:write`,
    });

    this.sameHost = config.get('DATABASE_READ_URL') === undefined;
    this.readPool = this.sameHost
      ? this.writePool
      : createPool({
          url: config.readUrl,
          max: config.get('DATABASE_POOL_SIZE'),
          statementTimeoutMs,
          applicationName: `${appName}:app:read`,
        });

    this.writeDb = drizzle(this.writePool, { schema });
    this.readDb = this.sameHost ? this.writeDb : drizzle(this.readPool, { schema });
  }

  /**
   * Queries that tolerate replica lag. Never read here and write the result
   * back — read-modify-write goes through `write()` or `tx()`.
   */
  read(): AppDatabase {
    return this.readDb;
  }

  write(): AppDatabase {
    return this.writeDb;
  }

  /** Everything inside runs on one connection, so `SET LOCAL` is safe here. */
  async tx<T>(fn: (tx: AppDatabase) => Promise<T>): Promise<T> {
    return this.writeDb.transaction(async (tx) => fn(tx as unknown as AppDatabase));
  }

  /**
   * A raw checked-out client, for the rare case that needs one (a DBOS step
   * enlisting its checkpoint in the same transaction as a product write).
   * The caller releases it.
   */
  async client(): Promise<PoolClient> {
    return this.writePool.connect();
  }

  get pool(): Pool {
    return this.writePool;
  }

  async onModuleDestroy(): Promise<void> {
    await this.writePool.end();
    if (!this.sameHost) await this.readPool.end();
  }
}
