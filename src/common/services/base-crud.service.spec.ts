import { PaginationDto } from '../dto';
import type { PrismaService } from '../../database/prisma.service';
import { BaseCrudService } from './base-crud.service';

class TestCrudService extends BaseCrudService<string> {}

describe('BaseCrudService', () => {
  it('rejects unapproved sort fields', async () => {
    const prisma = {
      post: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };
    const service = new TestCrudService(
      prisma as unknown as PrismaService,
      'post',
    );
    const pagination = new PaginationDto();
    pagination.sortBy = 'title';

    await expect(service.findAll(pagination)).rejects.toThrow(
      'Invalid sort field',
    );
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });

  it('preserves caller OR filters when applying search filters', async () => {
    const prisma = {
      post: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new TestCrudService(
      prisma as unknown as PrismaService,
      'post',
      { searchFields: ['title'] },
    );
    const pagination = new PaginationDto();

    await service.findAll(pagination, {
      where: {
        authorId: 'author-1',
        OR: [{ published: true }],
      },
      search: 'nest',
    });

    const expectedWhere = {
      AND: [
        { authorId: 'author-1', OR: [{ published: true }] },
        {
          OR: [{ title: { contains: 'nest', mode: 'insensitive' } }],
        },
      ],
    };

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere }),
    );
    expect(prisma.post.count).toHaveBeenCalledWith({ where: expectedWhere });
  });
});
