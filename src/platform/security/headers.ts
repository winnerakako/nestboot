import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import type { ConfigService } from '../config/index.js';
import type { SecurityEvents } from './events/security-events.js';

/**
 * The response-level defaults, applied to every surface.
 *
 * These are the settings whose insecure value is the one people forget, so they
 * are applied centrally and asserted in `security.spec.ts`. A default that is
 * only correct when someone remembers it is not a default.
 */
export async function registerSecurityHeaders(
  fastify: FastifyInstance,
  config: ConfigService,
): Promise<void> {
  await fastify.register(helmet, {
    // The API renders nothing, so a CSP on it protects nobody and breaks
    // nothing; /ops sets its own strict policy, which is where it matters.
    contentSecurityPolicy: false,
    // Sent only over HTTPS, and only in production: setting it on a localhost
    // response teaches the browser to refuse http://localhost afterwards.
    hsts: config.isProduction
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
    // Legacy header whose "blocking" mode introduced vulnerabilities of its own;
    // modern browsers ignore it and CSP replaced it.
    xXssProtection: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    frameguard: { action: 'deny' },
    noSniff: true,
  });
}

/**
 * CORS that denies by default.
 *
 * An empty `CORS_ORIGINS` rejects every cross-origin request rather than
 * allowing every one, because the insecure default is the one that ships. `*`
 * is refused outright rather than honoured: it cannot be combined with
 * credentials, and an app that asks for it has almost always misdiagnosed a
 * cookie problem.
 */
export function registerCors(
  fastify: FastifyInstance,
  config: ConfigService,
  events: SecurityEvents,
): void {
  const allowed = new Set(config.get('CORS_ORIGINS'));

  if (allowed.has('*')) {
    throw new Error(
      'CORS_ORIGINS contains "*".\n' +
        'FIX: list the origins explicitly. A wildcard cannot be used with credentialed ' +
        'requests, so browsers reject it anyway — and where it does work it permits every ' +
        'site on the internet to call this API as the logged-in user.',
    );
  }

  fastify.addHook('onRequest', (request, reply, done) => {
    const origin = request.headers.origin;
    if (!origin) return done(); // same-origin or a non-browser client

    if (!allowed.has(origin)) {
      events.record({
        kind: 'cors_rejected',
        outcome: 'blocked',
        request,
        detail: { origin },
      });
      // Intentional: no CORS headers, rather than an error status. The browser
      // enforces the block; returning 403 here would also break same-origin
      // tooling and tells a prober more than silence does.
      return done();
    }

    void reply.header('access-control-allow-origin', origin);
    void reply.header('access-control-allow-credentials', 'true');
    void reply.header('vary', 'origin');

    if (request.method === 'OPTIONS') {
      void reply
        .header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
        .header(
          'access-control-allow-headers',
          'content-type,authorization,x-request-id,idempotency-key',
        )
        .header('access-control-max-age', '600')
        .status(204)
        .send();
      return;
    }
    done();
  });
}
