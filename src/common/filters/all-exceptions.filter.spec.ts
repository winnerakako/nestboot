import { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

type FilterLoggerAccess = {
  logger: { error: (...args: unknown[]) => unknown };
};

describe('AllExceptionsFilter', () => {
  it('does not expose unhandled error messages to clients', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({
          requestId: 'req-1',
          url: '/internal',
          method: 'GET',
        }),
      }),
    } as unknown as ArgumentsHost;
    const filter = new AllExceptionsFilter();
    const loggerSpy = jest
      .spyOn((filter as unknown as FilterLoggerAccess).logger, 'error')
      .mockImplementation();

    filter.catch(new Error('database password leaked'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'Internal server error',
        requestId: 'req-1',
      }),
    );
    expect(json.mock.calls[0][0].message).not.toContain('database password');
    loggerSpy.mockRestore();
  });
});
