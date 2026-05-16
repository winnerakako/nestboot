import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { BaseWorker } from '../queue/base.worker';
import { QueueService } from '../queue/queue.service';
import { AppLoggerService } from '../logging/services/app-logger.service';
import { EventService } from '../events/event.service';
import { EmailService } from './email.service';

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
  private async handleSend(job: Job<{ providerOptions: any }>) {
    const options = job.data.providerOptions;

    // Restore Buffer attachments from base64
    if (options.attachments) {
      options.attachments = await this.emailService.restoreQueuedAttachments(
        options.attachments,
      );
    }

    await this.emailService.executeEmail(options);
  }

  /**
   * Handle template-based emails (from sendBulk()).
   * Renders template in the worker to avoid memory buildup in the caller.
   */
  private async handleSendTemplate(
    job: Job<{
      to: string;
      subject: string;
      template: string;
      context?: Record<string, any>;
      layout?: string | null;
      from?: string;
      attachments?: any[];
      attachmentCacheKey?: string;
    }>,
  ) {
    await this.emailService.sendNow({
      to: job.data.to,
      subject: job.data.subject,
      template: job.data.template,
      context: job.data.context,
      layout: job.data.layout,
      from: job.data.from,
      attachments: await this.emailService.restoreQueuedAttachments(
        job.data.attachments,
        job.data.attachmentCacheKey,
      ),
    });
  }
}
