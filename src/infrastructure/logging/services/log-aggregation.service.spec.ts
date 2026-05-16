import type { ConfigService } from '@nestjs/config';
import type { LogConnectionService } from './log-connection.service';
import { LogAggregationService } from './log-aggregation.service';

describe('LogAggregationService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('waits for the log connection readiness before starting aggregation', async () => {
    let resolveReady: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const conn = {
      isConnected: false,
      whenReady: jest.fn(() => ready),
    };
    const config = {
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    };
    const intervalHandle = setInterval(() => undefined, 1);
    clearInterval(intervalHandle);
    const intervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockImplementation(() => intervalHandle);
    const service = new LogAggregationService(
      conn as unknown as LogConnectionService,
      config as unknown as ConfigService,
    );

    const initPromise = service.onModuleInit();
    await Promise.resolve();

    expect(intervalSpy).not.toHaveBeenCalled();

    conn.isConnected = true;
    resolveReady!();
    await initPromise;

    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 300000);
    service.onModuleDestroy();
  });

  it('recomputes aggregate stats instead of incrementing stale totals', async () => {
    const requestStatsUpdate = jest.fn();
    const queryStatsUpdate = jest.fn();
    const lastRequestAt = new Date('2026-01-01T00:00:00.000Z');
    const lastQueryAt = new Date('2026-01-01T00:01:00.000Z');
    const conn = {
      isConnected: true,
      requestLog: {
        aggregate: jest.fn().mockResolvedValue([
          {
            _id: 'GET:/users',
            method: 'GET',
            path: '/users',
            requestCount: 2,
            errorCount: 1,
            avgDuration: 150,
            minDuration: 100,
            maxDuration: 200,
            durations: [100, 200],
            lastStatusCode: 500,
            lastRequestAt,
          },
        ]),
      },
      queryLog: {
        aggregate: jest.fn().mockResolvedValue([
          {
            _id: { modelName: 'User', operation: 'findMany' },
            queryCount: 3,
            totalDuration: 90,
            avgDuration: 30,
            minDuration: 10,
            maxDuration: 50,
            slowQueryCount: 3,
            n1Count: 1,
            lastQueryAt,
          },
        ]),
      },
      requestStats: { updateOne: requestStatsUpdate },
      queryStats: { updateOne: queryStatsUpdate },
    };
    const service = new LogAggregationService(
      conn as unknown as LogConnectionService,
      {} as unknown as ConfigService,
    );

    await service.aggregate();

    expect(requestStatsUpdate).toHaveBeenCalledWith(
      { routeKey: 'GET:/users' },
      {
        $set: expect.objectContaining({
          requestCount: 2,
          errorCount: 1,
          minDuration: 100,
          maxDuration: 200,
          avgDuration: 150,
          p95Duration: 200,
          lastRequestAt,
        }),
      },
      { upsert: true },
    );
    expect(requestStatsUpdate.mock.calls[0][1]).not.toHaveProperty('$inc');
    expect(queryStatsUpdate).toHaveBeenCalledWith(
      { modelName: 'User', operation: 'findMany' },
      {
        $set: expect.objectContaining({
          queryCount: 3,
          totalDuration: 90,
          slowQueryCount: 3,
          n1DetectionCount: 1,
          minDuration: 10,
          maxDuration: 50,
          avgDuration: 30,
          lastQueryAt,
        }),
      },
      { upsert: true },
    );
    expect(queryStatsUpdate.mock.calls[0][1]).not.toHaveProperty('$inc');
  });
});
