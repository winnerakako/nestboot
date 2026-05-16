import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * Global error handler for event listeners.
 *
 * With `ignoreErrors: false`, EventEmitter2 throws listener errors.
 * Node.js EventEmitter convention: if an 'error' listener is registered,
 * errors are routed there instead of being thrown.
 *
 * This class registers an 'error' listener on the emitter,
 * preventing listener errors from crashing the process
 * while still logging them.
 */
@Injectable()
export class EventErrorListener {
  private readonly logger = new Logger('EventListener');

  constructor(private readonly emitter: EventEmitter2) {
    // Node.js convention: if 'error' listener exists, errors go there
    // instead of being thrown. This prevents process crashes.
    this.emitter.on('error', (error: Error) => {
      this.logger.error(`Event listener error: ${error.message}`, error.stack);
    });
  }
}
