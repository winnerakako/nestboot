import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import pino, { type DestinationStream } from 'pino';
import { ConfigService } from '../config/index.js';
import { LOG_STORE } from '../stores/stores.js';
import { Correlation } from './correlation.js';
import { PostgresLogStore } from './log-store.postgres.js';
import type { OpsLogStream } from './ops-log-stream.js';
import { OPS_LOG_STREAM, OpsLogStreamModule } from './ops-log-stream.module.js';

/**
 * Secrets that must never reach a log line, the logs table, or /ops.
 *
 * Redaction is configured centrally rather than trusted to call sites: the one
 * log statement that forgets is the one that runs during the incident, and a
 * token in the logs table is a token in every backup of it.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'passwordConfirmation',
  'token',
  '*.token',
  'accessToken',
  'refreshToken',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'cardNumber',
  '*.cardNumber',
  'cvv',
  'ssn',
];

function buildStream(config: ConfigService, opsStream: OpsLogStream | null): DestinationStream {
  const level = config.get('LOG_LEVEL');
  const streams: pino.StreamEntry[] = [];

  if (config.get('LOG_PRETTY')) {
    streams.push({
      level,
      stream: pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      }) as DestinationStream,
    });
  } else {
    streams.push({ level, stream: pino.destination(1) });
  }

  // Intentional: stdout always gets every line, even when ops.logs is on. The
  // console cannot report on the database it reads from being down — an outside
  // observer reading container logs is the thing that still works then.
  if (opsStream) streams.push({ level, stream: opsStream });

  return pino.multistream(streams, { dedupe: false });
}

@Global()
@Module({
  imports: [
    OpsLogStreamModule,
    LoggerModule.forRootAsync({
      imports: [OpsLogStreamModule],
      inject: [ConfigService, OPS_LOG_STREAM],
      useFactory: (config: ConfigService, opsStream: OpsLogStream | null) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          redact: { paths: REDACT_PATHS, censor: '[redacted]' },
          // Every line picks up the correlation chain automatically, so no call
          // site has to remember to attach a request id — and none can forget.
          mixin: () => Correlation.get(),
          // Request logging is ours: it samples, resolves the route pattern and
          // writes ops.requests. pino-http's version would duplicate it.
          autoLogging: false,
          base: { pid: process.pid },
          stream: buildStream(config, opsStream),
        },
      }),
    }),
  ],
  providers: [PostgresLogStore, { provide: LOG_STORE, useExisting: PostgresLogStore }],
  exports: [LoggerModule, OpsLogStreamModule, LOG_STORE],
})
export class LoggingModule {}
