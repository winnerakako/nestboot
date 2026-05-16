import { PaginationDto } from '../dto';
import { paginate } from './pagination.util';

describe('paginate', () => {
  it('builds pagination metadata', () => {
    const pagination = new PaginationDto();
    pagination.page = 2;
    pagination.limit = 10;

    expect(paginate(['a'], 25, pagination)).toEqual({
      data: ['a'],
      meta: {
        total: 25,
        page: 2,
        limit: 10,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      },
    });
  });
});
