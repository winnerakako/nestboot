import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Global exception filter that catches all errors and returns
 * a consistent JSON shape. Includes the request ID for tracing.
 *
 * Calls the optional error reporter (Sentry, Datadog, etc.)
 * for unhandled (non-HTTP) exceptions.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);
  private static errorReporter:
    | ((error: Error, context?: Record<string, any>) => void)
    | null = null;

  /**
   * Register an external error reporter (e.g. Sentry).
   * Called once at app startup.
   */
  static setErrorReporter(
    reporter: (error: Error, context?: Record<string, any>) => void,
  ) {
    AllExceptionsFilter.errorReporter = reporter;
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request as any).requestId || undefined;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: any = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const res = exceptionResponse as any;
        message = res.message || exception.message;
        errors = res.errors;

        if (Array.isArray(res.message)) {
          message = 'Validation failed';
          errors = res.message;
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled exception: ${exception.message}`,
        exception.stack,
      );

      // Report to external error tracking
      if (AllExceptionsFilter.errorReporter) {
        AllExceptionsFilter.errorReporter(exception, {
          requestId,
          url: request.url,
          method: request.method,
          userId: (request as any).user?.sub,
        });
      }
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      message,
      errors,
      requestId,
      timestamp: new Date().toISOString(),
    });
  }
}
