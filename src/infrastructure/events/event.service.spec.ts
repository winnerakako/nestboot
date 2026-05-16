import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventService } from './event.service';

type EventServiceLoggerAccess = {
  logger: { error: (...args: unknown[]) => unknown };
};

function getLogger(service: EventService) {
  return (service as unknown as EventServiceLoggerAccess).logger;
}

describe('EventService', () => {
  it('does not throw when a synchronous listener fails', () => {
    const emitter = new EventEmitter2();
    const service = new EventService(emitter);
    const loggerSpy = jest
      .spyOn(getLogger(service), 'error')
      .mockImplementation(() => undefined);

    emitter.on('webhook.paystack.charge.success', () => {
      throw new Error('listener failed');
    });

    expect(() =>
      service.emitDynamic('webhook.paystack.charge.success', {}),
    ).not.toThrow();
    expect(loggerSpy).toHaveBeenCalled();
  });

  it('does not reject when an async listener fails', async () => {
    const emitter = new EventEmitter2();
    const service = new EventService(emitter);
    jest.spyOn(getLogger(service), 'error').mockImplementation(() => undefined);

    emitter.on('webhook.received', async () => {
      throw new Error('listener failed');
    });

    await expect(
      service.emitAsync('webhook.received', {
        provider: 'paystack',
        eventType: 'charge.success',
        payload: {},
      }),
    ).resolves.toBeUndefined();
  });

  it('does not create an unhandled rejection when a fire-and-forget async listener fails', async () => {
    const emitter = new EventEmitter2();
    const service = new EventService(emitter);
    const loggerSpy = jest
      .spyOn(getLogger(service), 'error')
      .mockImplementation(() => undefined);
    const unhandledSpy = jest.fn();
    process.on('unhandledRejection', unhandledSpy);

    try {
      emitter.on('webhook.paystack.charge.success', async () => {
        throw new Error('listener failed');
      });

      service.emitDynamic('webhook.paystack.charge.success', {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(loggerSpy).toHaveBeenCalled();
      expect(unhandledSpy).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandledSpy);
    }
  });

  it('waits for remaining async listeners when one listener fails', async () => {
    const emitter = new EventEmitter2();
    const service = new EventService(emitter);
    jest.spyOn(getLogger(service), 'error').mockImplementation(() => undefined);
    let slowListenerCompleted = false;

    emitter.on('webhook.received', async () => {
      throw new Error('listener failed');
    });
    emitter.on('webhook.received', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      slowListenerCompleted = true;
    });

    await service.emitAsync('webhook.received', {
      provider: 'paystack',
      eventType: 'charge.success',
      payload: {},
    });

    expect(slowListenerCompleted).toBe(true);
  });

  it('rejects strict dynamic emits when a listener fails', async () => {
    const emitter = new EventEmitter2();
    const service = new EventService(emitter);
    jest.spyOn(getLogger(service), 'error').mockImplementation(() => undefined);

    emitter.on('webhook.paystack.charge.success', async () => {
      throw new Error('listener failed');
    });

    await expect(
      service.emitDynamicStrict('webhook.paystack.charge.success', {}),
    ).rejects.toThrow('listener failed');
  });
});
