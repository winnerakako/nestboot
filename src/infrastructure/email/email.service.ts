import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Handlebars from 'handlebars';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  EmailProvider,
  EmailProviderOptions,
  EmailAttachment,
} from './providers/email-provider.interface';
import { SmtpProvider } from './providers/smtp.provider';
import { QueueService } from '../queue/queue.service';
import { AppLoggerService } from '../logging/services/app-logger.service';
import { CacheService } from '../cache/cache.service';

// ─── Types ───────────────────────────────────────────────

export interface SendEmailOptions {
  /** Recipient(s) */
  to: string | string[];
  /** Email subject */
  subject: string;
  /** Template name (from templates/email/) */
  template?: string;
  /** Template context variables */
  context?: Record<string, any>;
  /** Raw HTML (used if no template) */
  html?: string;
  /** Plain text fallback */
  text?: string;
  /** CC recipients */
  cc?: string | string[];
  /** BCC recipients */
  bcc?: string | string[];
  /** Reply-To address */
  replyTo?: string;
  /** File attachments */
  attachments?: EmailAttachment[];
  /** Custom headers */
  headers?: Record<string, string>;
  /** Layout template to wrap the content (default: 'layout' if exists, null to disable) */
  layout?: string | null;
  /** Override sender (default: from config) */
  from?: string;
}

export interface BulkEmailOptions {
  /** Array of recipients with per-recipient context */
  recipients: {
    to: string;
    context?: Record<string, any>;
  }[];
  /** Shared email options */
  subject: string;
  template: string;
  layout?: string | null;
  from?: string;
  attachments?: EmailAttachment[];
}

const EMAIL_QUEUE = 'email';
const BULK_ATTACHMENT_TTL_SECONDS = 86400;

