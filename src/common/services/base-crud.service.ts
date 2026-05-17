import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { PaginationDto } from '../dto';
import { paginate } from '../utils/pagination.util';
import { PaginatedResponse } from '../interfaces';

/**
 * Base CRUD service that provides standard operations for any Prisma model.
 * Extend this in your domain services to get pagination, soft delete,
 * and audit trail support out of the box.
 *
 * Usage:
 *   @Injectable()
 *   export class PostService extends BaseCrudService<'post'> {
 *     constructor(prisma: PrismaService) {
 *       super(prisma, 'post', {
 *         softDelete: true,
 *         searchFields: ['title', 'body'],
 *         defaultSelect: { id: true, title: true, createdAt: true },
 *       });
 *     }
 *   }
 *
 * Then in controller:
 *   this.postService.findAll(pagination, { where: { authorId: '...' } });
 *   this.postService.findById(id);
 *   this.postService.create({ title: 'Hello' });
 *   this.postService.update(id, { title: 'Updated' });
 *   this.postService.remove(id);
 */

export interface BaseCrudOptions {
  /** Enable soft delete (requires `deletedAt` field on model) */
  softDelete?: boolean;
  /** Fields to search when `search` query param is provided */
  searchFields?: string[];
  /** Default select clause. If null, selects all fields. */
  defaultSelect?: Record<string, boolean> | null;
  /** Default include clause for relations */
  defaultInclude?: Record<string, any> | null;
  /** Fields callers are allowed to sort by */
  allowedSortFields?: string[];
  /** Default field used when callers omit sortBy */
  defaultSortField?: string | null;
}

export abstract class BaseCrudService<ModelName extends string> {
  constructor(
    protected readonly prisma: PrismaService,
    protected readonly modelName: ModelName,
    protected readonly options: BaseCrudOptions = {},
  ) {}

  private get model(): any {
    return (this.prisma as any)[this.modelName];
  }

  async findAll<T = any>(
    pagination: PaginationDto,
    extra?: {
      where?: Record<string, any>;
      search?: string;
      select?: Record<string, boolean>;
      include?: Record<string, any>;
      orderBy?: Record<string, 'asc' | 'desc'>;
    },
  ): Promise<PaginatedResponse<T>> {
    let where: Record<string, any> = { ...extra?.where };

    // Soft delete filter — always enforced, cannot be overridden by callers
    if (this.options.softDelete) {
      where.deletedAt = null;
    }

    // Search across configured fields
    if (extra?.search && this.options.searchFields?.length) {
      const searchFilter = {
        OR: this.options.searchFields.map((field) => ({
          [field]: { contains: extra.search, mode: 'insensitive' },
        })),
      };

      if (Object.prototype.hasOwnProperty.call(where, 'OR')) {
        where = { AND: [where, searchFilter] };
      } else {
        where.OR = searchFilter.OR;
      }
    }

    const select = extra?.select ?? this.options.defaultSelect ?? undefined;
    const include = !select
      ? (extra?.include ?? this.options.defaultInclude ?? undefined)
      : undefined;
    const orderBy =
      extra?.orderBy ??
      ({
        [this.validateSortField(
          pagination.sortBy || this.options.defaultSortField || 'id',
        )]: this.validateSortOrder(pagination.sortOrder || 'desc'),
      } as Record<string, 'asc' | 'desc'>);

    const [data, total] = await Promise.all([
      this.model.findMany({
        where,
        ...(select && { select }),
        ...(include && { include }),
        skip: pagination.skip,
        take: pagination.limit,
        orderBy,
      }),
      this.model.count({ where }),
    ]);

    return paginate(data as T[], total as number, pagination);
  }

  async findById(
    id: string,
    options?: {
      select?: Record<string, boolean>;
      include?: Record<string, any>;
    },
  ): Promise<any> {
    const where: Record<string, any> = { id };

    if (this.options.softDelete) {
      where.deletedAt = null;
    }

    const select = options?.select ?? this.options.defaultSelect ?? undefined;
    const include = !select
      ? (options?.include ?? this.options.defaultInclude ?? undefined)
      : undefined;

    const record = await this.model.findFirst({
      where,
      ...(select && { select }),
      ...(include && { include }),
    });

    if (!record) {
      throw new NotFoundException(`${this.modelName} not found`);
    }

    return record;
  }

  async create(
    data: Record<string, any>,
    options?: {
      select?: Record<string, boolean>;
      include?: Record<string, any>;
    },
  ): Promise<any> {
    const select = options?.select ?? this.options.defaultSelect ?? undefined;
    const include = !select
      ? (options?.include ?? this.options.defaultInclude ?? undefined)
      : undefined;

    return this.model.create({
      data,
      ...(select && { select }),
      ...(include && { include }),
    });
  }

  async update(
    id: string,
    data: Record<string, any>,
    options?: {
      select?: Record<string, boolean>;
      include?: Record<string, any>;
    },
  ): Promise<any> {
    await this.findById(id); // Ensure exists and not soft-deleted

    const select = options?.select ?? this.options.defaultSelect ?? undefined;
    const include = !select
      ? (options?.include ?? this.options.defaultInclude ?? undefined)
      : undefined;

    return this.model.update({
      where: { id },
      data,
      ...(select && { select }),
      ...(include && { include }),
    });
  }

  async remove(id: string): Promise<{ message: string }> {
    await this.findById(id);

    if (this.options.softDelete) {
      await this.model.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    } else {
      await this.model.delete({ where: { id } });
    }

    return { message: `${this.modelName} deleted successfully` };
  }

  async count(where?: Record<string, any>): Promise<number> {
    const finalWhere: Record<string, any> = { ...where };

    // Soft delete filter — always enforced, cannot be overridden by callers
    if (this.options.softDelete) {
      finalWhere.deletedAt = null;
    }

    return this.model.count({ where: finalWhere });
  }

  async exists(id: string): Promise<boolean> {
    const where: Record<string, any> = { id };
    if (this.options.softDelete) {
      where.deletedAt = null;
    }

    const count = await this.model.count({ where });
    return count > 0;
  }

  private validateSortField(field: string): string {
    const allowed = new Set([
      'id',
      ...(this.options.defaultSortField ? [this.options.defaultSortField] : []),
      ...(this.options.searchFields || []),
      ...Object.keys(this.options.defaultSelect || {}),
      ...(this.options.allowedSortFields || []),
    ]);

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field) || !allowed.has(field)) {
      throw new BadRequestException(`Invalid sort field: ${field}`);
    }

    return field;
  }

  private validateSortOrder(order: string): 'asc' | 'desc' {
    if (order !== 'asc' && order !== 'desc') {
      throw new BadRequestException(`Invalid sort order: ${order}`);
    }

    return order;
  }
}
