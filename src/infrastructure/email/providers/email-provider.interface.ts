/**
 * Interface for email transport providers.
 * Implement this to add a new provider (SendGrid, Resend, SES, etc.).
 *
 * Usage:
 *   @Injectable()
 *   export class SendGridProvider implements EmailProvider {
 *     async send(options: EmailProviderOptions): Promise<void> {
 *       await sgMail.send({ ... });
 *     }
 *   }
 */
export interface EmailProviderOptions {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
}

export interface EmailAttachment {
  /** Filename shown to the recipient */
  filename: string;
  /** File content as Buffer, string, or readable stream */
  content: Buffer | string;
  /** MIME type (e.g. 'application/pdf', 'text/csv') */
  contentType?: string;
  /** Content disposition: 'attachment' (default) or 'inline' */
  disposition?: 'attachment' | 'inline';
  /** Content ID for inline images (e.g. '<logo@company.com>') */
  cid?: string;
}

export interface EmailProvider {
  /** Provider name for logging */
  readonly name: string;
  /** Send an email */
  send(options: EmailProviderOptions): Promise<void>;
}
