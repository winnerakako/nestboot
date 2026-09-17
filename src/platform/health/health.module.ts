import { Module } from '@nestjs/common';
import { AppDbCheck, OpsDbCheck, ScheduleFreshnessCheck, WorkflowEngineCheck } from './checks.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { HEALTH_CHECK, type HealthCheck } from './health.types.js';

/**
 * Checks are collected through one multi-provider token, so a feature adds one
 * by providing `HEALTH_CHECK` from its own module and nothing here changes.
 */
@Module({
  controllers: [HealthController],
  providers: [
    AppDbCheck,
    OpsDbCheck,
    WorkflowEngineCheck,
    ScheduleFreshnessCheck,
    {
      provide: HEALTH_CHECK,
      useFactory: (...checks: HealthCheck[]) => checks,
      inject: [AppDbCheck, OpsDbCheck, WorkflowEngineCheck, ScheduleFreshnessCheck],
    },
    HealthService,
  ],
  exports: [HealthService, HEALTH_CHECK],
})
export class HealthModule {}
