import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { ConfigError, ConfigService, loadEnv } from './platform/config/index.js';
import { registerSecurity } from './platform/security/bootstrap.js';
import { SecurityEvents } from './platform/security/events/security-events.js';

/**
 * One entry point, one image, two roles.
 *
 * `ROLE=web` serves HTTP and cannot execute a workflow; `ROLE=worker` executes
 * workflows and schedules and serves no HTTP; `ROLE=all` is both, for a laptop
 * or a small deployment. The split ships from day one even when nobody uses it,
 * because retrofitting it means auditing every workflow for request-scoped
 * state it quietly came to depend on.
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();

  const adapter = new FastifyAdapter({
    bodyLimit: env.BODY_LIMIT_BYTES,
    // Without this, anything behind a load balancer sees the balancer's IP as
    // the client — which silently turns per-IP rate limiting into a global one.
    trustProxy: env.TRUST_PROXY || false,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    // Buffered until the pino logger is installed below, so boot-time lines are
    // neither lost nor printed in a second format.
    bufferLogs: true,
    abortOnError: false,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);
  const config = app.get(ConfigService);

  // Lets SIGTERM reach onApplicationShutdown, which drains DBOS and flushes the
  // telemetry buffers. Without it a rolling deploy silently discards both.
  app.enableShutdownHooks();

  // Intentional: init() BEFORE registerSecurity(), and listen() after.
  // `init()` is where Nest installs its own body parsers, and it runs inside
  // `listen()` if it has not already. Registering ours first therefore collides
  // with Nest's (FST_ERR_CTP_ALREADY_PRESENT) at the moment the server binds —
  // i.e. only in a real boot, not in a test that init()s explicitly.
  await app.init();

  if (!config.servesHttp) {
    // A worker runs the whole container — DBOS launches from
    // onApplicationBootstrap — it just never binds a port.
    logger.log(`worker ready (version ${env.GIT_SHA})`, 'bootstrap');
    return;
  }

  // Headers, CORS, cookies and the raw-body capture that inbound webhooks need,
  // installed on Fastify before it starts accepting connections.
  await registerSecurity(app.getHttpAdapter().getInstance(), config, app.get(SecurityEvents));

  await app.listen(env.PORT, env.HOST);
  logger.log(
    `${env.ROLE} listening on http://${env.HOST}:${env.PORT} (version ${env.GIT_SHA})`,
    'bootstrap',
  );
}

bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // A config failure is an operator's problem, not a developer's: print the
    // list plainly rather than burying it in a stack trace.
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
