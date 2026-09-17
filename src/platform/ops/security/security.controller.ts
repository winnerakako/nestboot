import { Body, Controller, Get, Header, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ConfigService } from '../../config/index.js';
import { RawResponse } from '../../http/envelope.interceptor.js';
import { ZodQuery } from '../../http/zod-validation.pipe.js';
import { CsrfProtection } from '../../security/csrf.js';
import { SecurityEvents } from '../../security/events/security-events.js';
import { OpsSessions } from '../../security/ops-auth/ops-sessions.service.js';
import { OpsUsers } from '../../security/ops-auth/ops-users.service.js';
import { RateLimitPolicies } from '../../security/rate-limit/policy.js';
import {
  RATE_LIMIT_STORE,
  type RateLimitStore,
  type RateLimitSubject,
} from '../../stores/stores.js';
import { OpsGuard } from '../ops.guard.js';
import { type ListQuery, ListQuerySchema, parseSearch, resolveWindow } from '../ops-query.js';
import { OpsView } from '../view/ops-view.service.js';

/**
 * Security: what the guards have been doing, and the controls to change it.
 *
 * Rate-limit policy is editable here on purpose. An operator raising a limit
 * during an incident, or blocking one abusive address, should not need a deploy
 * — a limit that can only be changed by shipping code is a limit nobody dares
 * set tightly in the first place.
 */
@UseGuards(OpsGuard)
@Controller('security')
export class OpsSecurityController {
  constructor(
    private readonly events: SecurityEvents,
    private readonly policies: RateLimitPolicies,
    @Inject(RATE_LIMIT_STORE) private readonly limits: RateLimitStore,
    private readonly sessions: OpsSessions,
    private readonly users: OpsUsers,
    private readonly csrf: CsrfProtection,
    private readonly view: OpsView,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @RawResponse()
  @Header('content-type', 'text/html; charset=utf-8')
  async index(
    @ZodQuery(ListQuerySchema) query: ListQuery,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const window = resolveWindow(query.window);
    const search = parseSearch(query.q);

    const results = await Promise.allSettled([
      this.events.query({
        kind: search.tokens.kind,
        since: window.since,
        cursor: query.cursor,
        limit: query.limit ?? 50,
      }),
      this.events.summary(window.since),
      this.policies.all(),
      this.limits.topOffenders(undefined, 10),
      this.sessions.active(),
      this.users.list(),
    ]);

    // Each panel reports its own failure rather than one failure blanking the
    // page: knowing the sessions while the policy table is unreadable is still
    // worth more than an error page.
    const [events, summary, policies, offenders, sessions, operators] = results;
    const failures = results
      .map((result, index) => (result.status === 'rejected' ? PANELS[index] : undefined))
      .filter(Boolean);

    return this.view.render(
      'security/index',
      {
        title: 'Security',
        degraded:
          failures.length > 0
            ? `These panels could not be read: ${failures.join(', ')}.`
            : undefined,
        window: window.key,
        q: search.raw,
        csrf: this.csrf.issue(reply),
        events: value(events)?.data ?? [],
        summary: value(summary) ?? [],
        policies: (value(policies) ?? []).sort(
          (a, b) => b.priority - a.priority || a.routeGroup.localeCompare(b.routeGroup),
        ),
        offenders: value(offenders) ?? [],
        sessions: value(sessions) ?? [],
        operators: value(operators) ?? [],
        currentPath: `${this.config.get('OPS_PATH')}/security`,
        searchAction: `${this.config.get('OPS_PATH')}/security`,
        carry: { q: query.q },
        searchPlaceholder: 'kind:login',
        searchHint: 'Filter events with <code>kind:</code>.',
      },
      'security',
    );
  }

  @Post('policies')
  async savePolicy(
    @Body() form: Record<string, string>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.policies.upsert({
      id: form.id || undefined,
      routeGroup: form.routeGroup || '*',
      subjectKind: form.subjectKind || '*',
      subjectId: form.subjectId || null,
      maxRequests: Number(form.maxRequests),
      windowSeconds: Number(form.windowSeconds),
      burst: form.burst ? Number(form.burst) : null,
      action: form.action === 'log_only' ? 'log_only' : 'reject',
      priority: Number(form.priority ?? 0),
      enabled: form.enabled !== 'false',
      note: form.note || null,
      expiresAt: null,
    });

    this.events.record({
      kind: 'policy_changed',
      outcome: 'success',
      subject: { kind: 'user', id: request.opsSession?.username ?? 'unknown' },
      request,
      detail: { routeGroup: form.routeGroup, subjectKind: form.subjectKind },
    });
    this.back(reply);
  }

  @Post('block')
  async block(
    @Body() form: { subjectKind?: string; subjectId?: string; minutes?: string },
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const subject: RateLimitSubject = {
      kind: (form.subjectKind ?? 'ip') as RateLimitSubject['kind'],
      id: form.subjectId ?? '',
    };
    const minutes = Number(form.minutes ?? 60);

    // A policy row with an expiry, not a separate block list: it resolves
    // through the same precedence rules and it lifts itself when the incident
    // is over, rather than outliving everyone's memory of why it was added.
    await this.policies.block(
      subject,
      minutes,
      `blocked by ${request.opsSession?.username ?? 'unknown'}`,
    );

    this.events.record({
      kind: 'ip_blocked',
      outcome: 'blocked',
      subject,
      request,
      detail: { minutes, by: request.opsSession?.username },
    });
    this.back(reply);
  }

  @Post('sessions/revoke-all')
  async revokeAll(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const count = await this.sessions.revokeAll();

    this.events.record({
      kind: 'session_revoked',
      outcome: 'success',
      request,
      detail: { count, by: request.opsSession?.username },
    });
    // Including this one: the operator who pressed it is signed out too, which
    // is the correct behaviour for "log everybody out".
    this.sessions.clearCookie(reply);
    void reply
      .status(303)
      .header('location', `${this.config.get('OPS_PATH')}/auth/login`)
      .send();
  }

  @Post('users/:id/unlock')
  async unlock(
    @Body() form: { id?: string },
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!form.id) return this.back(reply);

    await this.users.unlock(form.id);
    // Lifting a lockout is a security decision, so it is recorded like one:
    // an audit trail that shows the lockout but not who cleared it answers
    // half the question.
    this.events.record({
      kind: 'lockout',
      outcome: 'success',
      subject: { kind: 'user', id: form.id },
      request,
      detail: { action: 'unlocked', by: request.opsSession?.username ?? 'unknown' },
    });
    this.back(reply);
  }

  private back(reply: FastifyReply): void {
    void reply
      .status(303)
      .header('location', `${this.config.get('OPS_PATH')}/security`)
      .send();
  }
}

const PANELS = ['events', 'summary', 'policies', 'top offenders', 'sessions', 'operators'];

function value<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === 'fulfilled' ? result.value : undefined;
}
