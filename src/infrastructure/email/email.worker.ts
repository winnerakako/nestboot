import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { BaseWorker } from '../queue/base.worker';
import { QueueService } from '../queue/queue.service';
import { AppLoggerService } from '../logging/services/app-logger.service';
import { EventService } from '../events/event.service';
import { EmailService } from './email.service';
import {
  EmailAttachment,
  EmailProviderOptions,
} from './providers/email-provider.interface';

type QueuedEmailAttachment = EmailAttachment & { _isBase64?: boolean };

interface SendEmailJobData {
  providerOptions: EmailProviderOptions & {
    attachments?: QueuedEmailAttachment[];
  };
}

interface SendTemplateEmailJobData {
  to: string;
  subject: string;
  template: string;
  context?: Record<string, any>;
  layout?: string | null;
  from?: string;
  attachments?: QueuedEmailAttachment[];
  attachmentCacheKey?: string;
}

@Injectable()
export class EmailWorker extends BaseWorker implements OnModuleInit {
  constructor(
    configService: ConfigService,
    appLogger: AppLoggerService,
    events: EventService,
    queueService: QueueService,
    private readonly emailService: EmailService,
  ) {
    super('email', configService, appLogger, events, queueService);
  }

  onModuleInit() {
    this.start({
      send: (job: Job) => this.handleSend(job),
      'send-template': (job: Job) => this.handleSendTemplate(job),
    });
  }

  /**
   * Handle pre-rendered emails (from send()).
   * Restores Buffer attachments from base64.
   */
  private async handleSend(job: Job) {
    const { providerOptions } = job.data as SendEmailJobData;

    // Restore Buffer attachments from base64
    const attachments = await this.emailService.restoreQueuedAttachments(
      providerOptions.attachments,
    );

    await this.emailService.executeEmail({ ...providerOptions, attachments });
  }

  /**
   * Handle template-based emails (from sendBulk()).
   * Renders template in the worker to avoid memory buildup in the caller.
   */
  private async handleSendTemplate(job: Job) {
    const data = job.data as SendTemplateEmailJobData;

    await this.emailService.sendNow({
      to: data.to,
      subject: data.subject,
      template: data.template,
      context: data.context,
      layout: data.layout,
      from: data.from,
      attachments: await this.emailService.restoreQueuedAttachments(
        data.attachments,
        data.attachmentCacheKey,
      ),
    });
  }
}
