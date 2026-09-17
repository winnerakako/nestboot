import { Controller, Get, Header, Inject, UseGuards } from '@nestjs/common';
import { ConfigService } from '../../config/index.js';
import { RawResponse } from '../../http/envelope.interceptor.js';
import { ZodQuery } from '../../http/zod-validation.pipe.js';
import { REQUEST_STORE, type RequestQuery, type RequestStore } from '../../stores/stores.js';
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
 * Requests, by route.
 *
 * The default view is the per-route table rather than a log of individual
 * requests, because "which endpoint regressed" is answerable at a glance and
 * "what did request 4,812 do" is a lookup you arrive at from somewhere else.
 */
@UseGuards(OpsGuard)
@Controller('requests')
export class OpsRequestsController {
  constructor(
    @Inject(REQUEST_STORE) private readonly requests: RequestStore,
    private readonly view: OpsView,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @RawResponse()
  @Header('content-type', 'text/html; charset=utf-8')
  async index(@ZodQuery(ListQuerySchema) query: ListQuery): Promise<string> {
    const base = `${this.config.get('OPS_PATH')}/requests`;
    const window = resolveWindow(query.window);
    const search = parseSearch(query.q);
    const by = query.by === 'group' ? 'feature' : (query.by ?? 'route');

    if (!this.config.get('OPS_REQUESTS_ENABLED')) {
      return this.view.render(
        'requests/index',
        {
          title: 'Requests',
          degraded:
            'Request recording is switched off (OPS_REQUESTS_ENABLED=false), so there is ' +
            'nothing to read here.',
          routes: [],
          window: window.key,
          ...this.chrome(base, query, search.raw, by),
        },
        'requests',
      );
    }

    const filter: RequestQuery = {
      search: search.text || undefined,
      route: search.tokens.route,
      feature: search.tokens.feature,
      method: search.tokens.method?.toUpperCase(),
      minStatus: search.tokens.status ? Number(search.tokens.status) : undefined,
      maxStatus: search.tokens.status ? Number(search.tokens.status) : undefined,
      minDurationMs: search.tokens.slower ? Number(search.tokens.slower) : undefined,
      since: window.since,
      limit: query.limit ?? 50,
    };

    let routes: Awaited<ReturnType<RequestStore['byRoute']>> = [];
    let slowest: Awaited<ReturnType<RequestStore['query']>> | null = null;
    let rail: Awaited<ReturnType<RequestStore['facets']>> = [];
    let degraded: string | undefined;
    let railUnavailable: string | undefined;

    try {
      [routes, slowest] = await Promise.all([
        this.requests.byRoute(filter),
        // The failures and the slow tail: the two lists anyone actually opens.
        this.requests.query({ ...filter, minStatus: 500, limit: 25 }),
      ]);
    } catch (error) {
      degraded = `Could not read requests: ${message(error)}`;
    }
    try {
      rail = await this.requests.facets(by, filter);
    } catch (error) {
      railUnavailable = message(error);
    }

    const current = search.tokens[by];
    const totalVolume = routes.reduce((sum, route) => sum + route.volume, 0);
    const totalErrors = routes.reduce((sum, route) => sum + route.volume * route.errorRate, 0);

    return this.view.render(
      'requests/index',
      {
        title: 'Requests',
        degraded,
        railUnavailable,
        window: window.key,
        q: search.raw,
        by,
        routes,
        failed: slowest?.data ?? [],
        totalVolume,
        totalErrors,
        errorRate: totalVolume > 0 ? totalErrors / totalVolume : 0,
        // Sampling makes count(*) a lie; say the rate out loud when it is on.
        sampled: this.config.get('OPS_REQUEST_SAMPLE') < 1,
        sampleRate: this.config.get('OPS_REQUEST_SAMPLE'),
        rail: rail.map((facet) => ({
          ...facet,
          active: current === facet.value,
          href: urlWith(base, { ...query }, { q: `${by}:${facet.value}` }),
        })),
        railDimensions: (['route', 'feature'] as const).map((dimension) => ({
          label: dimension,
          active: by === dimension,
          href: urlWith(base, { ...query }, { by: dimension }),
        })),
        ...this.chrome(base, query, search.raw, by),
      },
      'requests',
    );
  }

  private chrome(base: string, query: ListQuery, q: string, by: string): Record<string, unknown> {
    return {
      q,
      by,
      currentPath: base,
      searchAction: base,
      carry: { q: query.q, by: query.by },
      searchPlaceholder: 'route:/loans/:id status:500 slower:1000',
      searchHint:
        'Filter with <code>route:</code> <code>feature:</code> <code>method:</code> ' +
        '<code>status:</code> <code>slower:</code> (ms).',
      emptyTitle: 'No requests in this window.',
      emptyHint: 'Widen the time window, or clear the filters.',
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
