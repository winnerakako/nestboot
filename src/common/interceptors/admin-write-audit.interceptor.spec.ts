import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { AppLoggerService } from '../../infrastructure/logging/services';
import { AdminWriteAuditInterceptor } from './admin-write-audit.interceptor';

describe('AdminWriteAuditInterceptor', () => {
  function createContext(request: unknown): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  function createLogger() {
    return {
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as AppLoggerService & {
      warn: jest.Mock;
      error: jest.Mock;
    };
  }

  it('logs successful admin write actions with redacted payload summary', async () => {
    const logger = createLogger();
    const interceptor = new AdminWriteAuditInterceptor(logger);
    const request = {
      method: 'PATCH',
      path: '/admin/logs/crons/email-digest',
      originalUrl: '/api/admin/logs/crons/email-digest',
      ip: '127.0.0.1',
      headers: {},
      params: { name: 'email-digest' },
      query: {},
      body: { isEnabled: false, token: 'secret-token' },
      user: { sub: 'admin-1', role: 'ops_admin' },
      requestId: 'req-1',
      route: { path: '/admin/logs/crons/:name' },
    };

    await lastValueFrom(
      interceptor.intercept(createContext(request), {
        handle: () => of({ ok: true }),
      } as CallHandler),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      'Admin monitoring write action completed',
      expect.objectContaining({
        userId: 'admin-1',
        requestId: 'req-1',
        metadata: expect.objectContaining({
          ip: '127.0.0.1',
          method: 'PATCH',
          route: '/admin/logs/crons/:name',
          status: 'success',
          payloadSummary: expect.stringContaining('[REDACTED]'),
        }),
      }),
    );
    expect(logger.warn.mock.calls[0][1].metadata.payloadSummary).not.toContain(
      'secret-token',
    );
  });

  it('logs failed admin write actions before rethrowing', async () => {
    const logger = createLogger();
    const interceptor = new AdminWriteAuditInterceptor(logger);
    const error = Object.assign(new Error('denied'), { status: 403 });
    const request = {
      method: 'DELETE',
      path: '/admin/streams/events',
      url: '/admin/streams/events',
      headers: { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' },
      ip: '127.0.0.1',
      params: { stream: 'events' },
      query: {},
      body: undefined,
      user: { sub: 'admin-2', role: 'super_admin' },
    };

    await expect(
      lastValueFrom(
        interceptor.intercept(createContext(request), {
          handle: () => throwError(() => error),
        } as CallHandler),
      ),
    ).rejects.toThrow('denied');

    expect(logger.error).toHaveBeenCalledWith(
      'Admin monitoring write action failed',
      expect.objectContaining({
        userId: 'admin-2',
        metadata: expect.objectContaining({
          ip: '127.0.0.1',
          method: 'DELETE',
          route: '/admin/streams/events',
          status: 'failed',
          errorStatus: 403,
          errorMessage: 'denied',
        }),
        error,
      }),
    );
  });
});
