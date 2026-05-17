import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Job, Worker, WorkerOptions } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_WORKER_OPTIONS } from './queue.config';
import { QueueService } from './queue.service';
import { AppLoggerService } from '../logging/services/app-logger.service';
import { EventService } from '../events/event.service';

/**
 * Base worker class with logging, progress tracking, lifecycle events,
 * rate limiting, and graceful shutdown.
 *
 * Usage:
 *   @Injectable()
 *   export class EmailWorker extends BaseWorker implements OnModuleInit {
 *     constructor(
 *       configService: ConfigService,
 *       appLogger: AppLoggerService,
 *       events: EventService,
 *       private readonly queueService: QueueService,
 *     ) {
 *       super('email', configService, appLogger, events, queueService);
 *     }
 *
 *     onModuleInit() {
 *       this.start({
 *         'send-welcome': (job) => this.sendWelcome(job),
 *         'send-otp': (job) => this.sendOtp(job),
 *       });
 *     }
 *
 *     private async sendWelcome(job: Job<{ to: string; name: string }>) {
 *       await job.updateProgress(10);
 *       await this.emailService.send({ ... });
 *       await job.updateProgress(100);
 *     }
 *   }
 */
export abstract class BaseWorker implements OnModuleDestroy {
  protected readonly logger: Logger;
  private worker: Worker | null = null;

  constructor(
    protected readonly queueName: string,
    protected readonly configService: ConfigService,
    protected readonly appLogger: AppLoggerService,
    protected readonly events: EventService,
    protected readonly queueService: QueueService,
  ) {
    this.logger = new Logger(`Worker:${queueName}`);
  }

  /**
   * Start processing jobs.
   * @param handlers - Map of job name → handler function
   * @param options - Override default worker options
   */
  protected start(
    handlers: Record<string, (job: Job) => Promise<any>>,
    options?: Partial<WorkerOptions>,
  ) {
    const connection = QueueService.buildConnectionConfig(this.configService);

    // Apply rate limiter if configured on the queue
    const limiter = this.queueService.getLimiterConfig(this.queueName);

    this.worker = new Worker(
      this.queueName,
      async (job: Job) => {
        const handler = handlers[job.name];
        if (!handler) {
          throw new Error(`No handler for job type: ${job.name}`);
        }

        const start = Date.now();
        this.logger.log(`Processing: ${job.name} (id: ${job.id})`);

        try {
          const result = await handler(job);
          const duration = Date.now() - start;

          this.logger.log(
            `Completed: ${job.name} (id: ${job.id}) in ${duration}ms`,
          );

          this.appLogger.info(`Job completed: ${this.queueName}/${job.name}`, {
            context: `Worker:${this.queueName}`,
            metadata: {
              jobId: job.id,
              jobName: job.name,
              duration,
              attempt: job.attemptsMade + 1,
            },
          });

          // Emit lifecycle event
          this.events.emitDynamic(`job.completed.${this.queueName}`, {
            queue: this.queueName,
            jobId: job.id,
            jobName: job.name,
            data: job.data,
            result,
            duration,
            attempt: job.attemptsMade + 1,
          });

          return result;
        } catch (error) {
          const duration = Date.now() - start;
          const err = error as Error;
          const isFinalAttempt =
            job.attemptsMade + 1 >= (job.opts.attempts || 1);

          this.appLogger.error(`Job failed: ${this.queueName}/${job.name}`, {
            context: `Worker:${this.queueName}`,
            error: err,
            metadata: {
              jobId: job.id,
              jobName: job.name,
              duration,
              attempt: job.attemptsMade + 1,
              maxAttempts: job.opts.attempts,
              isFinalAttempt,
            },
          });

          // Emit lifecycle event
          this.events.emitDynamic(`job.failed.${this.queueName}`, {
            queue: this.queueName,
            jobId: job.id,
            jobName: job.name,
            data: job.data,
            error: err.message,
            duration,
            attempt: job.attemptsMade + 1,
            isFinalAttempt,
          });

          // Alert on final failure (dead letter)
          if (isFinalAttempt) {
            this.events.emit('queue.deadLetter', {
              queue: this.queueName,
              jobName: job.name,
              jobId: job.id || 'unknown',
              failedReason: err.message,
              attemptsMade: job.attemptsMade + 1,
              timestamp: new Date(),
            });
          }

          throw error; // Re-throw so BullMQ handles retry
        }
      },
      {
        connection,
        ...DEFAULT_WORKER_OPTIONS,
        ...(limiter && { limiter }),
        ...options,
      },
    );

    // Worker-level event hooks
    this.worker.on('stalled', (jobId: string) => {
      this.logger.warn(`Job stalled: ${jobId}`);
      this.appLogger.warn(`Job stalled: ${this.queueName}/${jobId}`, {
        context: `Worker:${this.queueName}`,
        metadata: { jobId },
      });

      this.events.emitDynamic(`job.stalled.${this.queueName}`, {
        queue: this.queueName,
        jobId,
      });
    });

    this.worker.on('error', (error: Error) => {
      this.logger.error(`Worker error: ${error.message}`, error.stack);
    });

    const limiterInfo = limiter
      ? ` | rate limit: ${limiter.max}/${limiter.duration}ms`
      : '';
    this.logger.log(
      `Worker started: ${this.queueName} (concurrency: ${options?.concurrency || DEFAULT_WORKER_OPTIONS.concurrency}${limiterInfo})`,
    );
  }

  async onModuleDestroy() {
    if (this.worker) {
      this.logger.log(`Worker draining: ${this.queueName}`);
      await this.worker.close();
      this.logger.log(`Worker stopped: ${this.queueName}`);
    }
  }
}
