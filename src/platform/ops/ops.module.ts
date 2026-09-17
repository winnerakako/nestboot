import { type DynamicModule, Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { ConfigModule, loadEnv } from '../config/index.js';
import { DbModule } from '../db/db.module.js';
import { DbosModule } from '../dbos/dbos.module.js';
import { ErrorsModule } from '../errors/errors.module.js';
import { HealthModule } from '../health/health.module.js';
import { LoggingModule } from '../logging/logging.module.js';
import { RequestsModule } from '../requests/requests.module.js';
import { SecurityModule } from '../security/security.module.js';
import { OpsAssetsController } from './assets.controller.js';
import { OpsAuthController } from './auth/ops-auth.controller.js';
import { OpsErrorsController } from './errors/errors.controller.js';
import { OpsHealthController } from './health/health.controller.js';
import { OpsLogsController } from './logs/logs.controller.js';
import { OpsGuard } from './ops.guard.js';
import { OpsQueuesController } from './queues/queues.controller.js';
import { OpsRequestsController } from './requests/requests.controller.js';
import { OpsRootController } from './root.controller.js';
import { OpsSchedulesController } from './schedules/schedules.controller.js';
import { OpsSecurityController } from './security/security.controller.js';
import { OpsView } from './view/ops-view.service.js';
import { OpsWorkflowsController } from './workflows/workflows.controller.js';

const CONTROLLERS = [
  OpsRootController,
  OpsAssetsController,
  OpsAuthController,
  OpsWorkflowsController,
  OpsQueuesController,
  OpsSchedulesController,
  OpsLogsController,
  OpsErrorsController,
  OpsRequestsController,
  OpsHealthController,
  OpsSecurityController,
];

/**
 * The operator console: eight tabs over the app's own Postgres.
 *
 * Mounted under `OPS_PATH` through Nest's router rather than by prefixing every
 * controller, so relocating it (or hosting it on an internal-only path) is one
 * environment variable and no code change.
 *
 * Its CSP and the rest of its response headers are set in
 * `platform/security/bootstrap.ts`, not here — helmet registers after Nest's
 * middleware and would overwrite anything a middleware set.
 */
@Module({
  // Every dependency is imported explicitly, even the ones marked @Global: a
  // global module is only available once something else has pulled it into the
  // graph, so an implicit dependency makes the console unmountable on its own
  // and produces a resolution error that names the wrong module.
  imports: [
    ConfigModule,
    DbModule,
    DbosModule,
    LoggingModule,
    ErrorsModule,
    RequestsModule,
    SecurityModule,
    HealthModule,
  ],
  controllers: CONTROLLERS,
  // Intentional: OpsGuard is applied per-controller with @UseGuards, NOT as an
  // APP_GUARD. Nest treats an APP_GUARD as global no matter which module
  // declares it, so registering it here would put the console's IP allowlist
  // and login in front of the entire application. `ops-guard.spec.ts` asserts
  // every controller in this folder carries the decorator.
  providers: [OpsView, OpsGuard],
  exports: [OpsView],
})
export class OpsInnerModule {}

@Module({})
export class OpsModule {
  static forRoot(): DynamicModule {
    // Read directly rather than injected: the route prefix has to be known
    // while the module graph is being built, which is before DI exists.
    const path = loadEnv().OPS_PATH.replace(/^\/?/, '');

    return {
      module: OpsModule,
      imports: [OpsInnerModule, RouterModule.register([{ path, module: OpsInnerModule }])],
    };
  }
}
