import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from './prisma.service';

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Clean wrapper for Prisma transactions.
 * Handles logging, error handling, and timeout configuration.
 *
 * Usage:
 *   const result = await this.txHelper.run(async (tx) => {
 *     const user = await tx.user.create({ data: { ... } });
 *     const wallet = await tx.wallet.create({ data: { userId: user.id, ... } });
 *     return { user, wallet };
 *   });
 */
@Injectable()
export class TransactionHelper {
  private readonly logger = new Logger(TransactionHelper.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Execute operations within a database transaction.
   * All operations succeed or all roll back.
   *
   * @param fn - Function receiving the transaction client
   * @param options - Optional timeout and isolation level
   */
  async run<T>(
    fn: (tx: TransactionClient) => Promise<T>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?:
        | 'ReadUncommitted'
        | 'ReadCommitted'
        | 'RepeatableRead'
        | 'Serializable';
    },
  ): Promise<T> {
    const timeout = options?.timeout ?? 10000;
    const maxWait = options?.maxWait ?? 5000;

    try {
      const result = await this.prisma.$transaction(
        async (tx) => fn(tx as unknown as TransactionClient),
        { maxWait, timeout, isolationLevel: options?.isolationLevel as any },
      );
      return result;
    } catch (error) {
      this.logger.error(
        `Transaction failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    }
  }

  /**
   * Execute multiple independent operations in a batch transaction.
   * All succeed or all fail, but they don't share a transactional context.
   *
   * Usage:
   *   const [users, posts] = await this.txHelper.batch(
   *     prisma.user.findMany(),
   *     prisma.post.count(),
   *   );
   */
  async batch<T extends any[]>(
    ...operations: [...{ [K in keyof T]: Promise<T[K]> }]
  ): Promise<T> {
    try {
      const results = await this.prisma.$transaction(operations as any);
      return results as T;
    } catch (error) {
      this.logger.error(
        `Batch transaction failed: ${(error as Error).message}`,
      );
      throw error;
    }
  }
}
