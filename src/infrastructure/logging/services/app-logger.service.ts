import { Injectable, Logger } from '@nestjs/common';
import { LogBufferService } from './log-buffer.service';
import { LogContext } from './log-context.service';
import { redact } from './log-redaction.service';

export interface AppLogOptions {
  context: string;
  metadata?: Record<string, any>;
  userId?: string;
  requestId?: string;
  error?: Error;
}

/**
 * Injectable structured logger for any service.
 * Persists logs to MongoDB and writes to stdout.
 *
 * Usage:
 *   @Injectable()
 *   export class PaymentService {
 *     constructor(private readonly appLogger: AppLoggerService) {}
 *
 *     async processPayment() {
 *       this.appLogger.info('Payment processing started', {
 *         context: 'PaymentService',
 *         metadata: { amount: 50000, provider: 'paystack' },
 *       });
 *
 *       // Track external API call duration
 *       this.appLogger.startSpan('paystack-charge');
 *       await this.callPaystack();
 *       this.appLogger.endSpan('paystack-charge');
 *     }
 *   }
 */
@Injectable()
export class AppLoggerService {
  private readonly nestLogger = new Logger('AppLog');

  constructor(private readonly buffer: LogBufferService) {}

  debug(message: string, options: AppLogOptions) {
    this.log('debug', message, options);
  }

  info(message: string, options: AppLogOptions) {
    this.log('info', message, options);
  }

  warn(message: string, options: AppLogOptions) {
    this.log('warn', message, options, true);
  }

  error(message: string, options: AppLogOptions) {
    this.log('error', message, options, true);
  }

  /**
   * Start a named span for tracking external calls.
   * Must be within a request context (after RequestLoggerInterceptor runs).
   */
  startSpan(name: string) {
    LogContext.startSpan(name);
  }

  /**
   * End a named span.
   */
  endSpan(name: string) {
    LogContext.endSpan(name);
  }

  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    options: AppLogOptions,
    immediate = false,
  ) {
    const requestId = options.requestId || LogContext.getRequestId();
    const userId = options.userId || LogContext.getUserId();

    const logEntry = {
      level,
      message,
      context: options.context,
      requestId,
      userId,
      metadata: options.metadata ? redact(options.metadata) : undefined,
      error: options.error
        ? {
            message: options.error.message,
            name: options.error.name,
            stack: options.error.stack,
          }
        : undefined,
      timestamp: new Date(),
    };

    // Always write to stdout
    const logMethod =
      level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    this.nestLogger[logMethod](
      `[${options.context}] ${message}${requestId ? ` (req:${requestId})` : ''}`,
    );

    // Persist to MongoDB
    this.buffer.add('AppLog', logEntry, immediate);
  }
}
