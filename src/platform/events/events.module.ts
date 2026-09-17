import { Global, Module } from '@nestjs/common';
import { DbosModule } from '../dbos/dbos.module.js';
import { EventBus } from './event-bus.js';

@Global()
@Module({
  imports: [DbosModule],
  providers: [EventBus],
  exports: [EventBus],
})
export class EventsModule {}
