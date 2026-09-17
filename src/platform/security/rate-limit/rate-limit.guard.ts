import { CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RateLimitedException } from '../../http/platform.exception.js';
import { RATE_LIMIT_STORE, type RateLimitStore } from '../../stores/stores.js';
import { SecurityEvents } from '../events/security-events.js';
import { RateLimitPolicies } from './policy.js';
import {
  RATE_LIMIT_RESOLVER,
  type RateLimitSubjectResolver,
  ROUTE_GROUP_KEY,
  subjectKey,
} from './subject.js';

/**
 * Enforces the resolved policy for every subject a request maps to.
 *
 * All subjects are checked, not just the most specific: an app resolving
 * `[org, user, ip]` wants the org's plan limit AND the per-user limit AND the
 * per-IP abuse limit to hold. The first exhausted one wins and names itself in
 * the response, so a client that hits a wall is told which wall.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policies: RateLimitPolicies,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    @Inject(RATE_LIMIT_RESOLVER) private readonly resolver: RateLimitSubjectResolver,
    private readonly events: SecurityEvents,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    try {
      return await this.enforce(context, request, reply);
    } catch (error) {
      // A RateLimitedException is the limiter working; anything else is the
      // limiter broken, and those must not be confused.
      if (error instanceof RateLimitedException) throw error;

      // Intentional: FAIL OPEN. If the policy table or the counter store cannot
      // be read, the request is allowed through and the failure is recorded.
      //
      // Failing closed would turn any database blip into a total outage — the
      // limiter would reject 100% of traffic precisely when the app is already
      // struggling. A window of unlimited requests is the smaller harm, and it
      // is what every production limiter does. The security event is how an
      // operator learns the control is currently not running.
      this.events.record({
        kind: 'rate_limit',
        outcome: 'failure',
        request,
        detail: {
          reason: 'the rate limiter could not run; the request was allowed through',
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return true;
    }
  }

  private async enforce(
    context: ExecutionContext,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> {
    const routeGroup =
      this.reflector.getAllAndOverride<string>(ROUTE_GROUP_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? '*';

    const subjects = this.resolver.resolve(request);
    if (subjects.length === 0) return true;

    let tightest: { remaining: number; limit: number; resetAt: Date } | undefined;

    for (const subject of subjects) {
      const policy = await this.policies.resolve(subject, routeGroup);
      if (!policy) continue;

      const hit = await this.store.increment(subject, routeGroup, policy.windowSeconds);
      const allowance = policy.maxRequests + (policy.burst ?? 0);
      const remaining = Math.max(0, allowance - hit.count);
      const resetAt = new Date(hit.windowStart.getTime() + policy.windowSeconds * 1000);

      // Report the *tightest* remaining budget across every subject: a client
      // told it has 99 left by one limit and 0 by another has been misled.
      if (!tightest || remaining < tightest.remaining) {
        tightest = { remaining, limit: allowance, resetAt };
      }

      if (hit.count <= allowance) continue;

      const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));

      this.events.record({
        kind: 'rate_limit',
        // Shadow mode records the would-be block without imposing it, which is
        // how a new limit is proven safe before it starts rejecting customers.
        outcome: policy.action === 'reject' ? 'blocked' : 'would_block',
        subject,
        request,
        detail: {
          routeGroup,
          policyId: policy.id,
          count: hit.count,
          allowance,
          action: policy.action,
        },
      });

      if (policy.action === 'log_only') continue;

      this.setHeaders(reply, { limit: allowance, remaining: 0, resetAt });
      throw new RateLimitedException(
        `Rate limit exceeded for ${subjectKey(subject)} on ${routeGroup}.`,
        retryAfter,
        { scope: subject.kind, routeGroup, policy: policy.id },
      );
    }

    if (tightest) this.setHeaders(reply, tightest);
    return true;
  }

  /** RFC 9239 draft headers, which is what every client library now reads. */
  private setHeaders(
    reply: FastifyReply,
    state: { limit: number; remaining: number; resetAt: Date },
  ): void {
    const resetSeconds = Math.max(0, Math.ceil((state.resetAt.getTime() - Date.now()) / 1000));
    void reply.header('ratelimit-limit', String(state.limit));
    void reply.header('ratelimit-remaining', String(state.remaining));
    void reply.header('ratelimit-reset', String(resetSeconds));
  }
}
