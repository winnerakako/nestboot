import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../database/prisma.service';
import type { LogBufferService } from './log-buffer.service';
import { QueryLoggerService } from './query-logger.service';

type QueryLoggerParserAccess = {
  parseQuery(query: string): { model: string; operation: string };
};

describe('QueryLoggerService', () => {
  const service = new QueryLoggerService(
    {} as unknown as PrismaService,
    {} as unknown as LogBufferService,
    {
      get: jest.fn((_key: string, fallback: unknown) => fallback),
    } as unknown as ConfigService,
  ) as unknown as QueryLoggerParserAccess;

  it('parses schema-qualified tables from non-public schemas', () => {
    expect(
      service.parseQuery('SELECT * FROM "tenant_1"."users" WHERE id = $1'),
    ).toEqual({ model: 'users', operation: 'findMany' });
  });

  it('parses schema-qualified update statements', () => {
    expect(
      service.parseQuery(
        'UPDATE "tenant_1"."users" SET "email" = $1 WHERE "id" = $2',
      ),
    ).toEqual({ model: 'users', operation: 'update' });
  });
});