/**
 * Email service with queue-based async sending, provider abstraction,
 * template rendering with layouts, bulk sending, and attachments.
 *
 * Usage:
 *   // Simple (queued, async — returns immediately)
 *   await this.email.send({
 *     to: 'user@example.com',
 *     subject: 'Welcome!',
 *     template: 'welcome',
 *     context: { firstName: 'John' },
 *   });
 *
 *   // With attachments
 *   await this.email.send({
 *     to: 'user@example.com',
 *     subject: 'Your Receipt',
 *     template: 'receipt',
 *     context: { amount: 50000 },
 *     attachments: [{ filename: 'receipt.pdf', content: pdfBuffer }],
 *   });
 *
 *   // Bulk (queued individually, rate-limited)
 *   await this.email.sendBulk({
 *     subject: 'Payment Reminder',
 *     template: 'payment-reminder',
 *     recipients: users.map(u => ({ to: u.email, context: { name: u.name, amount: u.due } })),
 *   });
 *
 *   // Sync (blocks until sent — use only when you MUST wait)
 *   await this.email.sendNow({ ... });
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private provider: EmailProvider;
  private readonly templateDir: string;
  private readonly templateCache = new Map<
    string,
    Handlebars.TemplateDelegate
  >();
  private readonly defaultFrom: string;
  private hasLayout = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly smtpProvider: SmtpProvider,
    private readonly queueService: QueueService,
    private readonly appLogger: AppLoggerService,
    private readonly cacheService: CacheService,
  ) {
    const transport = this.configService.get<string>('email.transport', 'smtp');
    if (transport !== 'smtp') {
      throw new Error(
        `Unsupported email transport "${transport}". Only "smtp" is registered.`,
      );
    }

    this.provider = this.smtpProvider;
    this.templateDir = path.join(process.cwd(), 'templates', 'email');
    const fromName = this.configService.get('email.fromName', 'App');
    const fromEmail = this.configService.get(
      'email.from',
      'noreply@example.com',
    );
    this.defaultFrom = `${fromName} <${fromEmail}>`;
  }

  async onModuleInit() {
    // Register email queue with rate limiting
    this.queueService.registerQueue(EMAIL_QUEUE, {
      limiter: { max: 10, duration: 1000 }, // 10 emails/sec
      defaultJobOptions: { attempts: 3 },
    });

    // Check if a layout template exists
    try {
      await fs.access(path.join(this.templateDir, 'layout.hbs'));
      this.hasLayout = true;
      this.logger.log('Email layout template found');
    } catch {
      this.hasLayout = false;
    }

    // Register Handlebars partials from templates/email/partials/
    await this.registerPartials();

    // Validate that the template directory exists and log available templates
    await this.validateTemplates();

    this.logger.log(
      `Email service initialized (provider: ${this.provider.name})`,
    );
  }

  /**
   * Set a custom email provider (e.g., SendGrid, Resend, SES).
   * Call in your module's onModuleInit after the provider is initialized.
   */
  setProvider(provider: EmailProvider) {
    this.provider = provider;
    this.logger.log(`Email provider changed to: ${provider.name}`);
  }

  // ─── Sending (Queued) ──────────────────────────────────

  /**
   * Send an email asynchronously via queue.
   * Returns immediately — email is sent in background with retry.
   */
  async send(options: SendEmailOptions): Promise<void> {
    const rendered = await this.buildEmail(options);

    await this.queueService.addJob(EMAIL_QUEUE, 'send', {
      providerOptions: this.serializeAttachments(rendered),
    });
  }

  /**
   * Send bulk emails — each recipient gets their own queued job.
   */
  async sendBulk(options: BulkEmailOptions): Promise<void> {
    // Queue raw options — templates rendered in the worker, not here.
    // Prevents 10K HTML strings from building in memory at once.
    const attachmentCacheKey = await this.cacheBulkAttachments(options);
    const jobs = options.recipients.map((recipient) => ({
      name: 'send-template',
      data: {
        to: recipient.to,
        subject: options.subject,
        template: options.template,
        context: recipient.context,
        layout: options.layout,
        from: options.from,
        attachmentCacheKey,
      },
    }));

    await this.queueService.addBulk(EMAIL_QUEUE, jobs);

    this.logger.log(
      `Bulk email queued: ${jobs.length} recipients (${options.template})`,
    );
  }

  /**
   * Send an email synchronously — blocks until sent.
   * Use only when you MUST wait for the result (e.g., OTP, password reset).
   */
  async sendNow(options: SendEmailOptions): Promise<void> {
    const rendered = await this.buildEmail(options);
    await this.executeEmail(rendered);
  }

  /**
   * Called by the email worker to actually send.
   * Do not call directly — use send() or sendNow().
   */
  async executeEmail(options: EmailProviderOptions): Promise<void> {
    const to = Array.isArray(options.to) ? options.to.join(', ') : options.to;

    try {
      await this.provider.send(options);

      this.appLogger.info(`Email sent: ${options.subject}`, {
        context: 'EmailService',
        metadata: {
          to,
          subject: options.subject,
          provider: this.provider.name,
        },
      });
    } catch (error) {
      this.appLogger.error(`Email failed: ${options.subject}`, {
        context: 'EmailService',
        error: error as Error,
        metadata: {
          to,
          subject: options.subject,
          provider: this.provider.name,
        },
      });
      throw error;
    }
  }

  async restoreQueuedAttachments(
    attachments?: any[],
    attachmentCacheKey?: string,
  ): Promise<EmailAttachment[] | undefined> {
    const serialized = attachmentCacheKey
      ? await this.cacheService.get<any[]>(attachmentCacheKey)
      : attachments;

    if (attachmentCacheKey && !serialized) {
      throw new Error(
        `Queued email attachments expired or are unavailable: ${attachmentCacheKey}`,
      );
    }

    return serialized?.map((attachment: any) => ({
      ...attachment,
      content: attachment._isBase64
        ? Buffer.from(attachment.content as string, 'base64')
        : attachment.content,
      _isBase64: undefined,
    }));
  }

  // ─── Template Rendering ────────────────────────────────

  /**
   * Render a template with context.
   * Public so the preview endpoint and tests can use it.
   */
  async renderTemplate(
    templateName: string,
    context: Record<string, any> = {},
    layout?: string | null,
  ): Promise<string> {
    const compiled = await this.getTemplate(templateName);
    let html = compiled(context);

    // Wrap in layout if available
    const useLayout =
      layout !== null && (layout || (this.hasLayout ? 'layout' : null));
    if (useLayout) {
      const layoutTemplate = await this.getTemplate(useLayout);
      html = layoutTemplate({
        ...context,
        body: new Handlebars.SafeString(html),
      });
    }

    return html;
  }

  // ─── Internal ──────────────────────────────────────────

  private async buildEmail(
    options: SendEmailOptions,
  ): Promise<EmailProviderOptions> {
    let html = options.html;

    if (options.template) {
      html = await this.renderTemplate(
        options.template,
        {
          ...options.context,
          year: new Date().getFullYear(),
          appName: this.configService.get('app.name', 'App'),
        },
        options.layout,
      );
    }

    return {
      from: options.from || this.defaultFrom,
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      replyTo: options.replyTo,
      subject: options.subject,
      html,
      text: options.text,
      attachments: options.attachments,
      headers: options.headers,
    };
  }

  private async getTemplate(
    name: string,
  ): Promise<Handlebars.TemplateDelegate> {
    let compiled = this.templateCache.get(name);
    if (compiled) return compiled;

    const templatePath = this.resolveTemplatePath(name);

    try {
      const source = await fs.readFile(templatePath, 'utf-8');
      compiled = Handlebars.compile(source);
      this.templateCache.set(name, compiled);
      return compiled;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as NodeJS.ErrnoException).code)
          : undefined;

      if (code === 'ENOENT') {
        throw new NotFoundException(`Email template "${name}" not found`);
      }

      this.logger.error(
        `Failed to load email template "${name}": ${(error as Error).message}`,
      );
      throw new Error(`Email template "${name}" could not be loaded`);
    }
  }

  private async registerPartials() {
    const partialsDir = path.join(this.templateDir, 'partials');

    try {
      const files = await fs.readdir(partialsDir);

      for (const file of files) {
        if (!file.endsWith('.hbs')) continue;
        const name = file.replace('.hbs', '');
        const source = await fs.readFile(path.join(partialsDir, file), 'utf-8');
        Handlebars.registerPartial(name, source);
      }

      if (files.length > 0) {
        this.logger.log(`Registered ${files.length} email partials`);
      }
    } catch {
      // No partials directory — that's fine
    }
  }

  private async validateTemplates(): Promise<void> {
    try {
      const files = await fs.readdir(this.templateDir);
      const templates = files
        .filter((f) => f.endsWith('.hbs') && f !== 'layout.hbs')
        .map((f) => f.replace('.hbs', ''));

      if (templates.length === 0) {
        this.logger.warn(
          `No email templates found in ${this.templateDir}. Email sends using templates will fail.`,
        );
      } else {
        this.logger.log(`Email templates available: ${templates.join(', ')}`);
      }
    } catch {
      this.logger.warn(
        `Email template directory not found: ${this.templateDir}. Create it or email sends using templates will fail at runtime.`,
      );
    }
  }

  private async cacheBulkAttachments(
    options: BulkEmailOptions,
  ): Promise<string | undefined> {
    if (!options.attachments?.length) return undefined;

    const attachmentCacheKey = `email:bulk-attachments:${randomUUID()}`;
    const serialized = this.serializeAttachments({
      from: options.from || this.defaultFrom,
      to: options.recipients[0]?.to || '',
      subject: options.subject,
      attachments: options.attachments,
    }).attachments;

    await this.cacheService.set(
      attachmentCacheKey,
      serialized,
      BULK_ATTACHMENT_TTL_SECONDS,
    );

    return attachmentCacheKey;
  }

  private resolveTemplatePath(name: string): string {
    if (!/^[a-zA-Z0-9/_-]+$/.test(name)) {
      throw new BadRequestException(`Invalid email template name "${name}"`);
    }

    const templatePath = path.resolve(this.templateDir, `${name}.hbs`);
    const relative = path.relative(this.templateDir, templatePath);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new BadRequestException(`Invalid email template name "${name}"`);
    }

    return templatePath;
  }

  private serializeAttachments(
    options: EmailProviderOptions,
  ): EmailProviderOptions {
    if (!options.attachments) return options;

    return {
      ...options,
      attachments: options.attachments.map((attachment) => ({
        ...attachment,
        content: Buffer.isBuffer(attachment.content)
          ? attachment.content.toString('base64')
          : attachment.content,
        _isBase64: Buffer.isBuffer(attachment.content),
      })) as any,
    };
  }
}
