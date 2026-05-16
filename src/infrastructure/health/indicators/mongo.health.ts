import { Injectable } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { LogConnectionService } from '../../logging/services/log-connection.service';

@Injectable()
export class MongoHealthIndicator extends HealthIndicator {
  constructor(private readonly logConn: LogConnectionService) {
    super();
  }

  async isHealthy(key = 'mongodb'): Promise<HealthIndicatorResult> {
    if (!this.logConn.isConfigured) {
      return this.getStatus(key, true, { configured: false });
    }

    if (!this.logConn.isConnected) {
      throw new HealthCheckError(
        'MongoDB health check failed',
        this.getStatus(key, false, { connected: false }),
      );
    }

    try {
      // Ping via a lightweight query
      await this.logConn.cronConfig.findOne({}).lean().exec();
      return this.getStatus(key, true);
    } catch (error) {
      throw new HealthCheckError(
        'MongoDB health check failed',
        this.getStatus(key, false, { error: (error as Error).message }),
      );
    }
  }
}
