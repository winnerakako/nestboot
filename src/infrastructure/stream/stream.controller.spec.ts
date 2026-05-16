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
});
