import { Injectable, SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { RateLimitSubject } from '../../stores/stores.js';

/**
 * What a limit is counted against.
 *
 * The template ships only the IP resolver, because it ships no authentication.
 * But the *seam* is here from day one: an app with users registers a resolver
 * returning `[org, user, ip]` and nothing else changes — no page, no guard, no
 * table. Retrofitting per-user limits into an IP-only implementation means
 * touching every one of those.
 */
export interface RateLimitSubjectResolver {
  /** Most specific first. Every subject is checked; the first exhausted wins. */
  resolve(request: FastifyRequest): RateLimitSubject[];
}

export const RATE_LIMIT_RESOLVER = Symbol('RATE_LIMIT_RESOLVER');

@Injectable()
export class IpSubjectResolver implements RateLimitSubjectResolver {
  resolve(request: FastifyRequest): RateLimitSubject[] {
    // request.ip is only trustworthy when TRUST_PROXY names the balancer, which
    // config refuses to start without in production.
    return [{ kind: 'ip', id: request.ip }];
  }
}

const ROUTE_GROUP = 'platform:route-group';

/**
 * Tag a controller or handler with the policy group it belongs to.
 *
 * A tag rather than a regex over the path: a regex has to be kept in step with
 * the router by hand, and the day it drifts the endpoint silently falls back to
 * the loosest policy. `@RouteGroup('auth')` cannot drift from the route it is
 * written on.
 */
export const RouteGroup = (group: string) => SetMetadata(ROUTE_GROUP, group);

export const ROUTE_GROUP_KEY = ROUTE_GROUP;

/** Groups the shipped policies name. An app may invent its own. */
export const RouteGroups = {
  api: 'api',
  auth: 'auth',
  ops: 'ops',
  webhooks: 'webhooks',
} as const;

export function subjectKey(subject: RateLimitSubject): string {
  return `${subject.kind}:${subject.id}`;
}
