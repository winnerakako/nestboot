import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Bulk operation helpers for Prisma.
 * Handles large datasets by chunking operations to avoid
 * memory issues and database timeouts.
 *
 * Usage:
 *   // Create 10,000 records in chunks of 500
 *   await this.bulk.createMany('user', records);
 *
 *   // Update many records by ID
 *   await this.bulk.updateMany('user', updates);
 *
 *   // Upsert (create or update)
 *   await this.bulk.upsertMany('user', records, ['email']);
 */
@Injectable()
export class BulkHelper {
  private readonly logger = new Logger(BulkHelper.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create many records in chunks.
   *
   * @param model - Prisma model name (e.g. 'user')
   * @param data - Array of records to create
   * @param chunkSize - Records per batch (default: 500)
   * @param skipDuplicates - Skip records that violate unique constraints (default: true)
   * @returns Total number of records created
   */
  async createMany(
    model: string,
    data: Record<string, any>[],
    options?: {
      chunkSize?: number;
      skipDuplicates?: boolean;
    },
  ): Promise<{ count: number }> {
    if (!data.length) return { count: 0 };

    const chunkSize = options?.chunkSize ?? 500;
    const skipDuplicates = options?.skipDuplicates ?? true;
    const prismaModel = this.getModel(model);
    let totalCreated = 0;

    const chunks = this.chunk(data, chunkSize);
    this.logger.log(
      `createMany ${model}: ${data.length} records in ${chunks.length} chunks`,
    );

    for (let i = 0; i < chunks.length; i++) {
      const result = await prismaModel.createMany({
        data: chunks[i],
        skipDuplicates,
      });
      totalCreated += result.count;

      if (chunks.length > 1) {
        this.logger.log(
          `createMany ${model}: chunk ${i + 1}/${chunks.length} (${result.count} created)`,
        );
      }
    }

    return { count: totalCreated };
  }

  /**
   * Update many records individually in chunks.
   * Each item must include an `id` field for the where clause.
   *
   * @param model - Prisma model name
   * @param updates - Array of { id, ...fieldsToUpdate }
   * @param chunkSize - Updates per batch (default: 100)
   * @returns Total number of records updated
   */
  async updateMany(
    model: string,
    updates: (Record<string, any> & { id: string })[],
    options?: { chunkSize?: number },
  ): Promise<{ count: number }> {
    if (!updates.length) return { count: 0 };

    const chunkSize = options?.chunkSize ?? 100;
    const prismaModel = this.getModel(model);
    let totalUpdated = 0;

    const chunks = this.chunk(updates, chunkSize);
    this.logger.log(
      `updateMany ${model}: ${updates.length} records in ${chunks.length} chunks`,
    );

    for (let i = 0; i < chunks.length; i++) {
      const operations = chunks[i].map((item) => {
        const { id, ...data } = item;
        return prismaModel.update({ where: { id }, data });
      });

      await this.prisma.$transaction(operations);
      totalUpdated += chunks[i].length;

      if (chunks.length > 1) {
        this.logger.log(
          `updateMany ${model}: chunk ${i + 1}/${chunks.length} (${chunks[i].length} updated)`,
        );
      }
    }

    return { count: totalUpdated };
  }

  /**
   * Upsert many records in chunks.
   * Creates records that don't exist, updates ones that do.
   *
   * @param model - Prisma model name
   * @param data - Array of records to upsert
   * @param uniqueFields - Fields that identify uniqueness (used in where clause)
   * @param options.chunkSize - Records per batch (default: 100)
   * @param options.compoundKeyName - Custom Prisma compound unique key name (for @@unique with name attribute)
   * @returns Counts of created and updated records
   */
  async upsertMany(
    model: string,
    data: Record<string, any>[],
    uniqueFields: string[],
    options?: { chunkSize?: number; compoundKeyName?: string },
  ): Promise<{ created: number; updated: number }> {
    if (!data.length) return { created: 0, updated: 0 };
    if (uniqueFields.length === 0) {
      throw new Error('uniqueFields must contain at least one field');
    }

    const chunkSize = options?.chunkSize ?? 100;
    this.getModel(model);
    let created = 0;
    let updated = 0;

    const chunks = this.chunk(data, chunkSize);
    this.logger.log(
      `upsertMany ${model}: ${data.length} records in ${chunks.length} chunks`,
    );

    for (let i = 0; i < chunks.length; i++) {
      const counts = await (this.prisma as any).$transaction(
        async (tx: any) => {
          const txModel = tx[model];
          if (!txModel) {
            throw new Error(`Prisma model "${model}" not found`);
          }

          let chunkCreated = 0;
          let chunkUpdated = 0;

          for (const item of chunks[i]) {
            const where = this.buildWhereClause(
              item,
              uniqueFields,
              options?.compoundKeyName,
            );

            const existing = await txModel.findFirst({
              where: this.flattenWhereClause(where),
            });

            const updateData = this.stripUniqueFields(item, uniqueFields);
            await txModel.upsert({
              where,
              create: item,
              update: updateData,
            });

            if (existing) {
              chunkUpdated++;
            } else {
              chunkCreated++;
            }
          }

          return { created: chunkCreated, updated: chunkUpdated };
        },
      );

      created += counts.created;
      updated += counts.updated;

      if (chunks.length > 1) {
        this.logger.log(`upsertMany ${model}: chunk ${i + 1}/${chunks.length}`);
      }
    }

    return { created, updated };
  }

  /**
   * Delete many records by IDs in chunks.
   *
   * @param model - Prisma model name
   * @param ids - Array of IDs to delete
   * @param chunkSize - IDs per batch (default: 500)
   * @param softDelete - Set deletedAt instead of hard delete (default: false)
   */
  async deleteMany(
    model: string,
    ids: string[],
    options?: { chunkSize?: number; softDelete?: boolean },
  ): Promise<{ count: number }> {
    if (!ids.length) return { count: 0 };

    const chunkSize = options?.chunkSize ?? 500;
    const softDelete = options?.softDelete ?? false;
    const prismaModel = this.getModel(model);
    let totalDeleted = 0;
    const deletedAt = softDelete ? new Date() : undefined;

    const chunks = this.chunk(ids, chunkSize);

    for (const idChunk of chunks) {
      if (softDelete) {
        const result = await prismaModel.updateMany({
          where: { id: { in: idChunk } },
          data: { deletedAt },
        });
        totalDeleted += result.count;
      } else {
        const result = await prismaModel.deleteMany({
          where: { id: { in: idChunk } },
        });
        totalDeleted += result.count;
      }
    }

    return { count: totalDeleted };
  }

  /**
   * Process records in batches with a custom callback.
   * Useful for migrations, data transformations, etc.
   *
   * @param model - Prisma model name
   * @param callback - Function to process each batch
   * @param options - Cursor-based pagination options
   */
  async processInBatches(
    model: string,
    callback: (records: any[]) => Promise<void>,
    options?: {
      batchSize?: number;
      where?: Record<string, any>;
      orderBy?: Record<string, 'asc' | 'desc'>;
      select?: Record<string, boolean>;
    },
  ): Promise<{ totalProcessed: number }> {
    const batchSize = options?.batchSize ?? 500;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error('batchSize must be a positive integer');
    }

    const prismaModel = this.getModel(model);
    let totalProcessed = 0;
    let cursor: string | undefined;
    const orderBy = this.buildBatchOrderBy(options?.orderBy);
    const select = options?.select
      ? { ...options.select, id: true }
      : undefined;
    const shouldStripCursorId = !!options?.select && options.select.id !== true;

    while (true) {
      const records = await prismaModel.findMany({
        where: options?.where,
        orderBy,
        take: batchSize,
        ...(cursor && {
          skip: 1,
          cursor: { id: cursor },
        }),
        ...(select && { select }),
      });

      if (records.length === 0) break;

      await callback(
        shouldStripCursorId
          ? (records as Record<string, any>[]).map((record) => {
              const recordWithoutCursor = { ...record };
              delete recordWithoutCursor.id;
              return recordWithoutCursor;
            })
          : (records as Record<string, any>[]),
      );
      totalProcessed += records.length;
      cursor = records[records.length - 1].id;

      if (!cursor) {
        throw new Error(
          `Batch cursor field "id" has a null or empty value in model "${model}". Check for corrupt data.`,
        );
      }

      this.logger.log(
        `processInBatches ${model}: processed ${totalProcessed} records`,
      );

      if (records.length < batchSize) break;
    }

    return { totalProcessed };
  }

