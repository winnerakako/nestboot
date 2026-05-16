import { Injectable } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { QueueService } from '../../queue/queue.service';

@Injectable()
export class QueueHealthIndicator extends HealthIndicator {
  constructor(private readonly queueService: QueueService) {
    super();
  }

  async isHealthy(key = 'queues'): Promise<HealthIndicatorResult> {
    const queues = this.queueService.getRegisteredQueues();

    if (queues.length === 0) {
      return this.getStatus(key, true, { registered: 0 });
    }

    try {
      const stats = await this.queueService.getAllStats();
      const summary: Record<string, any> = {};

      for (const stat of stats) {
        if (stat) {
          const { name, isPaused, ...counts } = stat;
          summary[name] = { isPaused, ...counts };
        }
      }

      return this.getStatus(key, true, summary);
    } catch (error) {
      throw new HealthCheckError(
        'Queue health check failed',
        this.getStatus(key, false, { error: (error as Error).message }),
      );
    }
  }
}
