import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import type { ConfigService } from '../config/index.js';
import type { SecurityEvents } from './events/security-events.js';
import { registerCors, registerSecurityHeaders } from './headers.js';

/**
 * Everything that has to be installed on the Fastify instance itself, before
 * Nest's routing sees a request.
 *
 * Kept in one function called from `main.ts` so that "what protects this app"
 * is a list you can read, rather than five registrations scattered across
 * module lifecycle hooks in an order nobody can reconstruct.
 */
export async function registerSecurity(
  fastify: FastifyInstance,
  config: ConfigService,
  events: SecurityEvents,
): Promise<void> {
  await registerSecurityHeaders(fastify, config);
  registerCors(fastify, config, events);

  await fastify.register(cookie, {
    secret: config.get('APP_SECRET'),
    parseOptions: {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
    },
  });

  // Intentional: @fastify/formbody is NOT registered here. Nest's Fastify
  // adapter already registers it, and a second registration throws
  // FST_ERR_CTP_ALREADY_PRESENT at boot. The console's forms post
  // application/x-www-form-urlencoded and are parsed by that one.

  registerRawBodyForWebhooks(fastify);
  registerOpsHeaders(fastify, config.get('OPS_PATH'));
}

/**
 * The console's stricter headers, applied on the way out.
 *
 * `onSend` rather than a Nest middleware, and deliberately so: helmet's hooks
 * are registered after Nest's middleware stack, so a middleware setting
 * `referrer-policy: no-referrer` gets overwritten by helmet's looser default
 * before the response leaves. `onSend` runs after every hook, so what it sets
 * is what ships. (This exact ordering bug was caught by the console's tests.)
 *
 * The console is the only surface that renders HTML, so it is the only one that
 * needs a content policy — and `default-src 'self'` is affordable here
 * precisely because htmx and the stylesheet are served by the app, not a CDN.
 */
function registerOpsHeaders(fastify: FastifyInstance, opsPath: string): void {
  const prefix = opsPath.startsWith('/') ? opsPath : `/${opsPath}`;

  fastify.addHook('onSend', (request, reply, payload, done) => {
    if (!request.url.startsWith(prefix)) return done(null, payload);

    void reply.header(
      'content-security-policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        // A handful of one-off layout nudges in the templates are inline
        // styles; no inline SCRIPT is allowed, which is the half that matters.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join('; '),
    );
    void reply.header('x-frame-options', 'DENY');
    void reply.header('x-content-type-options', 'nosniff');
    // Operator URLs carry workflow and request ids; they must not leak outward.
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('x-robots-tag', 'noindex, nofollow');
    done(null, payload);
  });
}

/**
 * Keep the exact bytes of an inbound webhook body.
 *
 * Every provider signs the raw payload. Fastify's JSON parser produces an
 * object, and `JSON.stringify` of that object is *not* byte-identical to what
 * was sent — key order, whitespace and number formatting all differ. Verifying
 * against the re-serialised form fails for reasons that look like a
 * misconfigured secret, so the raw buffer is captured before parsing.
 */
function registerRawBodyForWebhooks(fastify: FastifyInstance): void {
  // Replace Fastify's built-in JSON parser rather than adding a second one,
  // which would throw FST_ERR_CTP_ALREADY_PRESENT.
  fastify.removeContentTypeParser('application/json');

  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      if (request.url.startsWith('/webhooks/')) {
        (request.raw as unknown as { rawBody?: Buffer }).rawBody = body;
      }

      if (body.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (error) {
        // Surfaces as a 400 problem document via the global filter.
        done(error as Error, undefined);
      }
    },
  );
}
