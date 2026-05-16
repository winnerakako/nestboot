import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { EmailWorker } from './email.worker';
import { EmailController } from './email.controller';
import { SmtpProvider } from './providers/smtp.provider';

@Module({
  controllers: [EmailController],
  providers: [SmtpProvider, EmailService, EmailWorker],
  exports: [EmailService],
})
export class EmailModule {}
