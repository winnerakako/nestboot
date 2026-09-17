import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ConfigService } from '../config/index.js';
import { ForbiddenException, UnauthenticatedException } from '../http/platform.exception.js';
import { CsrfProtection } from '../security/csrf.js';
import { SecurityEvents } from '../security/events/security-events.js';
import { OpsSessions } from '../security/ops-auth/ops-sessions.service.js';

const PUBLIC = 'ops:public';

/**
 * The login page and the static assets. Everything else needs a session.
 *
 * An explicit opt-out rather than an opt-in, so a new controller is protected by
 * default and making it public is a visible decision in a diff.
 */
export const OpsPublic = () => SetMetadata(PUBLIC, true);

declare module 'fastify' {
  interface FastifyRequest {
    opsSession?: { userId: string; username: string; tokenHash: string };
  }
}

/**
 * Three gates, in this order: the console is enabled, the address is allowed,
 * the session is valid.
 *
 * The order is the point. An IP allowlist that only applies after the login form
 * has rendered has already published the login form to the internet, and a
 * disabled console that returns 403 has confirmed it exists.
 */
@Injectable()
export class OpsGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly sessions: OpsSessions,
    private readonly events: SecurityEvents,
    private readonly csrf: CsrfProtection,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    // Intentional: 404, not 403. A disabled console should be indistinguishable
    // from one that was never deployed — a 403 confirms there is something here.
    if (!this.config.get('OPS_ENABLED')) {
      throw new NotFoundException();
    }

    const allowlist = this.config.get('OPS_IP_ALLOWLIST');
    if (allowlist.length > 0 && !this.allowed(request.ip, allowlist)) {
      this.events.record({
        kind: 'ip_blocked',
        outcome: 'blocked',
        subject: { kind: 'ip', id: request.ip },
        request,
      });
      throw new ForbiddenException('This address is not permitted to reach the operator console.');
    }

    // CSRF is checked here, for every unsafe method, BEFORE the public check —
    // so the sign-in POST is covered too, and so no handler can forget it.
    //
    // It was per-handler once, and eight of the eleven mutations did forget:
    // cancel a workflow, fork it, run a schedule now, retry a dead letter. Those
    // are the most destructive buttons in the app. SameSite=Lax already blocks
    // the cross-site POST, but a browser policy is not a server check, and this
    // surface deserves both.
    this.csrf.verify(request);

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const session = await this.sessions.resolve(request);
    if (!session) {
      throw new UnauthenticatedException('Sign in to reach the operator console.');
    }

    // Attached so a controller can attribute an action — "resolved by whom" is
    // half the value of an audit trail.
    request.opsSession = {
      userId: session.userId,
      username: session.username,
      tokenHash: session.tokenHash,
    };
    return true;
  }

  /**
   * Exact addresses and CIDR prefixes. `request.ip` is only trustworthy when
   * TRUST_PROXY names the balancer — which config refuses to start without in
   * production, so the two rules hold each other up.
   */
  private allowed(ip: string, allowlist: string[]): boolean {
    return allowlist.some((entry) => (entry.includes('/') ? inCidr(ip, entry) : entry === ip));
  }
}

export function inCidr(ip: string, cidr: string): boolean {
  const [range, bitsText] = cidr.split('/');
  if (!range || !bitsText) return false;
  const bits = Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const a = toIpv4(ip);
  const b = toIpv4(range);
  if (a === null || b === null) return false;
  if (bits === 0) return true;

  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function toIpv4(value: string): number | null {
  // Node reports IPv4-mapped IPv6 for dual-stack sockets; the mapped form is
  // the same address and must match the same rule.
  const text = value.startsWith('::ffff:') ? value.slice(7) : value;
  const parts = text.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = (result << 8) | octet;
  }
  return result >>> 0;
}
