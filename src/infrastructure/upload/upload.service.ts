import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream, promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/filters';
import { Readable } from 'stream';

const MAX_PRESIGNED_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // S3 maximum

// ─── Types ───────────────────────────────────────────────

export interface UploadResult {
  /** Public URL or local path */
  url: string;
  /** Storage key (use for delete, signed URL, etc.) */
  key: string;
  /** Original filename */
  originalName: string;
  /** File size in bytes */
  size: number;
  /** MIME type */
  mimetype: string;
  /** Folder/category the file was uploaded to */
  folder: string;
  /** Storage driver used */
  driver: 'local' | 's3';
}

export interface UploadOptions {
  /** Folder/category (e.g. 'avatars', 'documents', 'receipts') */
  folder?: string;
  /** Sub-folder (e.g. userId) for per-entity organization */
  subfolder?: string;
  /** Override allowed MIME types for this upload */
  allowedMimeTypes?: string[];
  /** Override max file size for this upload */
  maxFileSize?: number;
}

export interface PresignedUploadResult {
  /** Presigned URL to PUT the file to */
  uploadUrl: string;
  /** The key the file will be stored at */
  key: string;
  /** Expiry time of the presigned URL */
  expiresAt: Date;
  /** Fields to include in the upload (for POST-based presigning) */
  fields?: Record<string, string>;
}

@Injectable()
export class UploadService implements OnModuleInit {
  private readonly logger = new Logger(UploadService.name);
  private s3Client: S3Client | null = null;
  private driver: 'local' | 's3';
  private maxFileSize: number;
  private allowedMimeTypes: string[];

  constructor(private readonly configService: ConfigService) {
    this.driver = this.configService.get<'local' | 's3'>(
      'upload.driver',
      'local',
    );
    this.maxFileSize = this.configService.get<number>(
      'upload.maxFileSize',
      10485760,
    );
    this.allowedMimeTypes = this.configService.get<string[]>(
      'upload.allowedMimeTypes',
      [],
    );
  }

  onModuleInit() {
    if (this.driver === 's3') {
      const accessKeyId = this.configService.get<string>(
        'upload.s3.accessKeyId',
      );
      const secretAccessKey = this.configService.get<string>(
        'upload.s3.secretAccessKey',
      );
      const bucket = this.configService.get<string>('upload.s3.bucket');
      const region = this.configService.get<string>('upload.s3.region');

      if (!accessKeyId || !secretAccessKey || !bucket) {
        throw new Error(
          'S3 upload driver requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_S3_BUCKET',
        );
      }

      this.s3Client = new S3Client({
        region,
        credentials: { accessKeyId, secretAccessKey },
      });

      this.logger.log(
        `S3 upload configured: bucket=${bucket}, region=${region}`,
      );
    }

    this.logger.log(
      `Upload service initialized (driver: ${this.driver}, maxSize: ${Math.round(this.maxFileSize / 1024 / 1024)}MB)`,
    );
  }

  // ─── Single Upload ─────────────────────────────────────

  /**
   * Upload a single file.
   *
   * Usage:
   *   const result = await this.upload.uploadFile(file, {
   *     folder: 'avatars',
   *     subfolder: userId,
   *   });
   */
  async uploadFile(
    file: Express.Multer.File,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    this.validateFile(file, options);

    const folder = this.buildFolder(options?.folder, options?.subfolder);
    const safeName = this.sanitizeFilename(file.originalname);
    const key = `${folder}/${randomUUID()}-${safeName}`;

    if (this.driver === 's3') {
      return this.uploadToS3(file, key, folder);
    }

    return this.uploadToLocal(file, key, folder);
  }

  // ─── Multi Upload ──────────────────────────────────────

  /**
   * Upload multiple files.
   */
  async uploadFiles(
    files: Express.Multer.File[],
    options?: UploadOptions,
  ): Promise<UploadResult[]> {
    if (!files?.length) {
      throw new BusinessException('At least one file is required');
    }

    const results: UploadResult[] = [];

    for (const file of files) {
      results.push(await this.uploadFile(file, options));
    }

    return results;
  }

  // ─── Presigned Upload URL (Client → S3 Direct) ────────

