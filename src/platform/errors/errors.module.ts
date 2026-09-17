import { Global, Module } from '@nestjs/common';
import { ConfigService } from '../config/index.js';
import { DbModule } from '../db/db.module.js';
import { ERROR_STORE } from '../stores/stores.js';
import { ERROR_SINK, NoopErrorSink } from './error-sink.js';
import { PostgresErrorSink } from './error-sink.postgres.js';
import { PostgresErrorStore } from './error-store.postgres.js';

@Global()
@Module({
  // Imported explicitly rather than relying on DbModule being @Global: a global
  // module is only available once something has pulled it into the graph, so
  // depending on that implicitly makes this module unusable on its own.
  imports: [DbModule],
  providers: [
    PostgresErrorSink,
    {
      provide: ERROR_SINK,
      inject: [ConfigService, PostgresErrorSink],
      // OPS_LOGS_ENABLED governs error recording too: they are the same
      // telemetry database, and a product that opts out of one has opted out.
      useFactory: (config: ConfigService, sink: PostgresErrorSink) =>
        config.get('OPS_LOGS_ENABLED') ? sink : new NoopErrorSink(),
    },
    PostgresErrorStore,
    { provide: ERROR_STORE, useExisting: PostgresErrorStore },
  ],
  exports: [ERROR_SINK, ERROR_STORE, PostgresErrorSink],
})
export class ErrorsModule {}
