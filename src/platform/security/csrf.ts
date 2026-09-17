import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ConfigService } from '../config/index.js';
import { ForbiddenException } from '../http/platform.exception.js';

const COOKIE = 'ops_csrf';
export const CSRF_FIELD = '_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Signed double-submit CSRF protection for the console's forms.
 *
 * SameSite=Lax already stops the cross-site POST that matters, but it is a
 * browser policy, not a server check — and the console's forms cancel workflows
 * and change rate limits. Two independent controls is the right number for a
 * surface with those buttons on it.
 *
 * The token is HMAC'd with APP_SECRET, so a cookie an attacker can set (via a
 * subdomain, say) is not a token the server will accept.
 */
@Injectable()
export class CsrfProtection {
  constructor(private readonly config: ConfigService) {}

  /** Issue a token for a rendered page, setting the paired cookie. */
  issue(reply: FastifyReply): string {
    const nonce = randomBytes(18).toString('base64url');
    void reply.setCookie(COOKIE, nonce, {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'lax',
      path: this.config.get('OPS_PATH'),
    });
    return `${nonce}.${this.sign(nonce)}`;
  }

  /** Throws unless the submitted token matches the cookie and the signature. */
  verify(request: FastifyRequest): void {
    if (SAFE_METHODS.has(request.method)) return;

    const submitted = this.submittedToken(request);
    const cookie = request.cookies?.[COOKIE];

    if (!submitted || !cookie) {
      throw new ForbiddenException('This form has expired. Reload the page and try again.');
    }

    const [nonce, signature] = submitted.split('.');
    if (!nonce || !signature || nonce !== cookie || !this.matches(nonce, signature)) {
      throw new ForbiddenException('This form has expired. Reload the page and try again.');
    }
  }

  private submittedToken(request: FastifyRequest): string | undefined {
    const body = request.body as Record<string, unknown> | undefined;
    const fromBody = body?.[CSRF_FIELD];
    if (typeof fromBody === 'string') return fromBody;

    const header = request.headers['x-csrf-token'];
    return Array.isArray(header) ? header[0] : header;
  }

  private sign(nonce: string): string {
    return createHmac('sha256', this.config.get('APP_SECRET')).update(nonce).digest('base64url');
  }

  private matches(nonce: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(nonce));
    const actual = Buffer.from(signature);
    // Constant time: a length check short-circuits, so compare that separately.
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
