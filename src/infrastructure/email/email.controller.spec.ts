import type { Response } from 'express';
import type { EmailService } from './email.service';
import { EmailController } from './email.controller';

describe('EmailController', () => {
  function createResponse() {
    const res = {
      type: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    return res as unknown as Response & {
      type: jest.Mock;
      send: jest.Mock;
    };
  }

  it('sends rendered previews as raw HTML', async () => {
    const emailService = {
      renderTemplate: jest.fn().mockResolvedValue('<h1>Hello</h1>'),
    };
    const controller = new EmailController(
      emailService as unknown as EmailService,
    );
    const res = createResponse();

    await controller.preview('welcome', {}, res);

    expect(emailService.renderTemplate).toHaveBeenCalledWith(
      'welcome',
      expect.objectContaining({
        appName: 'NestBoot',
        year: expect.any(Number),
      }),
      undefined,
    );
    expect(res.type).toHaveBeenCalledWith('html');
    expect(res.send).toHaveBeenCalledWith('<h1>Hello</h1>');
  });

  it('lets render errors flow to the global exception filter', async () => {
    const emailService = {
      renderTemplate: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const controller = new EmailController(
      emailService as unknown as EmailService,
    );
    const res = createResponse();

    await expect(controller.preview('missing', {}, res)).rejects.toThrow(
      'boom',
    );
    expect(res.send).not.toHaveBeenCalled();
  });
});
