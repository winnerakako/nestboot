import { registerAs } from '@nestjs/config';

export default registerAs('database', () => ({
  url:
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/nestboot?schema=public',
  pool: {
    max: parseInt(process.env.DATABASE_POOL_MAX || '10', 10),
    idleTimeoutMs: parseInt(
      process.env.DATABASE_POOL_IDLE_TIMEOUT || '30000',
      10,
    ),
  },
}));
