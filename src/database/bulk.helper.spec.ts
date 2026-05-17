import type { PrismaService } from './prisma.service';
import { BulkHelper } from './bulk.helper';

describe('BulkHelper', () => {
  it('keeps an internal cursor id when processing selected fields in batches', async () => {
    const prisma = {
      user: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            { id: 'user-1', email: 'a@example.com' },
            { id: 'user-2', email: 'b@example.com' },
          ])
          .mockResolvedValueOnce([]),
      },
    };
    const helper = new BulkHelper(prisma as unknown as PrismaService);
    const processed: Array<{ email: string }> = [];

    const result = await helper.processInBatches(
      'user',
      async (records) => {
        for (const record of records as Array<{ email: string }>) {
          processed.push(record);
        }
      },
      {
        batchSize: 2,
        select: { email: true },
      },
    );

    expect(result.totalProcessed).toBe(2);
    expect(prisma.user.findMany).toHaveBeenNthCalledWith(1, {
      take: 2,
      orderBy: { id: 'asc' },
      select: { email: true, id: true },
    });
    expect(prisma.user.findMany).toHaveBeenNthCalledWith(2, {
      take: 2,
      orderBy: { id: 'asc' },
      select: { email: true, id: true },
      cursor: { id: 'user-2' },
      skip: 1,
    });
    expect(processed).toEqual([
      { email: 'a@example.com' },
      { email: 'b@example.com' },
    ]);
  });

  it('rejects invalid batch sizes before querying', async () => {
    const prisma = {
      user: {
        findMany: jest.fn(),
      },
    };
    const helper = new BulkHelper(prisma as unknown as PrismaService);

    await expect(
      helper.processInBatches('user', jest.fn(), { batchSize: 0 }),
    ).rejects.toThrow('batchSize must be a positive integer');

    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('adds id as a deterministic cursor tiebreaker for custom batch ordering', async () => {
    const prisma = {
      user: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'user-2', createdAt: new Date() }])
          .mockResolvedValueOnce([]),
      },
    };
    const helper = new BulkHelper(prisma as unknown as PrismaService);

    await helper.processInBatches('user', jest.fn(), {
      batchSize: 1,
      orderBy: { createdAt: 'desc' },
    });

    expect(prisma.user.findMany).toHaveBeenNthCalledWith(1, {
      take: 1,
      orderBy: { createdAt: 'desc', id: 'asc' },
    });
    expect(prisma.user.findMany).toHaveBeenNthCalledWith(2, {
      take: 1,
      orderBy: { createdAt: 'desc', id: 'asc' },
      cursor: { id: 'user-2' },
      skip: 1,
    });
  });

  it('rejects invalid chunk sizes', async () => {
    const prisma = {
      user: {
        createMany: jest.fn(),
      },
    };
    const helper = new BulkHelper(prisma as unknown as PrismaService);

    await expect(
      helper.createMany('user', [{ email: 'a@example.com' }], {
        chunkSize: 0,
      }),
    ).rejects.toThrow('chunkSize must be a positive integer');

    expect(prisma.user.createMany).not.toHaveBeenCalled();
  });

  it('counts upsert creates and updates without relying on timestamps', async () => {
    const txModel = {
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'existing-user' }),
      upsert: jest.fn().mockResolvedValue({}),
    };
    const prisma = {
      user: {},
      $transaction: jest.fn(
        (
          callback: (tx: { user: typeof txModel }) => Promise<unknown>,
        ): Promise<unknown> => callback({ user: txModel }),
      ),
    };
    const helper = new BulkHelper(prisma as unknown as PrismaService);

    await expect(
      helper.upsertMany(
        'user',
        [{ email: 'new@example.com' }, { email: 'old@example.com' }],
        ['email'],
      ),
    ).resolves.toEqual({ created: 1, updated: 1 });

    expect(txModel.findFirst).toHaveBeenNthCalledWith(1, {
      where: { email: 'new@example.com' },
    });
    expect(txModel.findFirst).toHaveBeenNthCalledWith(2, {
      where: { email: 'old@example.com' },
    });
    expect(txModel.upsert).toHaveBeenCalledTimes(2);
  });

  it('rejects upsertMany calls without unique fields', async () => {
    const prisma = {
      user: {},
    };
    const helper = new BulkHelper(prisma as unknown as PrismaService);

    await expect(
      helper.upsertMany('user', [{ email: 'a@example.com' }], []),
    ).rejects.toThrow('uniqueFields must contain at least one field');
  });
});
