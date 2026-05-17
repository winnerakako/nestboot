import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import {
  appConfig,
  databaseConfig,
  authConfig,
  redisConfig,
  emailConfig,
  uploadConfig,
  loggingConfig,
} from './config';
import { envValidationSchema } from './config/env.validation';

import { DatabaseModule } from './database';
import { AllExceptionsFilter } from './common/filters';
import {
  ResponseInterceptor,
  AuditContextInterceptor,
} from './common/interceptors';
import { RequestIdMiddleware } from './common/middlewares';
import { DistributedThrottleGuard, JwtAuthGuard } from './common/guards';
import {
  GracefulShutdownService,
  ErrorReporterService,
} from './common/services';

import { HealthModule } from './infrastructure/health/health.module';
import { AuthModule } from './infrastructure/auth';
import { EmailModule } from './infrastructure/email/email.module';
import { UploadModule } from './infrastructure/upload/upload.module';
import { CacheModule } from './infrastructure/cache/cache.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { WebsocketModule } from './infrastructure/websocket/websocket.module';
import { WebhookModule } from './infrastructure/webhook/webhook.module';
import { LoggingModule } from './infrastructure/logging/logging.module';
import { CronModule } from './infrastructure/cron/cron.module';
import { EventsModule } from './infrastructure/events/events.module';
import { StreamModule } from './infrastructure/stream/stream.module';
import { MetricsModule } from './infrastructure/metrics';
import { RequestLoggerInterceptor } from './infrastructure/logging/services';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        databaseConfig,
        authConfig,
        redisConfig,
        emailConfig,
        uploadConfig,
        loggingConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),

    // Scheduling
    ScheduleModule.forRoot(),

    // Events (typed, wildcard, error-handled)
    EventsModule,

    // Database
    DatabaseModule,

    // Infrastructure Modules
    AuthModule,
    HealthModule,
    EmailModule,
    UploadModule,
    CacheModule,
    QueueModule,
    WebsocketModule,
    WebhookModule,
    LoggingModule,
    CronModule,
    StreamModule,
    MetricsModule,
  ],
  providers: [
    // Global services
    GracefulShutdownService,
    ErrorReporterService,

    // Global Exception Filter
    { provide: APP_FILTER, useClass: AllExceptionsFilter },

    // Global JWT Authentication (use @Public() to opt out)
    { provide: APP_GUARD, useClass: JwtAuthGuard },

    // Global Rate Limiter (Redis-backed, distributed)
    { provide: APP_GUARD, useClass: DistributedThrottleGuard },

    // Global Interceptors
    { provide: APP_INTERCEPTOR, useClass: AuditContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggerInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
