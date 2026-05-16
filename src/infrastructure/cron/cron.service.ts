import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { randomUUID } from 'crypto';
import { CacheService } from '../cache/cache.service';
import { LogBufferService } from '../logging/services/log-buffer.service';
import { LogConnectionService } from '../logging/services/log-connection.service';
import { redact } from '../logging/services/log-redaction.service';
import { EventService } from '../events/event.service';

// ─── Types ───────────────────────────────────────────────

export interface CronLogger {
  info(message: string, metadata?: Record<string, any>): void;
  warn(message: string, metadata?: Record<string, any>): void;
  error(message: string, metadata?: Record<string, any>): void;
  debug(message: string, metadata?: Record<string, any>): void;
  signal: AbortSignal;
  throwIfAborted(): void;
}

export interface RegisterCronOptions {
  /** Unique identifier for this cron */
  name: string;
  /** Human-readable name */
  displayName: string;
  /** Description of what this cron does */
  description?: string;
  /** Category for grouping (e.g. 'payment', 'notification', 'sync', 'cleanup') */
  category?: string;
  /** Cron expression (use CronExpression enum) */
  schedule: string;
  /** IANA timezone (default: from config or UTC) */
  timezone?: string;
  /** Max lock TTL in seconds — prevents stuck locks if process crashes (default: timeout + 60s) */
  maxLockTtlSeconds?: number;
  /** Execution timeout in seconds — kills the cron if it hangs (default: 300 = 5 minutes) */
  timeoutSeconds?: number;
  /** Run once immediately on registration, then on schedule (default: false in prod, true in dev) */
  runOnInit?: boolean;
  /** Number of consecutive failures before emitting cron.alert event (default: 3) */
  alertAfterFailures?: number;
}

// Lua script for atomic lock release
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

// Basic cron expression validation
const CRON_REGEX =
  /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)(\s+(\*|[0-9,\-\/]+))?$/;

const DEFAULT_TIMEOUT_SECONDS = 300; // 5 minutes
const DEFAULT_ALERT_THRESHOLD = 3;

