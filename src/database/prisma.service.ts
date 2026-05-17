import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const DEFAULT_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/nestboot?schema=public';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const { connectionString, schema } = PrismaService.resolveDatabaseUrl();
    const poolMax = parseInt(process.env.DATABASE_POOL_MAX || '10', 10);

    super({
      adapter: new PrismaPg(
        { connectionString, max: poolMax },
        schema ? { schema } : undefined,
      ),
      log: [{ emit: 'event', level: 'query' }],
    });
  }

  private static resolveDatabaseUrl(): {
    connectionString: string;
    schema?: string;
  } {
    const rawUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

    try {
      const parsed = new URL(rawUrl);
      const schema = parsed.searchParams.get('schema') || undefined;
      parsed.searchParams.delete('schema');

      return {
        connectionString: parsed.toString(),
        schema,
      };
    } catch {
      return { connectionString: rawUrl };
    }
  }

  /** Models registered for automatic soft-delete filtering */
  private readonly softDeleteModels = new Set<string>();

  /** Models registered for audit trail (createdBy/updatedBy) */
  private readonly auditModels = new Set<string>();

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  // ─── Soft Delete Helpers ───────────────────────────────

  /**
   * Register models that have a `deletedAt` field.
   * Once registered, use `prisma.softFind()` / `prisma.softCount()`
   * to automatically exclude deleted records.
   *
   * Example:
   *   prismaService.registerSoftDeleteModels('User', 'Post');
   */
  registerSoftDeleteModels(...models: string[]) {
    models.forEach((m) => this.softDeleteModels.add(m));
  }

  isSoftDeleteModel(model: string): boolean {
    return this.softDeleteModels.has(model);
  }

  /**
   * Returns a where clause that excludes soft-deleted records.
   * Use in any query: `where: { ...yourFilters, ...prisma.notDeleted() }`
   */
  notDeleted() {
    return { deletedAt: null };
  }

  /**
   * Perform a soft delete — sets deletedAt instead of removing the record.
   * Works with any model that has a `deletedAt` field.
   *
   * Pass a shared `Date` when soft-deleting multiple records in the same
   * transaction to ensure consistent timestamps.
   *
   * Example:
   *   await prisma.user.update({
   *     where: { id },
   *     data: prisma.softDelete(),
   *   });
   *
   *   // In a transaction with consistent timestamp:
   *   const now = new Date();
   *   await tx.user.update({ where: { id }, data: prisma.softDelete(now) });
   *   await tx.post.updateMany({ where: { authorId: id }, data: prisma.softDelete(now) });
   */
  softDelete(timestamp?: Date) {
    return { deletedAt: timestamp ?? new Date() };
  }

  // ─── Audit Trail Helpers ───────────────────────────────

  /**
   * Register models that have `createdBy` and/or `updatedBy` fields.
   *
   * Example:
   *   prismaService.registerAuditModels('User', 'Post', 'Order');
   */
  registerAuditModels(...models: string[]) {
    models.forEach((m) => this.auditModels.add(m));
  }

  isAuditModel(model: string): boolean {
    return this.auditModels.has(model);
  }

  /**
   * Returns audit fields for create operations.
   * Spread into your `data` object.
   *
   * Example:
   *   await prisma.post.create({
   *     data: { title: 'Hello', ...prisma.auditCreate(userId) },
   *   });
   */
  auditCreate(userId: string) {
    return { createdBy: userId, updatedBy: userId };
  }

  /**
   * Returns audit fields for update operations.
   *
   * Example:
   *   await prisma.post.update({
   *     where: { id },
   *     data: { title: 'Updated', ...prisma.auditUpdate(userId) },
   *   });
   */
  auditUpdate(userId: string) {
    return { updatedBy: userId };
  }
}
