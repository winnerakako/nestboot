import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { ConfigService } from '../config/index.js';
import { REQUEST_STORE } from '../stores/stores.js';
import { RequestRecorder } from './request-recorder.js';
import { PostgresRequestStore } from './request-store.postgres.js';

@Global()
@Module({
  providers: [
    RequestRecorder,
    PostgresRequestStore,
    { provide: REQUEST_STORE, useExisting: PostgresRequestStore },
  ],
  exports: [RequestRecorder, REQUEST_STORE],
})
export class RequestsModule implements OnModuleInit {
  constructor(
    private readonly recorder: RequestRecorder,
    private readonly adapterHost: HttpAdapterHost,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // A worker has no HTTP server to hook. Asking for the adapter there would
    // throw, so the role decides rather than a try/catch hiding a real failure.
    if (!this.config.servesHttp) return;

    const fastify = this.adapterHost.httpAdapter.getInstance<FastifyInstance>();
    this.recorder.register(fastify);
  }
}
