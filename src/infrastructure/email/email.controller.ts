import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { EmailService } from './email.service';

@ApiTags('Admin / Email')
@Controller('admin/email')
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  /**
   * Preview an email template rendered with query params as context.
   * Returns raw HTML — open in browser to see how the email looks.
   *
   * Example:
   *   GET /admin/email/preview/welcome?firstName=John&appName=Credlock
   *   GET /admin/email/preview/password-reset?firstName=Jane&resetUrl=https://example.com/reset/abc
   */
  @Get('preview/:template')
  @ApiOperation({ summary: 'Preview an email template (rendered HTML)' })
  @ApiQuery({
    name: 'layout',
    required: false,
    description: 'Layout template name (null to disable)',
  })
  async preview(
    @Param('template') template: string,
    @Query() query: Record<string, any>,
    @Res() res: Response,
  ) {
    const { layout, ...context } = query;

    // Add default context values
    context.year = context.year || new Date().getFullYear();
    context.appName = context.appName || 'NestBoot';

    try {
      const html = await this.emailService.renderTemplate(
        template,
        context,
        layout === 'null' ? null : layout,
      );

      res.type('html').send(html);
    } catch (error) {
      res.status(404).json({
        success: false,
        message: (error as Error).message,
      });
    }
  }
}
