import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '../config/index.js';
import { declaredSchedules } from './define.js';
import { allQueues } from './queues.js';
import { ClientBackend, type DbosBackend, ExecutorBackend, WorkflowRuntime } from './runtime.js';

/**
 * Owns the engine's lifetime and decides, once, which half of the app this
 * process is.
 *
 * DBOS's system tables live in the *product* database, not the telemetry one.
 * That is the whole reason effects are exactly-once: a step can write a product
 * row and its own checkpoint in a single transaction, which is impossible
 * across two databases without a distributed commit nobody wants to operate.
 */
@Injectable()
export class DbosService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DbosService.name);
  private readonly runtime = new WorkflowRuntime(() => this.backend);
  private activeBackend?: DbosBackend;
  private clientBackend?: ClientBackend;
  private launched = false;

  constructor(private readonly config: ConfigService) {}

  get backend(): DbosBackend {
    if (!this.activeBackend) {
      throw new Error(
        'The workflow runtime was used before the application finished booting.\n' +
          'FIX: start work from a request handler or a lifecycle hook that runs after ' +
          'onApplicationBootstrap, not from a provider constructor.',
      );
    }
    return this.activeBackend;
  }

  /**
   * The runtime, or null while the engine is still connecting. Health checks
   * use this so they can report "I cannot see" rather than throwing — an
   * unreadable check is a fact worth rendering, not an error.
   */
  runtimeOrNull(): WorkflowRuntime | null {
    return this.activeBackend ? this.runtime : null;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.runsWorkflows) {
      await this.launchExecutor();
    } else {
      await this.connectClient();
    }
  }

  private async launchExecutor(): Promise<void> {
    DBOS.setConfig({
      name: this.config.get('APP_NAME'),
      systemDatabaseUrl: this.config.get('DATABASE_URL'),
      applicationVersion: this.config.get('DBOS_APP_VERSION') ?? this.config.get('GIT_SHA'),
      logLevel: this.config.get('LOG_LEVEL'),
      // The admin server is a second HTTP listener with no auth in front of it.
      runAdminServer: false,
    });

    await DBOS.launch();
    this.launched = true;
    this.activeBackend = new ExecutorBackend();

    await this.reconcileSchedules();

    this.logger.log(
      `DBOS executor launched: ${allQueues().length} queues, ` +
        `${declaredSchedules().length} declared schedules`,
    );
  }

  private async connectClient(): Promise<void> {
    this.clientBackend = await ClientBackend.create(
      this.config.get('DATABASE_URL'),
      this.config.get('APP_NAME'),
    );
    this.activeBackend = this.clientBackend;
    this.logger.log('DBOS client connected (ROLE=web: enqueue and inspect only)');
  }

  /**
   * Push code-declared schedules into DBOS's schedule table, so that they and
   * anything an operator created by hand are one list with one set of controls.
   *
   * Intentional: only the worker reconciles. A web process doing it would race
   * every other web process on every deploy, and the declarations are identical
   * anyway — there is nothing a web process knows that a worker does not.
   */
  private async reconcileSchedules(): Promise<void> {
    const declared = declaredSchedules();
    if (declared.length === 0) return;

    await this.runtime.applySchedules(
      declared.map((s) => ({
        scheduleName: s.name,
        workflowName: s.name,
        workflowFn: s.invoke,
        workflowClassName: s.className,
        schedule: s.crontab,
        cronTimezone: s.timezone,
        queueName: s.queueName,
        automaticBackfill: s.backfillMissedRuns,
      })),
    );
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Draining DBOS (${signal ?? 'no signal'})`);
    if (this.launched) {
      // Lets in-flight steps checkpoint before the process exits. Whatever does
      // not finish is recovered by another worker, because it is a row.
      await DBOS.shutdown();
      this.launched = false;
    }
    await this.clientBackend?.destroy();
    this.activeBackend = undefined;
  }
}
