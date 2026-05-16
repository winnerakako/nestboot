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

    expect(queueService.getFailedJobs).toHaveBeenCalledWith('email', 50, 70);
  });
});
