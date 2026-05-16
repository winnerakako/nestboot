import type { ConfigService } from '@nestjs/config';
import type { LogConnectionService } from './log-connection.service';
import { LogBufferService } from './log-buffer.service';

describe('LogBufferService', () => {
  it('waits for an in-flight flush and drains logs added during it on shutdown', async () => {
    let resolveFirstInsert: (() => void) | undefined;
    const insertMany = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstInsert = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const conn = {
      isConnected: true,
      appLog: { insertMany },
    } as unknown as LogConnectionService;
    const config = {
      get: jest.fn().mockReturnValue(3600000),
    } as unknown as ConfigService;
    const service = new LogBufferService(conn, config);

    service.add('AppLog', { message: 'first' }, true);
    service.add('AppLog', { message: 'second' });

    const destroyPromise = service.onModuleDestroy();
    await new Promise((resolve) => setImmediate(resolve));

    expect(insertMany).toHaveBeenCalledTimes(1);
    resolveFirstInsert?.();
    await destroyPromise;

    expect(insertMany).toHaveBeenCalledTimes(2);
    expect(insertMany).toHaveBeenNthCalledWith(2, [{ message: 'second' }], {
      ordered: false,
    });
  });
});
