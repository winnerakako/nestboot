import { Controller, Get, Header, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ConfigService } from '../../config/index.js';
import { DbosService } from '../../dbos/dbos.service.js';
import { OpsMeta } from '../../dbos/ops-meta.js';
import { isTerminal, type WorkflowQuery, type WorkflowSummary } from '../../dbos/runtime.js';
import { RawResponse } from '../../http/envelope.interceptor.js';
import { NotFoundException } from '../../http/platform.exception.js';
import { ZodQuery } from '../../http/zod-validation.pipe.js';
import { CsrfProtection } from '../../security/csrf.js';
import { OpsGuard } from '../ops.guard.js';
import {
  type ListQuery,
  ListQuerySchema,
  parseRelative,
  parseSearch,
  resolveWindow,
  urlWith,
} from '../ops-query.js';
import { OpsView } from '../view/ops-view.service.js';

/**
 * Workflows: the tab that answers "what is the app doing, and what is stuck".
 *
 * Filters go to the database as workflow *attributes* (group, feature, kind),
 * which every start stamps — so filtering by group is a WHERE clause rather
 * than fetching a page and discarding most of it in memory, which would make
 * the filter lie about how many matches exist.
 */
@UseGuards(OpsGuard)
@Controller('workflows')
export class OpsWorkflowsController {
  constructor(
    private readonly dbos: DbosService,
    private readonly view: OpsView,
    private readonly csrf: CsrfProtection,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @RawResponse()
  @Header('content-type', 'text/html; charset=utf-8')
  async list(
    @ZodQuery(ListQuerySchema) query: ListQuery,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const opsPath = this.config.get('OPS_PATH');
    const base = `${opsPath}/workflows`;
    const window = resolveWindow(query.window);
    const search = parseSearch(query.q);
    const by = query.by ?? 'group';
    const limit = query.limit ?? 50;

    const runtime = this.dbos.runtimeOrNull();
    if (!runtime) {
      // Never present an absence as a fact: say the engine is unreachable
      // rather than rendering a convincing empty list.
      return this.view.render(
        'workflows/list',
        {
          title: 'Workflows',
          csrf: this.csrf.issue(reply),
          degraded: 'The workflow engine is not connected, so nothing can be listed.',
          window: window.key,
          workflows: [],
          rail: [],
          q: search.raw,
          by,
          ...this.chrome(base, query),
        },
        'workflows',
      );
    }

    const filter = this.toQuery(search, window, limit);

    let workflows: WorkflowSummary[] = [];
    let degraded: string | undefined;
    try {
      // limit+1 tells us whether an "older" page exists without a second count.
      workflows = await runtime.list({ ...filter, limit: limit + 1 });
    } catch (error) {
      degraded = `Could not read workflows: ${message(error)}`;
    }

    const hasMore = workflows.length > limit;
    const page = hasMore ? workflows.slice(0, limit) : workflows;

    return this.view.render(
      'workflows/list',
      {
        title: 'Workflows',
        degraded,
        csrf: this.csrf.issue(reply),
        window: window.key,
        q: search.raw,
        by,
        workflows: page,
        count: page.length,
        hasMore,
        nextHref: hasMore
          ? urlWith(base, { ...query }, { offset: (filter.offset ?? 0) + limit })
          : undefined,
        rail: this.rail(by, page, base, query),
        railDimensions: ['group', 'feature', 'route'].map((dimension) => ({
          label: dimension,
          active: by === dimension,
          href: urlWith(base, { ...query }, { by: dimension }),
        })),
        ...this.chrome(base, query),
      },
      'workflows',
    );
  }

  @Get(':id')
  @RawResponse()
  @Header('content-type', 'text/html; charset=utf-8')
  async detail(
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query('window') windowKey?: string,
  ): Promise<string> {
    const runtime = this.dbos.runtimeOrNull();
    if (!runtime) throw new NotFoundException('workflow', id);

    const workflow = await runtime.get(id);
    if (!workflow) throw new NotFoundException('workflow', id);

    let steps: Awaited<ReturnType<typeof runtime.steps>> = [];
    let degraded: string | undefined;
    try {
      steps = await runtime.steps(id);
    } catch (error) {
      degraded = `Could not read this workflow's steps: ${message(error)}`;
    }

    const failedIndex = steps.findIndex((step) => step.error !== null && step.error !== undefined);

    return this.view.render(
      'workflows/detail',
      {
        title: `Workflow ${workflow.name}`,
        degraded,
        csrf: this.csrf.issue(reply),
        window: resolveWindow(windowKey).key,
        workflow,
        meta: OpsMeta.get(workflow.name),
        steps: steps.map((step, index) => ({ ...step, failed: index === failedIndex })),
        // Resume only makes sense for something that stopped; fork is the tool
        // for re-running a terminal workflow from a step you have since fixed.
        canResume: !isTerminal(workflow.status),
        canCancel: !isTerminal(workflow.status),
        failedStep: failedIndex >= 0 ? steps[failedIndex] : undefined,
        currentPath: `${this.config.get('OPS_PATH')}/workflows/${id}`,
      },
      'workflows',
    );
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    await this.runtime().cancel(id);
    this.back(reply, `/workflows/${id}`);
  }

  @Post(':id/resume')
  async resume(@Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    await this.runtime().resume(id);
    this.back(reply, `/workflows/${id}`);
  }

  @Post(':id/fork')
  async fork(
    @Param('id') id: string,
    @Query('step') step: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const startStep = Number(step);
    if (!Number.isInteger(startStep) || startStep < 1) {
      throw new NotFoundException('step', step);
    }
    const newId = await this.runtime().fork(id, startStep);
    // Land on the new workflow, not the old one: the operator's next question
    // is always "did the re-run work", and that is a different row.
    this.back(reply, `/workflows/${newId}`);
  }

  private runtime() {
    const runtime = this.dbos.runtimeOrNull();
    if (!runtime) throw new NotFoundException('workflow engine');
    return runtime;
  }

  private back(reply: FastifyReply, path: string): void {
    void reply
      .status(303)
      .header('location', `${this.config.get('OPS_PATH')}${path}`)
      .send();
  }

  private toQuery(
    search: ReturnType<typeof parseSearch>,
    window: ReturnType<typeof resolveWindow>,
    limit: number,
  ): WorkflowQuery {
    const { tokens, text } = search;
    const attributes: Record<string, unknown> = {};
    if (tokens.group) attributes.group = tokens.group;
    if (tokens.feature) attributes.feature = tokens.feature;
    if (tokens.kind) attributes.kind = tokens.kind;
    if (tokens.req) attributes.requestId = tokens.req;

    return {
      // An exact id typed into the box is treated as an id, not a text search:
      // it is the single most common thing an operator pastes.
      ids: tokens.wf ? [tokens.wf] : text && looksLikeId(text) ? [text] : undefined,
      name: tokens.name ?? (text && !looksLikeId(text) ? text : undefined),
      status: tokens.status?.toUpperCase(),
      queueName: tokens.queue,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
      startTime: tokens.since ? (parseRelative(tokens.since) ?? window.since) : window.since,
      endTime: tokens.before ? (parseRelative(tokens.before) ?? undefined) : undefined,
      limit,
      sortDesc: true,
      loadInput: false,
      loadOutput: false,
    };
  }

  /**
   * Counts for the left rail, computed from the page in hand.
   *
   * Intentional: these count the rows currently listed, not the whole window —
   * DBOS exposes no aggregate query, and issuing one count per distinct group
   * would be dozens of round trips per page load. The template says so, because
   * a count that silently means something narrower than it appears is worse
   * than no count.
   */
  private rail(
    by: string,
    workflows: WorkflowSummary[],
    base: string,
    query: ListQuery,
  ): Array<{ value: string; count: number; href: string; active: boolean }> {
    const counts = new Map<string, number>();
    for (const workflow of workflows) {
      const value =
        by === 'feature' ? workflow.feature : by === 'route' ? workflow.queueName : workflow.group;
      if (!value) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    const current = parseSearch(query.q).tokens[by === 'route' ? 'queue' : by];
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({
        value,
        count,
        active: current === value,
        href: urlWith(base, { ...query }, { q: `${by === 'route' ? 'queue' : by}:${value}` }),
      }));
  }

  private chrome(base: string, query: ListQuery): Record<string, unknown> {
    return {
      currentPath: base,
      searchAction: base,
      carry: { q: query.q, by: query.by },
      searchPlaceholder: 'status:ERROR group:payments queue:mail SendReceipt',
      searchHint:
        'Filter with <code>status:</code> <code>group:</code> <code>feature:</code> ' +
        '<code>kind:</code> <code>queue:</code> <code>wf:</code> <code>req:</code> ' +
        '<code>since:2h</code>, or type a workflow name.',
      emptyTitle: 'No workflows in this window.',
      emptyHint: 'Widen the time window, or clear the filters.',
    };
  }
}

function looksLikeId(text: string): boolean {
  return /^[\w-]{8,}$/.test(text) && /\d/.test(text);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
