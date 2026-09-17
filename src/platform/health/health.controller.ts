import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RawResponse } from '../http/envelope.interceptor.js';
import { HealthService } from './health.service.js';

/**
 * Two endpoints, because orchestrators ask two different questions.
 *
 * Liveness must not touch a dependency: if a database blip fails the liveness
 * probe, the orchestrator restarts every pod at once and turns a recoverable
 * incident into an outage. Readiness is the one allowed to say "not me right
 * now" — it only removes the pod from the load balancer.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @RawResponse()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get()
  @RawResponse()
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const report = await this.health.report();
    reply.status(report.ready ? 200 : 503);
    return report;
  }
}
