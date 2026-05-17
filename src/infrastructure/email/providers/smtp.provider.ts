import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import {
  EmailProvider,
  EmailProviderOptions,
} from './email-provider.interface';
import { CircuitBreaker } from '../../../common/utils/circuit-breaker.util';

@Injectable()
export class SmtpProvider implements EmailProvider {
  readonly name = 'smtp';
  private transporter: nodemailer.Transporter;
  private readonly breaker = new CircuitBreaker({
    name: 'SMTP',
    failureThreshold: 5,
    resetTimeoutMs: 60000,
    successThreshold: 2,
  });

  constructor(private readonly configService: ConfigService) {
    const user = this.configService.get<string>('email.user');
    const pass = this.configService.get<string>('email.password');

    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('email.host'),
      port: this.configService.get<number>('email.port'),
      secure: this.configService.get<boolean>('email.secure'),
      ...(user && pass ? { auth: { user, pass } } : {}),
    });
  }

  async send(options: EmailProviderOptions): Promise<void> {
    await this.breaker.exec(() =>
      this.transporter.sendMail({
        from: options.from,
        to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
        cc: options.cc
          ? Array.isArray(options.cc)
            ? options.cc.join(', ')
            : options.cc
          : undefined,
        bcc: options.bcc
          ? Array.isArray(options.bcc)
            ? options.bcc.join(', ')
            : options.bcc
          : undefined,
        replyTo: options.replyTo,
        subject: options.subject,
        html: options.html,
        text: options.text,
        headers: options.headers,
        attachments: options.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
          disposition: a.disposition,
          cid: a.cid,
        })),
      }),
    );
  }
}
