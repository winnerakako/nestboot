import { Global, Module } from '@nestjs/common';
import { ConfigService, loadEnv } from './config.service.js';
import type { Env } from './env.schema.js';

export const ENV = Symbol('ENV');

@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: (): Env => loadEnv() },
    { provide: ConfigService, useFactory: (env: Env) => new ConfigService(env), inject: [ENV] },
  ],
  exports: [ConfigService, ENV],
})
export class ConfigModule {}
