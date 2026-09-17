import { Controller, Get, Header, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ConfigService } from '../../config/index.js';
import { DbosService } from '../../dbos/dbos.service.js';
import { OpsMeta } from '../../dbos/ops-meta.js';
import { allQueues } from '../../dbos/queues.js';
import type { WorkflowSummary } from '../../dbos/runtime.js';
import { RawResponse } from '../../http/envelope.interceptor.js';
import { NotFoundException } from '../../http/platform.exception.js';
import { CsrfProtection } from '../../security/csrf.js';
import { OpsGuard } from '../ops.guard.js';
import { OpsView } from '../view/ops-view.service.js';

/**
 * Queues: depth, what is stuck, and the controls to unstick it.
 *
 * Grouped by the `@OpsMeta` group rather than by queue name, because the
 * question is "is payments backing up", and payments may span three queues.
 */
@UseGuards(OpsGuard)
@Controller('queues')
export class OpsQueuesController {
  constructor(
    private readonly dbos: DbosService,
    private readonly view: OpsView,
    private readonly csrf: CsrfProtection,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @RawResponse()
  @Header('content-type', 'text/html; charset=utf-8')
  async index(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    const runtime = this.dbos.runtimeOrNull();
    const declared = allQueues();

    if (!runtime) {
      return this.view.render(
        'queues/index',
        {
          title: 'Queues',
          csrf: this.csrf.issue(reply),
          degraded: 'The workflow engine is not connected, so depths cannot be read.',
          queues: declared.map((queue) => ({ name: queue.name, unknown: true })),
        },
        'queues',
      );
    }

    let pending: WorkflowSummary[] = [];
    let failed: WorkflowSummary[] = [];
    let degraded: string | undefined;

    try {
      [pending, failed] = await Promise.all([
        runtime.list({ queuedOnly: true, limit: 1000 }),
        runtime.list({ status: 'ERROR', limit: 200, startTime: hoursAgo(24) }),
      ]);
    } catch (error) {
      degraded = `Could not read queue depth: ${error instanceof Error ? error.message : error}`;
    }

    const byName = new Map<string, { pending: number; running: number; failed: number }>();
    for (const queue of declared) {
      byName.set(queue.name, { pending: 0, running: 0, failed: 0 });
    }
    const bucket = (name: string) => {
      let entry = byName.get(name);
      if (!entry) {
        // A queue with rows but no declaration is worth showing, not hiding: it
        // means a deploy removed a queue that still has work on it.
        entry = { pending: 0, running: 0, failed: 0 };
        byName.set(name, entry);
      }
      return entry;
    };

    for (const workflow of pending) {
      const entry = bucket(workflow.queueName ?? 'none');
      if (workflow.status.toUpperCase() === 'PENDING') entry.running++;
      else entry.pending++;
    }
    for (const workflow of failed) bucket(workflow.queueName ?? 'none').failed++;

    const queues = [...byName.entries()].map(([name, counts]) => {
      const declaredQueue = declared.find((q) => q.name === name);
      return {
        name,
        ...counts,
        orphaned: !declaredQueue,
        workerConcurrency: declaredQueue?.workerConcurrency,
        globalConcurrency: declaredQueue?.concurrency,
        rateLimit: declaredQueue?.rateLimit
          ? `${declaredQueue.rateLimit.limitPerPeriod}/${declaredQueue.rateLimit.periodSec}s`
          : null,
      };
    });

    return this.view.render(
      'queues/index',
      {
        title: 'Queues',
        degraded,
        csrf: this.csrf.issue(reply),
        queues: queues.sort((a, b) => b.failed - a.failed || b.pending - a.pending),
        groups: this.byGroup(pending, failed),
        failed: failed.slice(0, 50),
        totalPending: pending.length,
        totalFailed: failed.length,
      },
      'queues',
    );
  }

  /** A group's health is the worst status inside it. */
  private byGroup(pending: WorkflowSummary[], failed: WorkflowSummary[]) {
    const groups = new Map<string, { group: string; pending: number; failed: number }>();
    const touch = (name: string) => {
      const existing = groups.get(name);
      if (existing) return existing;
      const created = { group: name, pending: 0, failed: 0 };
      groups.set(name, created);
      return created;
    };

    for (const entry of OpsMeta.all()) touch(entry.group);
    for (const workflow of pending) touch(workflow.group ?? 'ungrouped').pending++;
    for (const workflow of failed) touch(workflow.group ?? 'ungrouped').failed++;

    return [...groups.values()]
      .filter((g) => g.pending > 0 || g.failed > 0)
      .sort((a, b) => b.failed - a.failed || b.pending - a.pending);
  }

  @Post('workflows/:id/retry')
  async retry(@Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    const runtime = this.dbos.runtimeOrNull();
    if (!runtime) throw new NotFoundException('workflow engine');
    // Resume, not re-enqueue: completed steps keep their results, so a retry
    // cannot repeat an effect that already happened.
    await runtime.resume(id);
    this.back(reply);
  }

  @Post('workflows/:id/cancel')
  async cancel(@Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    const runtime = this.dbos.runtimeOrNull();
    if (!runtime) throw new NotFoundException('workflow engine');
    await runtime.cancel(id);
    this.back(reply);
  }

  private back(reply: FastifyReply): void {
    void reply
      .status(303)
      .header('location', `${this.config.get('OPS_PATH')}/queues`)
      .send();
  }
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}
