import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllExceptionsFilter } from '../filters';

/**
 * Pluggable error reporting service.
 * Integrates with Sentry, Datadog, or any external error tracker.
 *
 * To use Sentry:
 *   1. npm install @sentry/node
 *   2. Set SENTRY_DSN in your .env
 *   3. This service auto-initializes and hooks into AllExceptionsFilter
 *
 * To use a different provider, extend this class and override
 * `initProvider()` and `captureException()`.
 */
@Injectable()
export class ErrorReporterService implements OnModuleInit {
  private readonly logger = new Logger(ErrorReporterService.name);
  private initialized = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const dsn = this.configService.get<string>('SENTRY_DSN');
    const env = this.configService.get<string>('app.env', 'development');

    if (dsn) {
      this.initSentry(dsn, env);
    } else {
      this.logger.log(
        'No SENTRY_DSN configured — error reporting disabled. Set SENTRY_DSN in .env to enable.',
      );
    }

    // Register with the global exception filter
    AllExceptionsFilter.setErrorReporter((error, context) => {
      this.captureException(error, context);
    });
  }

  private initSentry(dsn: string, env: string) {
    try {
      // Dynamic import so @sentry/node is optional
      const Sentry = require('@sentry/node');
      Sentry.init({
        dsn,
        environment: env,
        tracesSampleRate: env === 'production' ? 0.1 : 1.0,
      });
      this.initialized = true;
      this.logger.log(`Sentry initialized for environment: ${env}`);
    } catch {
      this.logger.warn(
        '@sentry/node not installed. Run `npm install @sentry/node` to enable Sentry.',
      );
    }
  }

  captureException(error: Error, context?: Record<string, any>) {
    if (!this.initialized) {
      return;
    }

    try {
      const Sentry = require('@sentry/node');
      Sentry.withScope((scope: any) => {
        if (context) {
          scope.setExtras(context);
          if (context.userId) scope.setUser({ id: context.userId });
          if (context.requestId) scope.setTag('requestId', context.requestId);
        }
        Sentry.captureException(error);
      });
    } catch {
      // Sentry itself failed — log and move on
      this.logger.error(`Failed to report error to Sentry: ${error.message}`);
    }
  }

  captureMessage(
    message: string,
    level: 'info' | 'warning' | 'error' = 'info',
  ) {
    if (!this.initialized) return;

    try {
      const Sentry = require('@sentry/node');
      Sentry.captureMessage(message, level);
    } catch {
      // silently ignore
    }
  }
}