@Injectable()
export class CronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronService.name);
  private readonly registeredCrons = new Map<string, CronJob>();
  private readonly cronOptions = new Map<string, RegisterCronOptions>();
  private defaultTimezone: string;
  private isDev: boolean;

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cache: CacheService,
    private readonly buffer: LogBufferService,
    private readonly conn: LogConnectionService,
    private readonly configService: ConfigService,
    private readonly events: EventService,
  ) {
    this.defaultTimezone = this.configService.get<string>(
      'app.timezone',
      'UTC',
    );
    this.isDev =
      this.configService.get<string>('app.env', 'development') ===
      'development';
  }

  onModuleInit() {
    this.logger.log(
      `Cron service initialized (timezone: ${this.defaultTimezone}, dev: ${this.isDev})`,
    );
  }

  onModuleDestroy() {
    for (const [name, job] of this.registeredCrons) {
      job.stop();
      this.logger.log(`Cron stopped: ${name}`);
    }
    this.registeredCrons.clear();
  }

  /**
   * Register and schedule a managed cron job.
   */
  register(
    options: RegisterCronOptions,
    cronFn: (logger: CronLogger) => Promise<void>,
  ) {
    if (!CRON_REGEX.test(options.schedule)) {
      throw new Error(
        `Invalid cron expression for "${options.name}": "${options.schedule}"`,
      );
    }

    if (this.registeredCrons.has(options.name)) {
      this.logger.warn(`Cron "${options.name}" already registered — skipping`);
      return;
    }

    const timezone = options.timezone || this.defaultTimezone;

    const job = new CronJob(
      options.schedule,
      () => {
        this.executeCron(options, cronFn).catch((err) => {
          this.logger.error(
            `Cron "${options.name}" unhandled error: ${err.message}`,
          );
        });
      },
      null,
      false,
      timezone,
    );

    this.schedulerRegistry.addCronJob(options.name, job as any);
    this.registeredCrons.set(options.name, job);
    this.cronOptions.set(options.name, options);

    job.start();
    this.logger.log(
      `Cron registered: ${options.name} (${options.schedule}) [${timezone}]`,
    );

    const shouldRunOnInit = options.runOnInit ?? this.isDev;
    if (shouldRunOnInit) {
      this.logger.log(
        `Cron "${options.name}" — running immediately (runOnInit)`,
      );
      this.executeCron(options, cronFn).catch((err) => {
        this.logger.error(
          `Cron "${options.name}" runOnInit failed: ${err.message}`,
        );
      });
    }

    void this.registerCronConfig(options);
  }

  getRegisteredCrons(): string[] {
    return Array.from(this.registeredCrons.keys());
  }

  /**
   * Get the next run time for a cron.
   */
  getNextRunTime(name: string): Date | null {
    const job = this.registeredCrons.get(name);
    if (!job) return null;

    try {
      const next = job.nextDate();
      return next.toJSDate();
    } catch {
      return null;
    }
  }

  /**
   * Get next run times for all registered crons.
   */
  getAllNextRunTimes(): Record<string, Date | null> {
    const result: Record<string, Date | null> = {};
    for (const name of this.registeredCrons.keys()) {
      result[name] = this.getNextRunTime(name);
    }
    return result;
  }

  async triggerCron(name: string): Promise<boolean> {
    const job = this.registeredCrons.get(name);
    if (!job) return false;

    this.logger.log(`Cron "${name}" manually triggered`);
    job.fireOnTick();
    return true;
  }

  // ─── Execution Engine ──────────────────────────────────

  private async executeCron(
    options: RegisterCronOptions,
    cronFn: (logger: CronLogger) => Promise<void>,
  ) {
    const runId = randomUUID();
    const lockKey = `cron:lock:${options.name}`;
    const timeoutSeconds = options.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS;
    const lockTtl = options.maxLockTtlSeconds || timeoutSeconds + 60;
    const timeoutMs = timeoutSeconds * 1000;

    // Check if enabled
    const isEnabled = await this.isCronEnabled(options.name);
    if (!isEnabled) {
      this.logger.log(`Cron ${options.name} is disabled — skipping`);
      this.buffer.add('CronLog', {
        cronName: options.name,
        runId,
        level: 'info',
        message: 'Cron skipped — disabled',
        status: 'skipped',
        timestamp: new Date(),
      });
      return;
    }

    // Acquire distributed lock
    let acquired: string | null;
    try {
      acquired = await this.cache
        .getClient()
        .set(lockKey, runId, 'EX', lockTtl, 'NX');
    } catch (err) {
      this.logger.error(
        `Cron ${options.name} skipped — Redis unavailable for lock: ${(err as Error).message}`,
      );
      this.buffer.add('CronLog', {
        cronName: options.name,
        runId,
        level: 'error',
        message: `Cron skipped — Redis unavailable: ${(err as Error).message}`,
        status: 'skipped',
        timestamp: new Date(),
      });
      return;
    }

    if (!acquired) {
      this.logger.warn(`Cron ${options.name} already running — skipping`);
      this.buffer.add('CronLog', {
        cronName: options.name,
        runId,
        level: 'warn',
        message: 'Cron skipped — already running (locked)',
        status: 'skipped',
        timestamp: new Date(),
      });
      return;
    }

    const logs: any[] = [];
    let errorLogCount = 0;
    const abortController = new AbortController();
    const cronLogger = this.createLogger(
      options.name,
      runId,
      logs,
      () => errorLogCount++,
      abortController.signal,
    );

    const start = Date.now();
    let status: 'success' | 'error' | 'completed_with_errors' | 'timeout' =
      'success';
    let lastError: string | undefined;
    let timedOut = false;

    await this.updateCronStatus(options.name, 'running');

    try {
      cronLogger.info('Cron started');

      // Execute with timeout
      await this.executeWithTimeout(
        cronFn,
        cronLogger,
        timeoutMs,
        options.name,
        abortController,
      );

      status = errorLogCount > 0 ? 'completed_with_errors' : 'success';
      cronLogger.info('Cron completed');
    } catch (error) {
      const err = error as Error;
      if (err.message.includes('timed out')) {
        timedOut = true;
        status = 'timeout';
        lastError = `Execution timed out after ${options.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS}s`;
        cronLogger.error(lastError);
      } else {
        status = 'error';
        lastError = err.message;
        cronLogger.error(`Cron failed: ${err.message}`, { stack: err.stack });
      }
    } finally {
      const duration = Date.now() - start;
      const isFailure = status === 'error' || status === 'timeout';

      // Summary log
      logs.push({
        cronName: options.name,
        runId,
        level: isFailure
          ? 'error'
          : status === 'completed_with_errors'
            ? 'warn'
            : 'info',
        message: `Cron ${status} in ${duration}ms (${errorLogCount} errors)`,
        duration,
        status,
        timestamp: new Date(),
      });

      // Batch persist logs
      for (const log of logs) {
        this.buffer.add('CronLog', log, isFailure);
      }

      // Update config with result + consecutive failure tracking
      await this.updateCronResult(
        options.name,
        status,
        duration,
        errorLogCount,
        lastError,
        isFailure,
        options.alertAfterFailures || DEFAULT_ALERT_THRESHOLD,
        options.category,
      );

      // Release lock only when the underlying function has completed. On timeout,
      // the promise can reject while the async work keeps running in the background.
      // Let the TTL hold the lock to reduce overlapping reruns.
      if (!timedOut) {
        try {
          await this.cache
            .getClient()
            .eval(RELEASE_LOCK_SCRIPT, 1, lockKey, runId);
        } catch {
          // Lock will expire via TTL
        }
      }
    }
  }

  /**
   * Wraps cron execution with a timeout.
   * If the function doesn't complete within timeoutMs, it rejects.
   */
  private executeWithTimeout(
    cronFn: (logger: CronLogger) => Promise<void>,
    cronLogger: CronLogger,
    timeoutMs: number,
    cronName: string,
    abortController: AbortController,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        abortController.abort(
          new Error(`Cron "${cronName}" timed out after ${timeoutMs}ms`),
        );
        reject(new Error(`Cron "${cronName}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      cronFn(cronLogger)
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  // ─── Logger Factory ────────────────────────────────────

  private createLogger(
    cronName: string,
    runId: string,
    logs: any[],
    onError: () => void,
    signal: AbortSignal,
  ): CronLogger {
    const addLog = (
      level: 'debug' | 'info' | 'warn' | 'error',
      message: string,
      metadata?: Record<string, any>,
    ) => {
      logs.push({
        cronName,
        runId,
        level,
        message,
        metadata: metadata ? redact(metadata) : undefined,
        timestamp: new Date(),
      });

      if (level === 'error') onError();

      const logFn =
        level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      this.logger[logFn](`[${cronName}:${runId.slice(0, 8)}] ${message}`);
    };

    return {
      info: (msg, meta) => addLog('info', msg, meta),
      warn: (msg, meta) => addLog('warn', msg, meta),
      error: (msg, meta) => addLog('error', msg, meta),
      debug: (msg, meta) => addLog('debug', msg, meta),
      signal,
      throwIfAborted: () => {
        if (signal.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error('Cron execution aborted');
        }
      },
    };
  }

  // ─── MongoDB Config ────────────────────────────────────

  private async registerCronConfig(options: RegisterCronOptions) {
    if (!this.conn.isConnected) return;

    try {
      await this.conn.cronConfig.updateOne(
        { cronName: options.name },
        {
          $set: {
            displayName: options.displayName,
            description: options.description,
            category: options.category,
            schedule: options.schedule,
          },
          $setOnInsert: {
            cronName: options.name,
            isEnabled: true,
            runCount: 0,
            errorCount: 0,
            consecutiveFailures: 0,
          },
        },
        { upsert: true },
      );
    } catch {
      // Non-critical
    }
  }

  private async isCronEnabled(name: string): Promise<boolean> {
    if (!this.conn.isConnected) return true;

    try {
      const config = await this.conn.cronConfig.findOne({ cronName: name });
      return config ? config.isEnabled : true;
    } catch {
      return true;
    }
  }

  private async updateCronStatus(name: string, status: string) {
    if (!this.conn.isConnected) return;

    try {
      await this.conn.cronConfig.updateOne(
        { cronName: name },
        { $set: { lastRunStatus: status, lastRunAt: new Date() } },
      );
    } catch {
      // Non-critical
    }
  }

  private async updateCronResult(
    name: string,
    status: 'success' | 'error' | 'completed_with_errors' | 'timeout',
    duration: number,
    errorLogCount: number,
    lastError: string | undefined,
    isFailure: boolean,
    alertThreshold: number,
    category?: string,
  ) {
    if (!this.conn.isConnected) return;

    try {
      const update: Record<string, any> = {
        $set: {
          lastRunStatus: status,
          lastRunDuration: duration,
          lastRunAt: new Date(),
          ...(lastError && { lastError }),
          // Reset consecutive failures on success, increment on failure
          ...(!isFailure && { consecutiveFailures: 0 }),
        },
        $inc: {
          runCount: 1,
          ...(errorLogCount > 0 ? { errorCount: errorLogCount } : {}),
          ...(isFailure ? { consecutiveFailures: 1 } : {}),
        },
      };

      const result = await this.conn.cronConfig.findOneAndUpdate(
        { cronName: name },
        update,
        { new: true },
      );

      // Emit alert event if consecutive failures hit threshold
      if (result && result.consecutiveFailures >= alertThreshold) {
        this.events.emit('cron.alert', {
          cronName: name,
          category,
          consecutiveFailures: result.consecutiveFailures,
          lastError,
          lastRunStatus: status,
          lastRunDuration: duration,
          timestamp: new Date(),
        });

        this.logger.error(
          `CRON ALERT: "${name}" has failed ${result.consecutiveFailures} consecutive times`,
        );
      }
    } catch {
      // Non-critical
    }
  }
}
