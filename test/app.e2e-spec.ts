import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from '../src/database';
import { QueueService } from '../src/infrastructure/queue/queue.service';
import { EmailWorker } from '../src/infrastructure/email/email.worker';
import { RedisService } from '../src/infrastructure/cache/redis.service';
import { CacheService } from '../src/infrastructure/cache/cache.service';
import { HealthController } from '../src/infrastructure/health/health.controller';

describe('App health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const redisClient = {
      duplicate: jest.fn().mockReturnThis(),
      on: jest.fn(),
      quit: jest.fn(),
      ping: jest.fn().mockResolvedValue('PONG'),
      expire: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
      multi: jest.fn().mockReturnValue({
        incr: jest.fn().mockReturnThis(),
        ttl: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          [null, 1],
          [null, -1],
        ]),
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({ getClient: () => redisClient })
      .overrideProvider(CacheService)
      .useValue({ getClient: () => redisClient })
      .overrideProvider(QueueService)
      .useValue({
        registerQueue: jest.fn(),
        getLimiterConfig: jest.fn(),
        getRegisteredQueues: jest.fn().mockReturnValue([]),
      })
      .overrideProvider(EmailWorker)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots the app and exposes liveness', () => {
    expect(app.get(HealthController).live().status).toBe('ok');
  });
});
