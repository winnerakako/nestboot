import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { ConfigService } from '../config/index.js';
import { AppDb } from '../db/app-db.service.js';
import { DbModule } from '../db/db.module.js';
import { OpsDb } from '../db/ops-db.service.js';
import { DbosModule } from '../dbos/dbos.module.js';
import { WorkflowRuntime } from '../dbos/runtime.js';
import { configureHousekeeping } from './housekeeping.workflows.js';

/**
 * Hands the housekeeping schedules their database access.
 *
 * The schedules are declared at import time (that is how DBOS registers them),
 * long before DI exists — so the wiring is a one-way handoff at boot rather
 * than constructor injection.
 */
@Module({ imports: [DbModule, DbosModule] })
export class HousekeepingModule implements OnApplicationBootstrap {
  constructor(
    private readonly appDb: AppDb,
    private readonly opsDb: OpsDb,
    private readonly config: ConfigService,
    private readonly runtime: WorkflowRuntime,
  ) {}

  onApplicationBootstrap(): void {
    // Only a worker executes these; a web process never runs a workflow.
    if (!this.config.runsWorkflows) return;

    configureHousekeeping({
      opsQuery: (statement: SQL) => this.opsDb.write().execute(statement),
      appQuery: (statement: SQL) => this.appDb.write().execute(statement),
      runtime: this.runtime,
      retention: {
        logs: this.config.get('RETENTION_LOGS_DAYS'),
        requests: this.config.get('RETENTION_REQUESTS_DAYS'),
        errors: this.config.get('RETENTION_ERRORS_DAYS'),
        security: this.config.get('RETENTION_SECURITY_DAYS'),
        workflows: this.config.get('RETENTION_WORKFLOWS_DAYS'),
      },
    });
  }
}
