import { Controller, Get, Header, Inject, UseGuards } from '@nestjs/common';
import { ConfigService } from '../../config/index.js';
import { RawResponse } from '../../http/envelope.interceptor.js';
import { ZodQuery } from '../../http/zod-validation.pipe.js';
import { LOG_STORE, type LogQuery, type LogRecord, type LogStore } from '../../stores/stores.js';
import { OpsGuard } from '../ops.guard.js';
import {
  type ListQuery,
  ListQuerySchema,
  levelNumber,
  parseRelative,
  parseSearch,
  resolveWindow,
  urlWith,
} from '../ops-query.js';
import { OpsView } from '../view/ops-view.service.js';

interface TimelineLine extends LogRecord {
  duplicates: number;
}

interface TimelineGroup {
  key: string;
  kind: 'request' | 'workflow' | 'loose';
  label: string;
  href?: string;
  status?: number | null;
  method?: string | null;
  startedAt: Date;
  worstLevel: number;
  lines: TimelineLine[];
}

/**
 * Logs, rendered as a timeline rather than a table.
 *
 * A flat list of ten thousand lines from forty concurrent requests interleaved
 * is technically the data and practically unreadable. Grouping by the request
 * or workflow that produced each line is what turns it back into a story you
 * can follow — which is the only reason to look at logs at all.
 */
@UseGuards(OpsGuard)
@Controller('logs')
export class OpsLogsController {
  constructor(
    @Inject(LOG_STORE) private readonly logs: LogStore,
    private readonly view: OpsView,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @RawResponse()
  @Header('content-type', 'text/html; charset=utf-8')
  async index(@ZodQuery(ListQuerySchema) query: ListQuery): Promise<string> {
    const base = `${this.config.get('OPS_PATH')}/logs`;
    const window = resolveWindow(query.window);
    const search = parseSearch(query.q);
    const by = query.by ?? 'route';
    const limit = query.limit ?? 200;

    if (!this.config.get('OPS_LOGS_ENABLED')) {
      return this.view.render(
        'logs/index',
        {
          title: 'Logs',
          degraded:
            'Log recording is switched off (OPS_LOGS_ENABLED=false), so there is nothing to ' +
            'read here. Container logs still have everything.',
          groups: [],
          ...this.chrome(base, query, search.raw, by, window.key),
        },
        'logs',
      );
    }

    const filter = this.toQuery(search, window, limit);

    let page: Awaited<ReturnType<LogStore['query']>> | null = null;
    let rail: Awaited<ReturnType<LogStore['facets']>> = [];
    let levels: Record<number, number> = {};
    let degraded: string | undefined;
    let railUnavailable: string | undefined;

    try {
      page = await this.logs.query(filter);
    } catch (error) {
      degraded = `Could not read logs: ${message(error)}`;
    }

    // The rail and the level counts are secondary: if they fail, the logs
    // themselves are still worth rendering, with the rail saying it is blind.
    try {
      [rail, levels] = await Promise.all([
        this.logs.facets(by, filter),
        this.logs.countsByLevel(filter),
      ]);
    } catch (error) {
      railUnavailable = message(error);
    }

    const current = search.tokens[by];
    return this.view.render(
      'logs/index',
      {
        title: 'Logs',
        degraded,
        railUnavailable,
        groups: page ? this.timeline(page.data) : [],
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
        railDimensions: (['route', 'feature', 'group'] as const).map((dimension) => ({
          label: dimension,
          active: by === dimension,
          href: urlWith(base, { ...query }, { by: dimension, cursor: undefined }),
        })),
        levelCounts: Object.entries(levels)
          .map(([level, count]) => ({ level: Number(level), count }))
          .sort((a, b) => b.level - a.level),
        ...this.chrome(base, query, search.raw, by, window.key),
      },
      'logs',
    );
  }

  private toQuery(
    search: ReturnType<typeof parseSearch>,
    window: ReturnType<typeof resolveWindow>,
    limit: number,
  ): LogQuery {
    const { tokens, text } = search;
    return {
      search: text || undefined,
      minLevel: tokens.level ? levelNumber(tokens.level) : undefined,
      route: tokens.route,
      feature: tokens.feature,
      group: tokens.group,
      requestId: tokens.req,
      workflowId: tokens.wf,
      jobId: tokens.job,
      since: tokens.since ? (parseRelative(tokens.since) ?? window.since) : window.since,
      before: tokens.before ? (parseRelative(tokens.before) ?? undefined) : undefined,
      cursor: undefined,
      limit,
    };
  }

  /**
   * Fold a flat, newest-first list into per-request / per-workflow groups,
   * collapsing runs of identical consecutive messages into a `×N`.
   *
   * Lines with no correlation id (boot, schedulers, anything outside a request)
   * are kept in their own buckets rather than dropped — a log line with nowhere
   * to belong is often the interesting one.
   */
  private timeline(records: LogRecord[]): TimelineGroup[] {
    const groups = new Map<string, TimelineGroup>();
    const opsPath = this.config.get('OPS_PATH');

    for (const record of records) {
      const kind: TimelineGroup['kind'] = record.workflowId
        ? 'workflow'
        : record.requestId
          ? 'request'
          : 'loose';
      const key =
        kind === 'workflow'
          ? `wf:${record.workflowId}`
          : kind === 'request'
            ? `req:${record.requestId}`
            : `loose:${record.ts.toISOString().slice(0, 16)}`;

      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          kind,
          label:
            kind === 'workflow'
              ? (record.ctx.workflowName as string) || (record.workflowId ?? '')
              : kind === 'request'
                ? `${record.method ?? ''} ${record.route ?? '—'}`.trim()
                : 'uncorrelated',
          href:
            kind === 'workflow'
              ? `${opsPath}/workflows/${record.workflowId}`
              : kind === 'request'
                ? `${opsPath}/requests?q=req:${record.requestId}`
                : undefined,
          status: record.status,
          method: record.method,
          startedAt: record.ts,
          worstLevel: record.level,
          lines: [],
        };
        groups.set(key, group);
      }

      group.worstLevel = Math.max(group.worstLevel, record.level);
      if (record.ts < group.startedAt) group.startedAt = record.ts;

      const previous = group.lines.at(-1);
      if (previous && previous.msg === record.msg && previous.level === record.level) {
        previous.duplicates++;
      } else {
        group.lines.push({ ...record, duplicates: 1 });
      }
    }

    return [...groups.values()];
  }

  private chrome(
    base: string,
    query: ListQuery,
    q: string,
    by: string,
    window: string,
  ): Record<string, unknown> {
    return {
      window,
      q,
      by,
      currentPath: base,
      searchAction: base,
      carry: { q: query.q, by: query.by },
      searchPlaceholder: 'level:error route:/loans/:id wf:loan-8f3 timed out',
      searchHint:
        'Filter with <code>level:</code> <code>route:</code> <code>feature:</code> ' +
        '<code>group:</code> <code>req:</code> <code>wf:</code> <code>job:</code> ' +
        '<code>since:2h</code>. Anything else is full-text.',
      emptyTitle: 'No log lines in this window.',
      emptyHint: 'Widen the time window, lower the level filter, or clear the search.',
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
