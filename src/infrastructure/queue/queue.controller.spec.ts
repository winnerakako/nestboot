import { NotFoundException } from '@nestjs/common';
import type { QueueService } from './queue.service';
import { QueueController } from './queue.controller';

describe('QueueController', () => {
  it('uses start as the base for failed-job pagination when end is omitted', async () => {
    const queueService = {
      getFailedJobs: jest.fn().mockResolvedValue([]),
    };
    const controller = new QueueController(
      queueService as unknown as QueueService,
    );

    await controller.getFailedJobs('email', '50');

    expect(queueService.getFailedJobs).toHaveBeenCalledWith('email', 50, 69);
  });

  it('throws when retrying a missing job', async () => {
    const queueService = {
      retryJob: jest.fn().mockResolvedValue(false),
    };
    const controller = new QueueController(
      queueService as unknown as QueueService,
    );

    await expect(controller.retryJob('email', 'job-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws when pausing an unregistered queue', async () => {
    const queueService = {
      pauseQueue: jest.fn().mockResolvedValue(false),
    };
    const controller = new QueueController(
      queueService as unknown as QueueService,
    );

    await expect(controller.pauseQueue('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
