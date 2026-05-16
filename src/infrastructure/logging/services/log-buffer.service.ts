import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { LogConnectionService } from './log-connection.service';

interface BufferEntry {
  model: string;
  data: any;
  immediate: boolean;
}

const MAX_BUFFER_SIZE = 10000;

@Injectable()
export class LogBufferService implements OnModuleDestroy {
  private readonly logger = new Logger(LogBufferService.name);
  private buffer: BufferEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private activeFlush: Promise<void> | null = null;

  constructor(
    private readonly conn: LogConnectionService,
    private readonly configService: ConfigService,
  ) {
    const intervalMs = this.configService.get<number>(
      'logging.buffer.flushIntervalMs',
      5000,
    );

    this.flushTimer = setInterval(() => {
      void this.flush().catch((error) => {
        this.logger.error(`Log flush failed: ${(error as Error).message}`);
      });
    }, intervalMs);
  }

  /**
   * Add a log entry to the buffer.
   * If immediate=true (errors/warnings), triggers an instant flush.
   * Buffer is capped at MAX_BUFFER_SIZE to prevent unbounded growth.
   */
  add(modelName: string, data: any, immediate = false) {
    if (!this.conn.isConnected) {
      this.logger.verbose(JSON.stringify({ _collection: modelName, ...data }));
      return;
    }

    // Prevent unbounded growth — drop oldest non-immediate entries
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      const firstNonImmediate = this.buffer.findIndex((e) => !e.immediate);
      if (firstNonImmediate >= 0) {
        this.buffer.splice(firstNonImmediate, 1);
      } else {
        this.buffer.shift();
      }
    }

    this.buffer.push({ model: modelName, data, immediate });

    if (immediate) {
      void this.flush().catch((error) => {
        this.logger.error(
          `Immediate log flush failed: ${(error as Error).message}`,
        );
      });
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      await this.activeFlush;
      return;
    }

    if (this.buffer.length === 0 || !this.conn.isConnected) {
      return;
    }

    this.flushing = true;
    this.activeFlush = this.flushCurrentBuffer();

    try {
      await this.activeFlush;
    } finally {
      this.flushing = false;
      this.activeFlush = null;
    }
  }

  private async flushCurrentBuffer(): Promise<void> {
    const entries = [...this.buffer];
    this.buffer = [];

    try {
      const grouped = new Map<string, any[]>();
      for (const entry of entries) {
        const list = grouped.get(entry.model) || [];
        list.push(entry.data);
        grouped.set(entry.model, list);
      }

      for (const [modelName, docs] of grouped) {
        try {
          const model = this.getModel(modelName);
          if (model) {
            await model.insertMany(docs, { ordered: false });
          }
        } catch (error) {
          this.logger.error(
            `Failed to flush ${docs.length} ${modelName} logs: ${(error as Error).message}`,
          );
        }
      }
    } catch (error) {
      this.buffer.unshift(...entries);
      throw error;
    }
  }

  private getModel(name: string): Model<any> | null {
    const map: Record<string, Model<any> | undefined> = {
      RequestLog: this.conn.requestLog,
      RequestStats: this.conn.requestStats,
      QueryLog: this.conn.queryLog,
      QueryStats: this.conn.queryStats,
      AppLog: this.conn.appLog,
      CronLog: this.conn.cronLog,
      CronConfig: this.conn.cronConfig,
    };
    return map[name] || null;
  }

  async onModuleDestroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    while (this.buffer.length > 0 || this.flushing) {
      const before = this.buffer.length;
      const wasFlushing = this.flushing;
      await this.flush();
      if (!wasFlushing && !this.flushing && this.buffer.length === before)
        break;
    }

    this.logger.log('Log buffer flushed on shutdown');
  }
}
