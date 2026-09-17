import { Global, Module } from '@nestjs/common';
import { DbosService } from './dbos.service.js';
import { WorkflowRuntime } from './runtime.js';

@Global()
@Module({
  providers: [
    DbosService,
    {
      // Injected as `WorkflowRuntime` so nothing outside platform/dbos needs to
      // know that a runtime has a lifecycle, or which backing this role got.
      provide: WorkflowRuntime,
      useFactory: (dbos: DbosService) => new WorkflowRuntime(() => dbos.backend),
      inject: [DbosService],
    },
  ],
  exports: [DbosService, WorkflowRuntime],
})
export class DbosModule {}
