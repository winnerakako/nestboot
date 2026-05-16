import type { ConfigService } from '@nestjs/config';
import type { CacheService } from '../cache/cache.service';
import type { AppLoggerService } from '../logging/services/app-logger.service';
import type { QueueService } from '../queue/queue.service';
import type { SmtpProvider } from './providers/smtp.provider';
import { EmailService } from './email.service';

describe('EmailService', () => {
  function createService(cacheGet: jest.Mock) {
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          'email.fromName': 'Test',
          'email.from': 'test@example.com',
          'app.name': 'Test',
        };
        return values[key] ?? fallback;
      }),
    };

    return new EmailService(
      config as unknown as ConfigService,
      {} as unknown as SmtpProvider,
      {} as unknown as QueueService,
      {} as unknown as AppLoggerService,
      { get: cacheGet, set: jest.fn() } as unknown as CacheService,
    );
  }

  it('fails queued bulk email jobs when cached attachments are missing', async () => {
    const service = createService(jest.fn().mockResolvedValue(null));

    await expect(
      service.restoreQueuedAttachments(undefined, 'email:bulk-attachments:1'),
    ).rejects.toThrow('Queued email attachments expired or are unavailable');
  });
});
