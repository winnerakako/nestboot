import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '../config/index.js';
import { OpsDb } from '../db/ops-db.service.js';
import { OpsLogStream } from './ops-log-stream.js';

export const OPS_LOG_STREAM = Symbol('OPS_LOG_STREAM');

/**
 * Its own module so that `LoggerModule.forRootAsync` can inject the stream:
 * a factory cannot depend on a provider declared in the same module it
 * configures.
 */
@Global()
@Module({
  providers: [
    {
      provide: OPS_LOG_STREAM,
      inject: [ConfigService, OpsDb],
      useFactory: (config: ConfigService, db: OpsDb): OpsLogStream | null =>
        config.get('OPS_LOGS_ENABLED') ? new OpsLogStream(db) : null,
    },
  ],
  exports: [OPS_LOG_STREAM],
})
export class OpsLogStreamModule implements OnApplicationShutdown {
  // @Inject is required, not stylistic: the type is `OpsLogStream | null`, and a
  // union erases to `Object` in the emitted metadata, which Nest cannot resolve.
  constructor(@Inject(OPS_LOG_STREAM) private readonly stream: OpsLogStream | null) {}

  async onApplicationShutdown(): Promise<void> {
    // The last buffered lines are usually the shutdown itself — which is
    // exactly what an operator looks for when a pod disappeared.
    await this.stream?.stop();
  }
}
