import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Body,
  Query,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  UseGuards,
  ParseFilePipe,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
  ApiQuery,
} from '@nestjs/swagger';
import {
  ADMIN_MONITORING_READ_ROLES,
  ADMIN_MONITORING_WRITE_ROLES,
  Roles,
} from '../../common/decorators';
import { RolesGuard } from '../../common/guards';
import { UploadService } from './upload.service';

@ApiTags('Upload')
@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  // ─── Single Upload ─────────────────────────────────────

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        folder: { type: 'string' },
      },
    },
  })
  @ApiOperation({ summary: 'Upload a single file' })
  async upload(
    @UploadedFile(new ParseFilePipe({ fileIsRequired: true }))
    file: Express.Multer.File,
    @Body('folder') folder?: string,
    @Body('subfolder') subfolder?: string,
  ) {
    return this.uploadService.uploadFile(file, { folder, subfolder });
  }

  // ─── Multi Upload ──────────────────────────────────────

  @Post('multiple')
  @UseInterceptors(FilesInterceptor('files', 10))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string', format: 'binary' } },
        folder: { type: 'string' },
      },
    },
  })
  @ApiOperation({ summary: 'Upload multiple files (max 10)' })
  async uploadMultiple(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('folder') folder?: string,
    @Body('subfolder') subfolder?: string,
  ) {
    if (!files?.length) {
      throw new BadRequestException('At least one file is required');
    }

    return this.uploadService.uploadFiles(files, { folder, subfolder });
  }

  // ─── Presigned Upload URL ──────────────────────────────

  @Post('presigned')
  @ApiOperation({ summary: 'Get a presigned URL for direct S3 upload' })
  async getPresignedUploadUrl(
    @Body()
    body: {
      filename: string;
      contentType: string;
      size: number;
      folder?: string;
      subfolder?: string;
      expiresIn?: number;
    },
  ) {
    if (!body?.filename || !body.contentType || body.size === undefined) {
      throw new BadRequestException(
        'filename, contentType, and size are required',
      );
    }
    return this.uploadService.getPresignedUploadUrl(body);
  }

  // ─── Presigned Download URL ────────────────────────────

  @Get('signed-url/*key')
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_MONITORING_READ_ROLES)
  @ApiOperation({
    summary: 'Get a presigned download URL for a private S3 file',
  })
  @ApiQuery({
    name: 'expiresIn',
    required: false,
    description: 'Expiry in seconds',
  })
  async getSignedUrl(
    @Param('key') key: string | string[],
    @Query('expiresIn') expiresIn?: string,
  ) {
    const expiry = expiresIn ? parseInt(expiresIn, 10) : undefined;
    const url = await this.uploadService.getPresignedDownloadUrl(
      this.normalizeWildcardParam(key),
      expiry,
    );
    return { url };
  }

  // ─── Delete ────────────────────────────────────────────

  @Delete('*key')
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_MONITORING_WRITE_ROLES)
  @ApiOperation({ summary: 'Delete an uploaded file' })
  async delete(@Param('key') key: string | string[]) {
    await this.uploadService.deleteFile(this.normalizeWildcardParam(key));
    return { data: null, message: 'File deleted' };
  }

  private normalizeWildcardParam(value: string | string[]): string {
    return Array.isArray(value) ? value.join('/') : value;
  }
}
