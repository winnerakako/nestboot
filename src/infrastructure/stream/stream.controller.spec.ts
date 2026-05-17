import { BadRequestException } from '@nestjs/common';
import { StreamController } from './stream.controller';
import type { StreamService } from './stream.service';

describe('StreamController', () => {
  it('rejects invalid replay timestamps before calling Redis', async () => {
    const service = {
      replayFromTimestamp: jest.fn(),
    };
    const controller = new StreamController(
      service as unknown as StreamService,
    );

    await expect(
      controller.replay('payments', undefined, 'not-a-date'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.replayFromTimestamp).not.toHaveBeenCalled();
  });

  it('defaults reset body when no JSON payload is sent', async () => {
    const service = {
      resetConsumerGroup: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new StreamController(
      service as unknown as StreamService,
    );

    await expect(
      controller.resetConsumerGroup('payments', 'ledger', undefined),
    ).resolves.toEqual({
      data: null,
      message: 'Consumer group ledger on payments reset to 0',
    });
    expect(service.resetConsumerGroup).toHaveBeenCalledWith(
      'payments',
      'ledger',
      '0',
    );
  });

  it('rejects trim requests without a valid body', async () => {
    const service = {
      trim: jest.fn(),
    };
    const controller = new StreamController(
      service as unknown as StreamService,
    );

    await expect(controller.trim('payments', undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.trim).not.toHaveBeenCalled();
  });
});
