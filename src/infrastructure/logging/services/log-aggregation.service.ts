import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LogConnectionService } from './log-connection.service';

/**
 * Periodically aggregates detailed logs into summary stats.
 * - request_logs → request_stats (per route performance)
 * - query_logs → query_stats (per model query performance)
 */
@Injectable()
export class LogAggregationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LogAggregationService.name);
  private aggregationTimer: NodeJS.Timeout | null = null;
  private aggregationIntervalMs = 300000;

  constructor(
    private readonly conn: LogConnectionService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    await this.conn.whenReady();
    if (!this.conn.isConnected) return;

    this.aggregationIntervalMs = this.configService.get<number>(
      'logging.buffer.aggregationIntervalMs',
      300000,
    );

    this.aggregationTimer = setInterval(
      () => this.aggregate(),
      this.aggregationIntervalMs,
    );
    this.logger.log(
      `Log aggregation started (interval: ${this.aggregationIntervalMs / 1000}s)`,
    );
  }

  onModuleDestroy() {
    if (this.aggregationTimer) {
      clearInterval(this.aggregationTimer);
    }
  }

  async aggregate() {
    if (!this.conn.isConnected) return;

    try {
      await Promise.all([
        this.aggregateRequestStats(),
        this.aggregateQueryStats(),
      ]);
    } catch (error) {
      this.logger.error(`Aggregation failed: ${(error as Error).message}`);
    }
  }

  private async aggregateRequestStats() {
    const results = await this.conn.requestLog.aggregate([
      { $sort: { timestamp: 1 } },
      {
        $group: {
          _id: '$routeKey',
          method: { $first: '$method' },
          path: { $first: '$path' },
          requestCount: { $sum: 1 },
          errorCount: {
            $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] },
          },
          avgDuration: { $avg: '$duration' },
          minDuration: { $min: '$duration' },
          maxDuration: { $max: '$duration' },
          durations: { $push: '$duration' },
          lastStatusCode: { $last: '$statusCode' },
          lastRequestAt: { $max: '$timestamp' },
        },
      },
    ]);

    for (const result of results) {
      const sorted = (result.durations as number[]).sort((a, b) => a - b);
      const len = sorted.length;

      const p50 = sorted[Math.floor(len * 0.5)] || 0;
      const p95 = sorted[Math.floor(len * 0.95)] || 0;
      const p99 = sorted[Math.floor(len * 0.99)] || 0;

      await this.conn.requestStats.updateOne(
        { routeKey: result._id },
        {
          $set: {
            method: result.method,
            path: result.path,
            requestCount: result.requestCount,
            errorCount: result.errorCount,
            avgDuration: result.avgDuration,
            minDuration: result.minDuration,
            maxDuration: result.maxDuration,
            p50Duration: p50,
            p95Duration: p95,
            p99Duration: p99,
            lastStatusCode: result.lastStatusCode,
            lastRequestAt: result.lastRequestAt,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }

  private async aggregateQueryStats() {
    const results = await this.conn.queryLog.aggregate([
      {
        $group: {
          _id: { modelName: '$modelName', operation: '$operation' },
          queryCount: { $sum: 1 },
          totalDuration: { $sum: '$duration' },
          avgDuration: { $avg: '$duration' },
          minDuration: { $min: '$duration' },
          maxDuration: { $max: '$duration' },
          slowQueryCount: { $sum: 1 },
          n1Count: {
            $sum: { $cond: ['$isN1', 1, 0] },
          },
          lastQueryAt: { $max: '$timestamp' },
        },
      },
    ]);

    for (const result of results) {
      await this.conn.queryStats.updateOne(
        {
          modelName: result._id.modelName,
          operation: result._id.operation,
        },
        {
          $set: {
            queryCount: result.queryCount,
            totalDuration: result.totalDuration,
            slowQueryCount: result.slowQueryCount,
            n1DetectionCount: result.n1Count,
            minDuration: result.minDuration,
            maxDuration: result.maxDuration,
            avgDuration: result.avgDuration,
            lastQueryAt: result.lastQueryAt,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }
}