  // ─── Private Helpers ────────────────────────────────────

  private getModel(modelName: string): any {
    const model = (this.prisma as any)[modelName];
    if (!model) {
      throw new Error(`Prisma model "${modelName}" not found`);
    }
    return model;
  }

  private chunk<T>(array: T[], size: number): T[][] {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error('chunkSize must be a positive integer');
    }

    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private buildBatchOrderBy(
    orderBy?: Record<string, 'asc' | 'desc'>,
  ): Record<string, 'asc' | 'desc'> {
    const resolved: Record<string, 'asc' | 'desc'> = orderBy
      ? { ...orderBy }
      : { id: 'asc' };

    if (!Object.prototype.hasOwnProperty.call(resolved, 'id')) {
      resolved.id = 'asc';
    }

    return resolved;
  }

  private buildWhereClause(
    item: Record<string, any>,
    uniqueFields: string[],
    compoundKeyName?: string,
  ): Record<string, any> {
    if (uniqueFields.length === 0) {
      throw new Error('uniqueFields must contain at least one field');
    }

    for (const field of uniqueFields) {
      if (item[field] === undefined) {
        throw new Error(`Missing unique field "${field}"`);
      }
    }

    if (uniqueFields.length === 1) {
      return { [uniqueFields[0]]: item[uniqueFields[0]] };
    }

    // Prisma compound unique: use provided name or default to fieldA_fieldB
    const key = compoundKeyName || uniqueFields.join('_');
    const where: Record<string, any> = {};
    for (const field of uniqueFields) {
      where[field] = item[field];
    }
    return { [key]: where };
  }

  /**
   * Flattens a compound where clause for use with findFirst.
   * Converts `{ fieldA_fieldB: { fieldA: x, fieldB: y } }` to `{ fieldA: x, fieldB: y }`.
   */
  private flattenWhereClause(where: Record<string, any>): Record<string, any> {
    const keys = Object.keys(where);
    if (keys.length === 1) {
      const value = where[keys[0]];
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        // Check if this is a compound key wrapper (object with only scalar/value-type fields).
        // Scalar values: string, number, boolean, null, bigint
        // Value-type objects: Date, Buffer (not plain objects like Prisma filters)
        const innerValues = Object.values(value as Record<string, unknown>);
        const isCompound = innerValues.every(
          (v) =>
            v === null ||
            typeof v !== 'object' ||
            v instanceof Date ||
            Buffer.isBuffer(v),
        );
        if (isCompound) {
          return value;
        }
      }
    }
    return where;
  }

  /**
   * Strips unique fields from an item to produce a safe update payload.
   * Prevents updating unique/identity fields to themselves.
   */
  private stripUniqueFields(
    item: Record<string, any>,
    uniqueFields: string[],
  ): Record<string, any> {
    const update: Record<string, any> = {};
    for (const [key, value] of Object.entries(item)) {
      if (!uniqueFields.includes(key)) {
        update[key] = value;
      }
    }
    return update;
  }
}
