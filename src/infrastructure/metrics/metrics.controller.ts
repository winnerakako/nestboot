import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/decorators';
import { SkipThrottle } from '../../common/guards';
import { MetricsService } from './metrics.service';

@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Expose collected metrics in Prometheus text format.
   * Public endpoint (no auth) so infrastructure scrapers can access it.
   * Excluded from rate limiting and Swagger.
   */
  @Public()
  @SkipThrottle()
  @Get()
  @Header('Content-Type', 'text/plain; charset=utf-8')
  getMetrics(): string {
    return this.metrics.render();
  }
}
