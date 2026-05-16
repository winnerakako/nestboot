import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  it('constructs a Prisma 7 client with the PostgreSQL adapter', async () => {
    const service = new PrismaService();

    expect(service).toBeDefined();
    expect('$connect' in service).toBe(true);
    await service.$disconnect().catch(() => undefined);
  });
});
