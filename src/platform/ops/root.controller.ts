import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ConfigService } from '../config/index.js';
import { OpsGuard } from './ops.guard.js';

@UseGuards(OpsGuard)
@Controller()
export class OpsRootController {
  constructor(private readonly config: ConfigService) {}

  /**
   * Workflows is the landing tab: "what is the app doing right now" is the
   * question that brought the operator here.
   */
  @Get()
  index(@Res() reply: FastifyReply): void {
    void reply
      .status(302)
      .header('location', `${this.config.get('OPS_PATH')}/workflows`)
      .send();
  }
}
