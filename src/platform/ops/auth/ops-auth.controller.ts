import { Body, Controller, Get, Header, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ConfigService } from '../../config/index.js';
import { RawResponse } from '../../http/envelope.interceptor.js';
import { CsrfProtection } from '../../security/csrf.js';
import { SecurityEvents } from '../../security/events/security-events.js';
import { OpsSessions } from '../../security/ops-auth/ops-sessions.service.js';
import { OpsUsers } from '../../security/ops-auth/ops-users.service.js';
import { RouteGroup, RouteGroups } from '../../security/rate-limit/subject.js';
import { OpsGuard, OpsPublic } from '../ops.guard.js';
import { OpsView } from '../view/ops-view.service.js';

interface LoginForm {
  username?: string;
  password?: string;
  totp?: string;
  _csrf?: string;
}

/**
 * Sign in and out.
 *
 * Rate-limited under the `ops` group (5/min by default) and backed by account
 * lockout, so the console's login is not the softest way into the system.
 */
@UseGuards(OpsGuard)
@RouteGroup(RouteGroups.ops)
@Controller('auth')
export class OpsAuthController {
  constructor(
    private readonly users: OpsUsers,
    private readonly sessions: OpsSessions,
    private readonly events: SecurityEvents,
    private readonly csrf: CsrfProtection,
    private readonly view: OpsView,
    private readonly config: ConfigService,
  ) {}

  @Get('login')
  @OpsPublic()
  @RawResponse()
  @Header('content-type', 'text/html; charset=utf-8')
  loginForm(@Res({ passthrough: true }) reply: FastifyReply): string {
    return this.render(reply, {});
  }

  @Post('login')
  @OpsPublic()
  @RawResponse()
  @Header('content-type', 'text/html; charset=utf-8')
  async login(
    @Body() form: LoginForm,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string | undefined> {
    this.csrf.verify(request);

    const username = (form.username ?? '').trim().slice(0, 200);
    const password = form.password ?? '';
    const totp = form.totp?.replace(/\s/g, '');

    if (!username || !password) {
      return this.render(reply, { error: 'Enter a username and password.', username });
    }

    const result = await this.users.authenticate(username, password, totp || undefined);

    // Intentional: every failure renders the same message. Distinguishing "no
    // such user" from "wrong password" from "wrong code" hands an attacker a
    // free account-enumeration oracle, and tells a legitimate operator nothing
    // they can act on either.
    const GENERIC = 'Those details were not accepted.';

    switch (result.status) {
      case 'ok': {
        await this.sessions.create(result.user.id, request, reply);
        this.events.record({
          kind: 'login',
          outcome: 'success',
          subject: { kind: 'user', id: result.user.username },
          request,
        });
        void reply.status(303).header('location', `${this.config.get('OPS_PATH')}/workflows`);
        return undefined;
      }

      case 'enrol_totp':
        // No session yet: the account is not fully protected until a code from
        // this secret has been verified.
        return this.render(reply, {
          username,
          enrol: { secret: result.secret, otpauth: result.otpauth },
          notice:
            'Add this secret to your authenticator app, then enter the current code to finish.',
        });

      case 'totp_required':
        return this.render(reply, { username, needsTotp: true });

      case 'totp_invalid':
        this.events.record({
          kind: 'login',
          outcome: 'failure',
          subject: { kind: 'user', id: username },
          request,
          detail: { reason: 'totp_invalid' },
        });
        return this.render(reply, { username, needsTotp: true, error: GENERIC });

      case 'locked': {
        this.events.record({
          kind: 'lockout',
          outcome: 'blocked',
          subject: { kind: 'user', id: username },
          request,
        });
        const minutes = Math.ceil((result.until.getTime() - Date.now()) / 60_000);
        return this.render(reply, {
          username,
          error: `This account is locked for another ${minutes} minute(s).`,
        });
      }

      default:
        this.events.record({
          kind: 'login',
          outcome: 'failure',
          subject: { kind: 'user', id: username },
          request,
          // Never the attempted password: a spray attempt is the last thing
          // worth writing durably to a table an operator will screenshot.
          detail: { reason: result.status },
        });
        return this.render(reply, { username, error: GENERIC });
    }
  }

  @Post('logout')
  async logout(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    this.csrf.verify(request);

    const session = request.opsSession;
    if (session) {
      await this.sessions.revoke(session.tokenHash);
      this.events.record({
        kind: 'logout',
        outcome: 'success',
        subject: { kind: 'user', id: session.username },
        request,
      });
    }
    this.sessions.clearCookie(reply);
    void reply
      .status(303)
      .header('location', `${this.config.get('OPS_PATH')}/auth/login`)
      .send();
  }

  private render(
    reply: FastifyReply,
    context: {
      error?: string;
      notice?: string;
      username?: string;
      needsTotp?: boolean;
      enrol?: { secret: string; otpauth: string };
    },
  ): string {
    return this.view.render(
      'auth/login',
      { title: 'Sign in', csrf: this.csrf.issue(reply), ...context },
      'login',
    );
  }
}
