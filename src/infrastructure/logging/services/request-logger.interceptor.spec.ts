import type { ConfigService } from '@nestjs/config';
import type { LogBufferService } from './log-buffer.service';
import { RequestLoggerInterceptor } from './request-logger.interceptor';

type RequestLoggerSummarizerAccess = {
  summarizeBody(body: unknown): string | undefined;
};

describe('RequestLoggerInterceptor', () => {
  const interceptor = new RequestLoggerInterceptor(
    {} as unknown as LogBufferService,
    {} as unknown as ConfigService,
  ) as unknown as RequestLoggerSummarizerAccess;

  it('redacts sensitive fields before summarizing object response bodies', () => {
    const summary = interceptor.summarizeBody({
      token: 'secret-token',
      nested: { password: 'secret-password' },
      ok: true,
    });

    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('secret-token');
    expect(summary).not.toContain('secret-password');
  });

  it('redacts sensitive fields in JSON string response bodies', () => {
    const summary = interceptor.summarizeBody(
      JSON.stringify({ apiKey: 'secret-key', ok: true }),
    );

    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('secret-key');
  });
});
