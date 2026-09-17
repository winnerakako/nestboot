import { Module } from '@nestjs/common';
import { CacheModule } from './cache/cache.module.js';
import { ConfigModule } from './config/index.js';
import { DbModule } from './db/index.js';
import { DbosModule } from './dbos/index.js';
import { ErrorsModule } from './errors/errors.module.js';
import { EventsModule } from './events/events.module.js';
import { HealthModule } from './health/index.js';
import { HousekeepingModule } from './housekeeping/housekeeping.module.js';
import { HttpModule } from './http/index.js';
import { LoggingModule } from './logging/logging.module.js';
import { OpsModule } from './ops/ops.module.js';
import { RequestsModule } from './requests/requests.module.js';
import { SecurityModule } from './security/security.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';

/**
 * Everything the framework provides, in one import.
 *
 * An app's `AppModule` imports this and its own features, and nothing else has
 * to be wired by hand. Order matters only in that config must resolve first —
 * every other module reads it.
 */
@Module({
  imports: [
    ConfigModule,
    DbModule,
    LoggingModule,
    ErrorsModule,
    DbosModule,
    CacheModule,
    EventsModule,
    HousekeepingModule,
    HttpModule,
    RequestsModule,
    SecurityModule,
    WebhooksModule,
    HealthModule,
    OpsModule.forRoot(),
  ],
  exports: [
    ConfigModule,
    DbModule,
    LoggingModule,
    ErrorsModule,
    DbosModule,
    CacheModule,
    EventsModule,
    RequestsModule,
    SecurityModule,
    HealthModule,
  ],
})
export class PlatformModule {}