  /**
   * Generate a presigned URL for direct client-to-S3 upload.
   * Your server never touches the file — the client PUTs directly to S3.
   *
   * Usage:
   *   // Backend: generate URL
   *   const { uploadUrl, key } = await this.upload.getPresignedUploadUrl({
   *     folder: 'avatars',
   *     subfolder: userId,
   *     filename: 'photo.jpg',
   *     contentType: 'image/jpeg',
   *     size: file.size,
   *   });
   *
   *   // Frontend: upload directly
   *   await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': 'image/jpeg' } });
   */
  async getPresignedUploadUrl(params: {
    filename: string;
    contentType: string;
    size: number;
    folder?: string;
    subfolder?: string;
    expiresIn?: number;
  }): Promise<PresignedUploadResult> {
    this.validatePresignedUpload(params);

    const s3 = this.ensureS3Client();
    const bucket = this.configService.get<string>('upload.s3.bucket')!;
    const folder = this.buildFolder(params.folder, params.subfolder);
    const safeName = this.sanitizeFilename(params.filename);
    const key = `${folder}/${randomUUID()}-${safeName}`;
    const expiresIn = this.resolvePresignedExpiry(params.expiresIn);

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: params.contentType,
      ContentLength: Number(params.size),
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn });

    return {
      uploadUrl,
      key,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  // ─── Presigned Download URL ────────────────────────────

  /**
   * Generate a presigned URL for downloading a private S3 file.
   */
  async getPresignedDownloadUrl(
    key: string,
    expiresIn?: number,
  ): Promise<string> {
    this.validateKey(key);

    const s3 = this.ensureS3Client();
    const bucket = this.configService.get<string>('upload.s3.bucket')!;
    const expiry = this.resolvePresignedExpiry(expiresIn);
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });

    return getSignedUrl(s3, command, { expiresIn: expiry });
  }

  // ─── Delete ────────────────────────────────────────────

  /**
   * Delete a file by key.
   */
  async deleteFile(key: string): Promise<void> {
    this.validateKey(key);

    if (this.driver === 's3') {
      return this.deleteFromS3(key);
    }

    return this.deleteFromLocal(key);
  }

  /**
   * Delete multiple files.
   */
  async deleteFiles(keys: string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.deleteFile(key);
      } catch (error) {
        this.logger.error(
          `Failed to delete ${key}: ${(error as Error).message}`,
        );
      }
    }
  }

  // ─── S3 Operations ─────────────────────────────────────

  private ensureS3Client(): S3Client {
    if (!this.s3Client) {
      throw new BusinessException(
        'S3 client not configured. Set UPLOAD_DRIVER=s3 and provide AWS credentials.',
      );
    }
    return this.s3Client;
  }

  private async uploadToS3(
    file: Express.Multer.File,
    key: string,
    folder: string,
  ): Promise<UploadResult> {
    const s3 = this.ensureS3Client();
    const bucket = this.configService.get<string>('upload.s3.bucket')!;

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }),
    );

    const region = this.configService.get<string>('upload.s3.region');
    const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;

    this.logger.log(`Uploaded to S3: ${key} (${file.size} bytes)`);

    return {
      url,
      key,
      originalName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      folder,
      driver: 's3',
    };
  }

  private async deleteFromS3(key: string): Promise<void> {
    const s3 = this.ensureS3Client();
    const bucket = this.configService.get<string>('upload.s3.bucket')!;
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    this.logger.log(`Deleted from S3: ${key}`);
  }

  // ─── Local Operations ──────────────────────────────────

  /** Max total storage for local uploads (default: 1GB). Override with UPLOAD_LOCAL_MAX_BYTES env. */
  private getLocalMaxBytes(): number {
    return this.configService.get<number>(
      'upload.localMaxBytes',
      1024 * 1024 * 1024, // 1GB default
    );
  }

  private async checkLocalDiskQuota(
    root: string,
    incomingSize: number,
  ): Promise<void> {
    const maxBytes = this.getLocalMaxBytes();
    if (maxBytes <= 0) return; // 0 or negative = unlimited

    let totalSize = 0;
    try {
      totalSize = await this.getDirectorySize(root);
    } catch {
      return; // If we can't read the dir, skip quota check
    }

    if (totalSize + incomingSize > maxBytes) {
      throw new BusinessException(
        `Upload storage quota exceeded (${Math.round(maxBytes / 1024 / 1024)}MB limit). Delete some files or switch to S3.`,
      );
    }
  }

  private async getDirectorySize(dir: string): Promise<number> {
    let total = 0;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          total += await this.getDirectorySize(fullPath);
        } else {
          const stat = await fs.stat(fullPath);
          total += stat.size;
        }
      }
    } catch {
      // Directory doesn't exist yet or permission error
    }
    return total;
  }

  private async uploadToLocal(
    file: Express.Multer.File,
    key: string,
    folder: string,
  ): Promise<UploadResult> {
    const dest = this.configService.get<string>(
      'upload.localDestination',
      './uploads',
    );
    const publicPath = this.configService.get<string>(
      'upload.publicPath',
      '/uploads',
    );
    const root = path.resolve(dest);
    const fullFolder = path.resolve(root, folder);

    if (!this.isWithinDirectory(fullFolder, root)) {
      throw new BusinessException('Invalid upload folder');
    }

    // Enforce local disk quota
    await this.checkLocalDiskQuota(root, file.size);

    await fs.mkdir(fullFolder, { recursive: true });

    const filename = key.split('/').pop()!;
    const filepath = path.resolve(fullFolder, filename);

    if (!this.isWithinDirectory(filepath, root)) {
      throw new BusinessException('Invalid upload path');
    }

    // Stream write instead of writeFileSync — no event loop blocking
    await this.writeFileStream(filepath, file.buffer);

    this.logger.log(`Uploaded locally: ${key} (${file.size} bytes)`);

    return {
      url: `${publicPath.replace(/\/$/, '')}/${key}`,
      key,
      originalName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      folder,
      driver: 'local',
    };
  }

  private async deleteFromLocal(key: string): Promise<void> {
    const dest = this.configService.get<string>(
      'upload.localDestination',
      './uploads',
    );
    const resolvedDest = path.resolve(dest);
    const filepath = path.resolve(resolvedDest, key);

    if (!this.isWithinDirectory(filepath, resolvedDest)) {
      throw new BusinessException('Invalid file key');
    }

    try {
      await fs.unlink(filepath);
      this.logger.log(`Deleted locally: ${key}`);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as NodeJS.ErrnoException).code)
          : undefined;

      if (code === 'ENOENT') {
        return;
      }

      this.logger.error(
        `Failed to delete local file ${key}: ${(error as Error).message}`,
      );
      throw new BusinessException('Failed to delete file');
    }
  }

  // ─── Helpers ───────────────────────────────────────────

  private validateFile(file: Express.Multer.File, options?: UploadOptions) {
    const maxSize = options?.maxFileSize || this.maxFileSize;
    const allowedTypes = options?.allowedMimeTypes || this.allowedMimeTypes;

    if (file.size > maxSize) {
      throw new BusinessException(
        `File too large: ${Math.round(file.size / 1024 / 1024)}MB exceeds ${Math.round(maxSize / 1024 / 1024)}MB limit`,
      );
    }

    if (allowedTypes.length > 0 && !allowedTypes.includes(file.mimetype)) {
      throw new BusinessException(
        `File type not allowed: ${file.mimetype}. Allowed: ${allowedTypes.join(', ')}`,
      );
    }
  }

  private validatePresignedUpload(params: {
    filename: string;
    contentType: string;
    size: number;
  }) {
    const allowedTypes = this.allowedMimeTypes;

    if (allowedTypes.length > 0 && !allowedTypes.includes(params.contentType)) {
      throw new BusinessException(
        `File type not allowed: ${params.contentType}. Allowed: ${allowedTypes.join(', ')}`,
      );
    }

    const size = Number(params.size);
    if (!Number.isFinite(size) || size <= 0) {
      throw new BusinessException('Invalid file size');
    }

    if (size > this.maxFileSize) {
      throw new BusinessException(
        `File too large: ${Math.round(size / 1024 / 1024)}MB exceeds ${Math.round(this.maxFileSize / 1024 / 1024)}MB limit`,
      );
    }
  }

  private resolvePresignedExpiry(expiresIn?: number): number {
    const configuredExpiry = this.configService.get<number>(
      'upload.presignedUrlExpiry',
      3600,
    );
    const expiry = Number(expiresIn ?? configuredExpiry);

    if (
      !Number.isInteger(expiry) ||
      expiry < 1 ||
      expiry > MAX_PRESIGNED_EXPIRY_SECONDS
    ) {
      throw new BusinessException(
        `Invalid expiry. Must be between 1 and ${MAX_PRESIGNED_EXPIRY_SECONDS} seconds`,
      );
    }

    return expiry;
  }

  private sanitizeFilename(filename: string): string {
    return path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private validateKey(key: string): void {
    const normalizedInput = key.replace(/\\/g, '/');
    const normalized = path.posix.normalize(normalizedInput);
    if (
      normalized === '.' ||
      path.posix.isAbsolute(normalizedInput) ||
      path.posix.isAbsolute(normalized) ||
      this.hasTraversalSegment(normalizedInput)
    ) {
      throw new BusinessException('Invalid file key');
    }
  }

  private buildFolder(folder?: string, subfolder?: string): string {
    const parts = this.safePathParts(folder || 'uploads', 'folder');
    if (subfolder) parts.push(...this.safePathParts(subfolder, 'subfolder'));
    return parts.join('/');
  }

  private safePathParts(value: string, field: string): string[] {
    const normalizedInput = value.replace(/\\/g, '/');
    const normalized = path.posix.normalize(normalizedInput);

    if (
      path.posix.isAbsolute(normalizedInput) ||
      path.posix.isAbsolute(normalized) ||
      this.hasTraversalSegment(normalizedInput)
    ) {
      throw new BusinessException(`Invalid ${field}`);
    }

    const parts = normalized.split('/').filter(Boolean);
    if (parts.length === 0) {
      throw new BusinessException(`Invalid ${field}`);
    }

    return parts.map((part) => this.sanitizeFilename(part));
  }

  private hasTraversalSegment(value: string): boolean {
    return value.split('/').some((part) => part === '..');
  }

  private isWithinDirectory(target: string, root: string): boolean {
    const relative = path.relative(root, target);
    return (
      relative === '' ||
      (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    );
  }

  private writeFileStream(filepath: string, buffer: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(filepath);
      const readable = Readable.from(buffer);
      readable.pipe(stream);
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
  }
}
