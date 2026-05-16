import type { CacheService } from '../cache/cache.service';
import { StreamService } from './stream.service';

describe('StreamService', () => {
  it('refuses to delete consumers that still have pending messages', async () => {
    const client = {
      xpending: jest.fn().mockResolvedValue([['1-0', 'worker-a', '1000', '1']]),
      xgroup: jest.fn(),
    };
    const cache = {
      getClient: () => client,
    };
    const service = new StreamService(cache as unknown as CacheService);

    await expect(
      service.deleteConsumer('payments', 'ledger', 'worker-a'),
    ).rejects.toThrow('Cannot delete consumer');
    expect(client.xgroup).not.toHaveBeenCalled();
  });

  it('uses Redis keys for processing locks', async () => {
    const client = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
      exists: jest.fn().mockResolvedValue(1),
    };
    const service = new StreamService({
      getClient: () => client,
    } as unknown as CacheService);

    await expect(
      service.tryAcquireProcessingLock(
        'payments',
        'ledger',
        '1-0',
        'worker-a',
        30000,
      ),
    ).resolves.toBe(true);
    await expect(
      service.refreshProcessingLock(
        'payments',
        'ledger',
        '1-0',
        'worker-a',
        30000,
      ),
    ).resolves.toBe(true);
    await expect(
      service.releaseProcessingLock('payments', 'ledger', '1-0', 'worker-a'),
    ).resolves.toBe(true);
    await expect(
      service.isProcessingLocked('payments', 'ledger', '1-0'),
    ).resolves.toBe(true);

    expect(client.set).toHaveBeenCalledWith(
      'stream:processing:payments:ledger:1-0',
      'worker-a',
      'PX',
      30000,
      'NX',
    );
    expect(client.exists).toHaveBeenCalledWith(
      'stream:processing:payments:ledger:1-0',
    );
  });

  it('rejects invalid reset IDs before clearing pending messages', async () => {
    const client = {
      xgroup: jest.fn(),
      xpending: jest.fn(),
      xack: jest.fn(),
    };
    const service = new StreamService({
      getClient: () => client,
    } as unknown as CacheService);

    await expect(
      service.resetConsumerGroup('payments', 'ledger', 'not-a-stream-id'),
    ).rejects.toThrow('fromId must be "$", "0", or a valid Redis stream ID');

    expect(client.xgroup).not.toHaveBeenCalled();
    expect(client.xpending).not.toHaveBeenCalled();
    expect(client.xack).not.toHaveBeenCalled();
  });

  it('sets the group ID before clearing pending messages during reset', async () => {
    const client = {
      xgroup: jest.fn().mockResolvedValue('OK'),
      xpending: jest
        .fn()
        .mockResolvedValueOnce([['1-0', 'worker-a', '1000', '1']])
        .mockResolvedValueOnce([]),
      xack: jest.fn().mockResolvedValue(1),
    };
    const service = new StreamService({
      getClient: () => client,
    } as unknown as CacheService);

    await service.resetConsumerGroup('payments', 'ledger', '0');

    expect(client.xgroup).toHaveBeenCalledWith(
      'SETID',
      'stream:payments',
      'ledger',
      '0',
    );
    expect(client.xack).toHaveBeenCalledWith(
      'stream:payments',
      'ledger',
      '1-0',
    );
    expect(client.xgroup.mock.invocationCallOrder[0]).toBeLessThan(
      client.xpending.mock.invocationCallOrder[0],
    );
  });
});
