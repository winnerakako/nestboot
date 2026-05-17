import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ADMIN_MONITORING_READ_ROLES, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards';
import { MetricsService } from './metrics.service';

@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Expose collected metrics in Prometheus text format.
   * Requires an admin/ops JWT unless this route is protected at the network layer
   * by an environment-specific override.
   */
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_MONITORING_READ_ROLES)
  @Get()
  @Header('Content-Type', 'text/plain; charset=utf-8')
  getMetrics(): string {
    return this.metrics.render();
  }
}
