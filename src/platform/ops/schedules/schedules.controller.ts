import { Controller, Get, Header, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ConfigService } from '../../config/index.js';
import { DbosService } from '../../dbos/dbos.service.js';
import { declaredSchedules } from '../../dbos/define.js';
import type { ScheduleSummary } from '../../dbos/runtime.js';
import { RawResponse } from '../../http/envelope.interceptor.js';
import { NotFoundException } from '../../http/platform.exception.js';
import { CsrfProtection } from '../../security/csrf.js';
import { OpsGuard } from '../ops.guard.js';
import { OpsView } from '../view/ops-view.service.js';

/**
 * Schedules: one list, grouped, with the controls an operator actually needs at
 * 3am — pause it, run it now, see when it last fired.
 *
 * Code-declared schedules and any created by hand are the same rows in the same
 * table, because the alternative — a static set nobody can pause plus a dynamic
 * set nobody reviews — is how a cron stops running and no one notices for a
 * week. Group and description come from the workflow's `@OpsMeta`.
 */
@UseGuards(OpsGuard)
@Controller('schedules')
export class OpsSchedulesController {
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
    if (!runtime) {
      return this.view.render(
        'schedules/index',
        {
          title: 'Schedules',
          csrf: this.csrf.issue(reply),
          degraded: 'The workflow engine is not connected, so schedules cannot be listed.',
          groups: [],
        },
        'schedules',
      );
    }

    let schedules: ScheduleSummary[] = [];
    let degraded: string | undefined;
    try {
      schedules = await runtime.schedules();
    } catch (error) {
      degraded = `Could not read schedules: ${error instanceof Error ? error.message : error}`;
    }

    // A schedule this build declares but the database has no row for means the
    // boot-time reconcile has not run (or failed) — worth saying out loud,
    // because the schedule looks fine in the code and is not running.
    const known = new Set(schedules.map((s) => s.name));
    const missing = declaredSchedules()
      .filter((s) => !known.has(s.name))
      .map((s) => s.name);

    return this.view.render(
      'schedules/index',
      {
        title: 'Schedules',
        csrf: this.csrf.issue(reply),
        degraded:
          degraded ??
          (missing.length > 0
            ? `Declared in code but not registered: ${missing.join(', ')}. ` +
              'A worker has not completed its schedule reconcile.'
            : undefined),
        groups: this.group(schedules),
        total: schedules.length,
      },
      'schedules',
    );
  }

  @Post(':name/pause')
  async pause(@Param('name') name: string, @Res() reply: FastifyReply): Promise<void> {
    await this.runtime().pauseSchedule(name);
    this.back(reply);
  }

  @Post(':name/resume')
  async resume(@Param('name') name: string, @Res() reply: FastifyReply): Promise<void> {
    await this.runtime().resumeSchedule(name);
    this.back(reply);
  }

  @Post(':name/run')
  async runNow(@Param('name') name: string, @Res() reply: FastifyReply): Promise<void> {
    // The out-of-band run appears in Workflows like any other, so "I ran it
    // manually at 02:14" is a fact in the same list rather than a memory.
    const workflowId = await this.runtime().runScheduleNow(name);
    void reply
      .status(303)
      .header('location', `${this.config.get('OPS_PATH')}/workflows/${workflowId}`)
      .send();
  }

  private runtime() {
    const runtime = this.dbos.runtimeOrNull();
    if (!runtime) throw new NotFoundException('workflow engine');
    return runtime;
  }

  private back(reply: FastifyReply): void {
    void reply
      .status(303)
      .header('location', `${this.config.get('OPS_PATH')}/schedules`)
      .send();
  }

  /**
   * Grouped and collapsed, with the group's worst member setting its health —
   * so "payments · 6 schedules · 1 failing" is legible before expanding.
   */
  private group(schedules: ScheduleSummary[]) {
    const groups = new Map<string, ScheduleSummary[]>();
    for (const schedule of schedules) {
      const key = schedule.group ?? 'ungrouped';
      const list = groups.get(key);
      if (list) list.push(schedule);
      else groups.set(key, [schedule]);
    }

    const staleAfterMs = 26 * 3_600_000;
    return [...groups.entries()]
      .map(([group, items]) => {
        const paused = items.filter((s) => s.status.toUpperCase() === 'PAUSED').length;
        const stale = items.filter(
          (s) => s.lastFiredAt !== null && Date.now() - s.lastFiredAt.getTime() > staleAfterMs,
        );
        const lastRun = items
          .map((s) => s.lastFiredAt)
          .filter((d): d is Date => d !== null)
          .sort((a, b) => b.getTime() - a.getTime())[0];

        return {
          group,
          schedules: items.sort((a, b) => a.name.localeCompare(b.name)),
          count: items.length,
          paused,
          stale: stale.length,
          lastRun,
          health: stale.length > 0 ? 'bad' : paused === items.length ? 'muted' : 'good',
        };
      })
      .sort((a, b) => b.stale - a.stale || a.group.localeCompare(b.group));
  }
}
