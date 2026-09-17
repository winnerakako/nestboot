import { Controller, Get, Header, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ConfigService } from '../../config/index.js';
import { RawResponse } from '../../http/envelope.interceptor.js';
import { NotFoundException } from '../../http/platform.exception.js';
import { ZodQuery } from '../../http/zod-validation.pipe.js';
import { CsrfProtection } from '../../security/csrf.js';
import { ERROR_STORE, type ErrorQuery, type ErrorStore } from '../../stores/stores.js';
import { OpsGuard } from '../ops.guard.js';
import {
  type ListQuery,
  ListQuerySchema,
  parseSearch,
  resolveWindow,
  urlWith,
} from '../ops-query.js';
import { OpsView } from '../view/ops-view.service.js';

/**
 * Errors, grouped by fingerprint.
 *
 * The list is of *bugs*, not occurrences: a thousand rows of the same broken
 * endpoint is one problem, and a tab that shows it as a thousand lines is a tab
 * nobody can triage from.
 */
@UseGuards(OpsGuard)
@Controller('errors')
export class OpsErrorsController {
  constructor(
    @Inject(ERROR_STORE) private readonly errors: ErrorStore,
    private readonly view: OpsView,
    private readonly csrf: CsrfProtection,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @RawResponse()
  @Header('content-type', 'text/html; charset=utf-8')
  async index(
    @ZodQuery(ListQuerySchema) query: ListQuery,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const base = `${this.config.get('OPS_PATH')}/errors`;
    const window = resolveWindow(query.window);
    const search = parseSearch(query.q);
    const by = query.by === 'group' ? 'feature' : (query.by ?? 'route');

    const filter: ErrorQuery = {
      search: search.text || undefined,
      route: search.tokens.route,
      feature: search.tokens.feature,
      status: (search.tokens.status as ErrorQuery['status']) ?? 'open',
      since: window.since,
      cursor: query.cursor,
      limit: query.limit ?? 50,
    };

    let page: Awaited<ReturnType<ErrorStore['groups']>> | null = null;
    let rail: Awaited<ReturnType<ErrorStore['facets']>> = [];
    let degraded: string | undefined;
    let railUnavailable: string | undefined;

    try {
      page = await this.errors.groups(filter);
    } catch (error) {
      degraded = `Could not read errors: ${message(error)}`;
    }
    try {
      rail = await this.errors.facets(by, filter);
    } catch (error) {
      railUnavailable = message(error);
    }

    const current = search.tokens[by];
    return this.view.render(
      'errors/index',
      {
        title: 'Errors',
        degraded,
        railUnavailable,
        window: window.key,
        q: search.raw,
        by,
        csrf: this.csrf.issue(reply),
        groups: page?.data ?? [],
        count: page?.data.length ?? 0,
        hasMore: page?.hasMore ?? false,
        nextHref: page?.nextCursor
          ? urlWith(base, { ...query }, { cursor: page.nextCursor })
          : undefined,
        rail: rail.map((facet) => ({
          ...facet,
          active: current === facet.value,
          href: urlWith(base, { ...query }, { q: `${by}:${facet.value}`, cursor: undefined }),
        })),
        railDimensions: (['route', 'feature'] as const).map((dimension) => ({
          label: dimension,
          active: by === dimension,
          href: urlWith(base, { ...query }, { by: dimension, cursor: undefined }),
        })),
        statusFilters: (['open', 'resolved', 'muted'] as const).map((status) => ({
          label: status,
          active: filter.status === status,
          href: urlWith(base, { ...query }, { q: `status:${status}`, cursor: undefined }),
        })),
        currentPath: base,
        searchAction: base,
        carry: { q: query.q, by: query.by },
        searchPlaceholder: 'status:open route:/loans/:id TypeError',
        searchHint:
          'Filter with <code>status:</code> <code>route:</code> <code>feature:</code>. ' +
          'Anything else matches the type and message.',
        emptyTitle: 'No errors in this window.',
        emptyHint: 'That is the good outcome. Widen the window to be sure.',
      },
      'errors',
    );
  }

  @Get(':fingerprint')
  @RawResponse()
  @Header('content-type', 'text/html; charset=utf-8')
  async detail(
    @Param('fingerprint') fingerprint: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const group = await this.errors.group(fingerprint);
    if (!group) throw new NotFoundException('error group', fingerprint);

    const occurrences = await this.errors.occurrences(fingerprint, { limit: 20 });

    return this.view.render(
      'errors/detail',
      {
        title: group.type,
        group,
        csrf: this.csrf.issue(reply),
        occurrences: occurrences.data,
        latest: occurrences.data[0],
        currentPath: `${this.config.get('OPS_PATH')}/errors/${fingerprint}`,
      },
      'errors',
    );
  }

  @Post(':fingerprint/resolve')
  async resolve(
    @Param('fingerprint') fingerprint: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.errors.resolve(fingerprint, request.opsSession?.username ?? 'unknown');
    this.back(reply, fingerprint);
  }

  @Post(':fingerprint/mute')
  async mute(
    @Param('fingerprint') fingerprint: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // A day: long enough to get through an incident, short enough that a muted
    // bug resurfaces rather than being silently forgotten forever.
    const until = new Date(Date.now() + 24 * 3_600_000);
    await this.errors.mute(fingerprint, until, request.opsSession?.username ?? 'unknown');
    this.back(reply, fingerprint);
  }

  @Post(':fingerprint/reopen')
  async reopen(
    @Param('fingerprint') fingerprint: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.errors.reopen(fingerprint);
    this.back(reply, fingerprint);
  }

  private back(reply: FastifyReply, fingerprint: string): void {
    void reply
      .status(303)
      .header('location', `${this.config.get('OPS_PATH')}/errors/${fingerprint}`)
      .send();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
