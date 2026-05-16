import {
  Controller,
  Post,
  Req,
  Param,
  HttpCode,
  HttpStatus,
  RawBodyRequest,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../../common/decorators';
import { WebhookService } from './webhook.service';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  /**
   * Generic webhook endpoint.
   * POST /api/v1/webhooks/:provider
   *
   * Each provider's signature is verified automatically.
   */
  @Public()
  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive webhook from external provider' })
  @ApiExcludeEndpoint()
  handleWebhook(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    return this.webhookService.handleWebhook(provider, req);
  }
}
