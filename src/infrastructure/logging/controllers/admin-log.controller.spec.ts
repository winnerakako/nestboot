import { BadRequestException } from '@nestjs/common';
import type { CronService } from '../../cron/cron.service';
import type { LogConnectionService } from '../services/log-connection.service';
import { AdminLogController } from './admin-log.controller';

describe('AdminLogController', () => {
  const controller = () =>
    new AdminLogController(
      { isConnected: true } as unknown as LogConnectionService,
      {} as unknown as CronService,
    );

  it('rejects invalid request log numeric filters before querying Mongo', async () => {
    await expect(
      controller().getRequestLogs('1', '50', undefined, 'not-a-status'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid date filters before querying Mongo', async () => {
    await expect(
      controller().getAppLogs(
        '1',
        '50',
        undefined,
        undefined,
        undefined,
        'not-a-date',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-boolean cron category updates', async () => {
    await expect(
      controller().updateCronCategory('payments', { isEnabled: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects empty cron updates', async () => {
    await expect(controller().updateCron('sync-payments', {})).rejects.toThrow(
      'At least one of isEnabled or description is required',
    );
  });
});
