import type { LogConnectionService } from '../../logging/services/log-connection.service';
import { MongoHealthIndicator } from './mongo.health';

describe('MongoHealthIndicator', () => {
  it('reports optional Mongo logging as healthy but unconfigured', async () => {
    const indicator = new MongoHealthIndicator({
      isConfigured: false,
      isConnected: false,
    } as unknown as LogConnectionService);

    await expect(indicator.isHealthy('mongodb')).resolves.toEqual({
      mongodb: { status: 'up', configured: false },
    });
  });

  it('fails when Mongo logging is configured but disconnected', async () => {
    const indicator = new MongoHealthIndicator({
      isConfigured: true,
      isConnected: false,
    } as unknown as LogConnectionService);

    await expect(indicator.isHealthy('mongodb')).rejects.toThrow(
      'MongoDB health check failed',
    );
  });
});
