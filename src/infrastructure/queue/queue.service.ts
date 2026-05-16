import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueOptions, JobsOptions, Job } from 'bullmq';
import { DEFAULT_JOB_OPTIONS } from './queue.config';

export interface AddJobOptions {
  delay?: number;
  priority?: number;
  attempts?: number;
  jobId?: string;
  backoff?: { type: 'exponential' | 'fixed'; delay: number };
}

export interface RegisterQueueOptions {
  /** Override default job options for this queue */
  defaultJobOptions?: Partial<JobsOptions>;
  /** Rate limit: max jobs per duration (e.g. { max: 10, duration: 1000 } = 10 jobs/sec) */
  limiter?: { max: number; duration: number };
}

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<string, Queue>();
  private readonly connectionConfig: QueueOptions['connection'];

  constructor(configService: ConfigService) {
    this.connectionConfig = QueueService.buildConnectionConfig(configService);
  }

  static buildConnectionConfig(configService: ConfigService) {
    return {
      host: configService.get<string>('redis.host', 'localhost'),
      port: configService.get<number>('redis.port', 6379),
      password: configService.get<string>('redis.password') || undefined,
      db: configService.get<number>('redis.db', 0),
    };
  }

  /**
   * Register a new queue.
   *
   * Usage:
   *   // Standard queue
   *   this.queueService.registerQueue('email');
   *
   *   // Rate-limited queue (10 jobs per second)
   *   this.queueService.registerQueue('paystack-api', {
   *     limiter: { max: 10, duration: 1000 },
   *   });
   *
   *   // Custom retry
   *   this.queueService.registerQueue('export', {
   *     defaultJobOptions: { attempts: 5 },
   *   });
   */
  registerQueue(name: string, options?: RegisterQueueOptions): Queue {
    if (this.queues.has(name)) {
      this.logger.warn(`Queue "${name}" already registered`);
      return this.queues.get(name)!;
    }

    const queueOptions: QueueOptions = {
      connection: this.connectionConfig,
      defaultJobOptions: {
        ...DEFAULT_JOB_OPTIONS,
        ...options?.defaultJobOptions,
      },
    };

    const queue = new Queue(name, queueOptions);

    this.queues.set(name, queue);

    // Store limiter config so BaseWorker can pick it up
    if (options?.limiter) {
      this.limiterConfigs.set(name, options.limiter);
    }

    const limiterInfo = options?.limiter
      ? ` (rate limited: ${options.limiter.max}/${options.limiter.duration}ms)`
      : '';
    this.logger.log(`Queue registered: ${name}${limiterInfo}`);

    return queue;
  }

  private readonly limiterConfigs = new Map<
    string,
    { max: number; duration: number }
  >();

  getLimiterConfig(
    name: string,
  ): { max: number; duration: number } | undefined {
    return this.limiterConfigs.get(name);
  }

  async addJob<T = any>(
    queueName: string,
    jobName: string,
    data: T,
    options?: AddJobOptions,
  ): Promise<string> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(
        `Queue "${queueName}" not registered. Call queueService.registerQueue('${queueName}') first.`,
      );
    }

    const jobOptions: JobsOptions = {};
    if (options?.delay) jobOptions.delay = options.delay;
    if (options?.priority) jobOptions.priority = options.priority;
    if (options?.attempts) jobOptions.attempts = options.attempts;
    if (options?.jobId) jobOptions.jobId = options.jobId;
    if (options?.backoff) jobOptions.backoff = options.backoff;

    const job = await queue.add(jobName, data, jobOptions);
    const jobId = job.id ?? `unknown-${Date.now()}`;

    this.logger.debug(`Job added: ${queueName}/${jobName} (id: ${jobId})`);

    return jobId;
  }

  async addBulk<T = any>(
    queueName: string,
    jobs: { name: string; data: T; options?: AddJobOptions }[],
  ): Promise<string[]> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue "${queueName}" not registered.`);
    }

    const bulkJobs = jobs.map((j) => ({
      name: j.name,
      data: j.data,
      opts: {
        ...(j.options?.delay && { delay: j.options.delay }),
        ...(j.options?.priority && { priority: j.options.priority }),
        ...(j.options?.attempts && { attempts: j.options.attempts }),
        ...(j.options?.jobId && { jobId: j.options.jobId }),
        ...(j.options?.backoff && { backoff: j.options.backoff }),
      },
    }));

    const result = await queue.addBulk(bulkJobs);

    this.logger.debug(`Bulk jobs added: ${result.length} to ${queueName}`);

    return result.map((j) => j.id ?? `unknown-${Date.now()}`);
  }

  getQueue(name: string): Queue | undefined {
    return this.queues.get(name);
  }

  getRegisteredQueues(): string[] {
    return Array.from(this.queues.keys());
  }

  async getQueueStats(name: string) {
    const queue = this.queues.get(name);
    if (!queue) return null;

    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
    );

    const isPaused = await queue.isPaused();

    return { name, isPaused, ...counts };
  }

  async getAllStats() {
    const stats = [];
    for (const name of this.queues.keys()) {
      stats.push(await this.getQueueStats(name));
    }
    return stats;
  }

  /**
   * Get failed jobs from a queue with pagination.
   */
  async getFailedJobs(queueName: string, start = 0, end = 20): Promise<any[]> {
    const queue = this.queues.get(queueName);
    if (!queue) return [];

    const jobs = await queue.getFailed(start, end);

    return jobs.map((job) => ({
      id: job.id,
      name: job.name,
      data: job.data,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn,
      stacktrace: job.stacktrace?.slice(0, 3),
    }));
  }

  /**
   * Retry a specific failed job.
   */
  async retryJob(queueName: string, jobId: string): Promise<boolean> {
    const queue = this.queues.get(queueName);
    if (!queue) return false;

    const job = await Job.fromId(queue, jobId);
    if (!job) return false;

    await job.retry();
    this.logger.log(`Job retried: ${queueName}/${jobId}`);
    return true;
  }

  /**
   * Retry all failed jobs in a queue.
   */
  async retryAllFailed(queueName: string): Promise<number> {
    const queue = this.queues.get(queueName);
    if (!queue) return 0;

    const failed = await queue.getFailed(0, 10000);
    let retried = 0;

    for (const job of failed) {
      try {
        await job.retry();
        retried++;
      } catch {
        // Job may have been removed or already retried
      }
    }

    this.logger.log(`Retried ${retried} failed jobs in ${queueName}`);
    return retried;
  }

  /**
   * Get a specific job by ID.
   */
  async getJob(queueName: string, jobId: string) {
    const queue = this.queues.get(queueName);
    if (!queue) return null;

    const job = await Job.fromId(queue, jobId);
    if (!job) return null;

    const state = await job.getState();

    return {
      id: job.id,
      name: job.name,
      data: job.data,
      state,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts,
      failedReason: job.failedReason,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      returnvalue: job.returnvalue,
    };
  }

  /**
   * Remove a specific job.
   */
  async removeJob(queueName: string, jobId: string): Promise<boolean> {
    const queue = this.queues.get(queueName);
    if (!queue) return false;

    const job = await Job.fromId(queue, jobId);
    if (!job) return false;

    await job.remove();
    return true;
  }

  async pauseQueue(name: string): Promise<void> {
    const queue = this.queues.get(name);
    if (queue) {
      await queue.pause();
      this.logger.log(`Queue paused: ${name}`);
    }
  }

  async resumeQueue(name: string): Promise<void> {
    const queue = this.queues.get(name);
    if (queue) {
      await queue.resume();
      this.logger.log(`Queue resumed: ${name}`);
    }
  }

  async drainQueue(name: string): Promise<void> {
    const queue = this.queues.get(name);
    if (queue) {
      await queue.drain();
      this.logger.log(`Queue drained: ${name}`);
    }
  }

  async onModuleDestroy() {
    for (const [name, queue] of this.queues) {
      await queue.close();
      this.logger.log(`Queue closed: ${name}`);
    }
    this.queues.clear();
  }
}
