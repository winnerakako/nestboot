import { Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { StreamService, StreamMessage } from './stream.service';
import { AppLoggerService } from '../logging/services/app-logger.service';

export interface StreamConsumerOptions {
  /** Stream to consume from */
  stream: string;
  /** Consumer group name (all instances of this service share the group) */
  group: string;
  /** Unique consumer name (default: hostname + pid) */
  consumer?: string;
  /** Max messages to read per poll (default: 10) */
  batchSize?: number;
  /** Block time in ms waiting for new messages (default: 5000) */
  blockMs?: number;
  /** Concurrent message processing within this consumer (default: 1) */
  concurrency?: number;
  /** Interval in ms to check for stale/dead messages (default: 30000) */
  claimIntervalMs?: number;
  /** Min idle time in ms before claiming a stale message (default: 60000) */
  claimMinIdleMs?: number;
  /** Max delivery attempts before sending to dead letter (default: 5) */
  maxRetries?: number;
}

/**
 * Base class for stream consumers with:
 * - Automatic consumer group creation
 * - Configurable concurrency
 * - Dead letter handling with delivery count tracking
 * - Stale message claiming (crashed consumer recovery)
 * - Graceful shutdown (waits for active processing)
 *
 * Usage:
 *   @Injectable()
 *   export class LedgerConsumer extends BaseStreamConsumer implements OnModuleInit, OnModuleDestroy {
 *     constructor(stream: StreamService, logger: AppLoggerService) {
 *       super(stream, logger, {
 *         stream: 'payment.confirmed',
 *         group: 'ledger-service',
 *         concurrency: 5,
 *       });
 *     }
 *
 *     async handleMessage(message: StreamMessage) {
 *       await this.createLedgerEntries(message.data);
 *     }
 *   }
 */
export abstract class BaseStreamConsumer
  implements OnModuleInit, OnModuleDestroy
{
  protected readonly logger: Logger;
  private running = false;
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private activeCount = 0;
  private pollFailures = 0;
  private readonly activeMessageIds = new Set<string>();
  private readonly consumerName: string;
  private readonly opts: Required<
    Pick<
      StreamConsumerOptions,
      | 'batchSize'
      | 'blockMs'
      | 'concurrency'
      | 'claimIntervalMs'
      | 'claimMinIdleMs'
      | 'maxRetries'
    >
  > &
    StreamConsumerOptions;

  constructor(
    protected readonly streamService: StreamService,
    protected readonly appLogger: AppLoggerService,
    options: StreamConsumerOptions,
  ) {
    this.consumerName =
      options.consumer || `${process.env.HOSTNAME || 'worker'}-${process.pid}`;
    this.opts = {
      batchSize: 10,
      blockMs: 5000,
      concurrency: 1,
      claimIntervalMs: 30000,
      claimMinIdleMs: 60000,
      maxRetries: 5,
      ...options,
    };
    this.logger = new Logger(`StreamConsumer:${options.group}`);
  }

  /**
   * Override to process each message.
   * Throw to nack — message stays pending for retry.
   */
  abstract handleMessage(message: StreamMessage): Promise<void>;

  /**
   * Called when a message exceeds maxRetries.
   * Override for custom dead letter handling (store in DB, alert, etc.).
   * Default: logs an error and acks the message to remove from pending.
   */
  async handleDeadLetter(
    message: StreamMessage,
    _error?: Error,
  ): Promise<void> {
    this.appLogger.error(
      `Dead letter: ${this.opts.stream}/${this.opts.group} - message ${message.id}`,
      {
        context: `StreamConsumer:${this.opts.group}`,
        metadata: {
          stream: this.opts.stream,
          group: this.opts.group,
          messageId: message.id,
          data: message.data,
        },
      },
    );
  }

  async onModuleInit() {
    await this.streamService.createConsumerGroup(
      this.opts.stream,
      this.opts.group,
    );

    this.running = true;

    // Start poll loop with error catching on the detached promise
    this.poll().catch((err) => {
      this.logger.error(`Poll loop crashed: ${err.message}`);
    });

    // Periodically claim stale messages from crashed consumers
    this.claimTimer = setInterval(
      () => this.claimStaleMessages().catch(() => {}),
      this.opts.claimIntervalMs,
    );

    this.logger.log(
      `Consumer started: ${this.opts.group}/${this.consumerName} on ${this.opts.stream} (concurrency: ${this.opts.concurrency})`,
    );
  }

  async onModuleDestroy() {
    this.running = false;

    if (this.claimTimer) {
      clearInterval(this.claimTimer);
      this.claimTimer = null;
    }

    // Wait for active processing to finish (up to 10s)
    const deadline = Date.now() + 10000;
    while (this.activeCount > 0 && Date.now() < deadline) {
      await this.sleep(100);
    }

    this.logger.log(
      `Consumer stopped: ${this.opts.group}/${this.consumerName}`,
    );
  }

  // ─── Polling Loop ──────────────────────────────────────

  private async poll() {
    while (this.running) {
      try {
        const available = this.opts.concurrency - this.activeCount;
        if (available <= 0) {
          await this.sleep(50);
          continue;
        }

        const fetchCount = Math.min(available, this.opts.batchSize);

        // Block for max 2 seconds so shutdown doesn't wait long.
        // XREADGROUP BLOCK is in-flight when onModuleDestroy fires —
        // shorter block = faster shutdown exit.
        const blockMs = Math.min(this.opts.blockMs, 2000);

        const messages = await this.streamService.readGroup(
          this.opts.stream,
          this.opts.group,
          this.consumerName,
          fetchCount,
          blockMs,
        );

        if (messages.length === 0) {
          this.pollFailures = 0;
          continue;
        }
        this.pollFailures = 0;

        if (this.opts.concurrency === 1) {
          for (const message of messages) {
            if (!this.running) break;
            await this.processMessage(message);
          }
        } else {
          const tasks = messages.map((msg) => this.processWithTracking(msg));
          await Promise.all(tasks);
        }
      } catch (error) {
        if (this.running) {
          this.pollFailures = (this.pollFailures || 0) + 1;
          const backoff = Math.min(
            2000 * Math.pow(2, this.pollFailures - 1),
            30000,
          );
          this.logger.error(
            `Poll error (attempt ${this.pollFailures}, backoff ${backoff}ms): ${(error as Error).message}`,
          );
          await this.sleep(backoff);
        }
      }
    }
  }

  private async processWithTracking(message: StreamMessage) {
    await this.processMessage(message);
  }

  private async processMessage(message: StreamMessage) {
    if (this.activeMessageIds.has(message.id)) {
      this.logger.warn(`Skipping duplicate active message: ${message.id}`);
      return;
    }

    const lockTtlMs = Math.max(this.opts.claimMinIdleMs * 2, 30000);
    const lockOwner = `${this.consumerName}:${randomUUID()}`;
    const lockAcquired = await this.streamService.tryAcquireProcessingLock(
      this.opts.stream,
      this.opts.group,
      message.id,
      lockOwner,
      lockTtlMs,
    );

    if (!lockAcquired) {
      this.logger.warn(`Skipping locked active message: ${message.id}`);
      return;
    }

    const heartbeatMs = Math.max(1000, Math.floor(lockTtlMs / 3));
    const heartbeat = setInterval(() => {
      this.streamService
        .refreshProcessingLock(
          this.opts.stream,
          this.opts.group,
          message.id,
          lockOwner,
          lockTtlMs,
        )
        .catch((error) => {
          this.logger.warn(
            `Failed to refresh processing lock for ${message.id}: ${(error as Error).message}`,
          );
        });
    }, heartbeatMs);

    this.activeMessageIds.add(message.id);
    this.activeCount++;
    const start = Date.now();

    try {
      await this.handleMessage(message);

      await this.streamService.ack(
        this.opts.stream,
        this.opts.group,
        message.id,
      );

      const duration = Date.now() - start;
      this.logger.debug(`Processed: ${message.id} in ${duration}ms`);
    } catch (error) {
      const duration = Date.now() - start;
      this.logger.error(
        `Failed to process ${message.id}: ${(error as Error).message} (${duration}ms)`,
      );

      this.appLogger.error(
        `Stream message failed: ${this.opts.stream}/${message.id}`,
        {
          context: `StreamConsumer:${this.opts.group}`,
          error: error as Error,
          metadata: {
            messageId: message.id,
            stream: this.opts.stream,
            duration,
          },
        },
      );
    } finally {
      clearInterval(heartbeat);
      this.activeCount--;
      this.activeMessageIds.delete(message.id);
      await this.streamService
        .releaseProcessingLock(
          this.opts.stream,
          this.opts.group,
          message.id,
          lockOwner,
        )
        .catch((error) => {
          this.logger.warn(
            `Failed to release processing lock for ${message.id}: ${(error as Error).message}`,
          );
        });
    }
  }

  // ─── Stale Message Claiming + Dead Letter ──────────────

  private async claimStaleMessages() {
    const available = this.opts.concurrency - this.activeCount;
    if (available <= 0) return;

    const pendingDetails = await this.streamService.getPendingDetails(
      this.opts.stream,
      this.opts.group,
      this.opts.claimMinIdleMs,
      Math.min(this.opts.batchSize, available),
    );

    if (pendingDetails.length === 0) return;

    const deadLetterIds: string[] = [];
    const retryIds: string[] = [];

    for (const pending of pendingDetails) {
      if (this.activeMessageIds.has(pending.id)) continue;
      if (
        await this.streamService.isProcessingLocked(
          this.opts.stream,
          this.opts.group,
          pending.id,
        )
      ) {
        continue;
      }

      if (pending.deliveryCount >= this.opts.maxRetries) {
        deadLetterIds.push(pending.id);
      } else {
        retryIds.push(pending.id);
      }
    }

    // Dead letters: read data, store in dead letter stream, call handler, ack
    for (const id of deadLetterIds) {
      try {
        const messages = await this.streamService.replay(
          this.opts.stream,
          id,
          1,
        );
        const message = messages.find((m) => m.id === id);
        if (message) {
          // Store in dead letter stream for admin visibility
          await this.streamService.storeDeadLetter(
            this.opts.stream,
            this.opts.group,
            message,
            `Exceeded ${this.opts.maxRetries} delivery attempts`,
          );

          await this.handleDeadLetter(message);
        }
        await this.streamService.ack(this.opts.stream, this.opts.group, id);
      } catch (err) {
        this.logger.error(
          `Dead letter handling failed for ${id}: ${(err as Error).message}`,
        );
      }
    }

    if (deadLetterIds.length > 0) {
      this.logger.warn(
        `Dead lettered ${deadLetterIds.length} messages in ${this.opts.stream}/${this.opts.group}`,
      );

      // Emit alert for each dead-lettered message
      for (const id of deadLetterIds) {
        this.appLogger.error(`Stream dead letter: ${this.opts.stream}/${id}`, {
          context: `StreamConsumer:${this.opts.group}`,
          metadata: {
            stream: this.opts.stream,
            group: this.opts.group,
            messageId: id,
            maxRetries: this.opts.maxRetries,
          },
        });
      }
    }

    // Retryable: claim and reprocess
    if (retryIds.length > 0) {
      try {
        const availableRetries = this.opts.concurrency - this.activeCount;
        if (availableRetries <= 0) return;

        const claimed = await this.streamService.claimStaleByIds(
          this.opts.stream,
          this.opts.group,
          this.consumerName,
          this.opts.claimMinIdleMs,
          retryIds.slice(0, availableRetries),
        );

        for (const message of claimed) {
          await this.processMessage(message);
        }

        if (claimed.length > 0) {
          this.logger.log(
            `Claimed and retried ${claimed.length} stale messages`,
          );
        }
      } catch (err) {
        this.logger.error(`Claim stale error: ${(err as Error).message}`);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
