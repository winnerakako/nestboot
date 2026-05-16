import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EventService } from './event.service';
import { EventErrorListener } from './event-error.listener';

@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot({
      // Enable wildcard listeners: @OnEvent('payment.*')
      wildcard: true,
      // Use '.' as namespace delimiter: 'payment.confirmed', 'loan.approved'
      delimiter: '.',
      // Max listeners per event before warning (prevent memory leaks)
      maxListeners: 20,
      // Let errors propagate so our error handler can catch them
      ignoreErrors: false,
    }),
  ],
  providers: [EventService, EventErrorListener],
  exports: [EventService],
})
export class EventsModule {}
