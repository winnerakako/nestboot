import type { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { UploadService } from './upload.service';

describe('UploadService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createService(overrides: Record<string, unknown> = {}) {
    const values: Record<string, unknown> = {
      'upload.driver': 's3',
      'upload.localDestination': './uploads',
      'upload.maxFileSize': 1024,
      'upload.allowedMimeTypes': ['image/png'],
      'upload.presignedUrlExpiry': 3600,
      ...overrides,
    };
    const config = {
      get: jest.fn(
        (key: string, fallback?: unknown) => values[key] ?? fallback,
      ),
    };

    return new UploadService(config as unknown as ConfigService);
  }

  function pngFile(overrides: Partial<Express.Multer.File> = {}) {
    const buffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    return {
      originalname: 'image.png',
      mimetype: 'image/png',
      size: buffer.length,
      buffer,
      ...overrides,
    } as Express.Multer.File;
  }

  it('rejects empty multi-upload requests', async () => {
    await expect(createService().uploadFiles([])).rejects.toThrow(
      'At least one file is required',
    );
  });

  it('validates MIME type before creating a presigned upload URL', async () => {
    await expect(
      createService().getPresignedUploadUrl({
        filename: 'file.exe',
        contentType: 'application/octet-stream',
        size: 100,
      }),
    ).rejects.toThrow('File type not allowed');
  });

  it('validates size before creating a presigned upload URL', async () => {
    await expect(
      createService().getPresignedUploadUrl({
        filename: 'image.png',
        contentType: 'image/png',
        size: 2048,
      }),
    ).rejects.toThrow('File too large');
  });

  it('rejects uploaded content that does not match the declared MIME type', async () => {
    await expect(
      createService({ 'upload.driver': 'local' }).uploadFile(
        pngFile({
          originalname: 'evil.html',
          buffer: Buffer.from('<script>alert(1)</script>'),
          size: 25,
        }),
      ),
    ).rejects.toThrow('File content does not match declared type');
  });

  it('uses a canonical extension for presigned upload keys', async () => {
    const service = createService({
      'upload.s3.accessKeyId': 'test-access-key',
      'upload.s3.secretAccessKey': 'test-secret-key',
      'upload.s3.bucket': 'test-bucket',
      'upload.s3.region': 'us-east-1',
    });
    service.onModuleInit();

    const result = await service.getPresignedUploadUrl({
      filename: 'avatar.html',
      contentType: 'image/png',
      size: 100,
    });

    expect(result.key).toMatch(/\/[0-9a-f-]+-avatar\.png$/);
  });

  it('ignores missing local files when deleting', async () => {
    jest
      .spyOn(fs, 'unlink')
      .mockRejectedValue(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );

    await expect(
      createService({ 'upload.driver': 'local' }).deleteFile('uploads/a.png'),
    ).resolves.toBeUndefined();
  });

  it('allows generated keys with consecutive dots in the filename', async () => {
    const unlinkSpy = jest.spyOn(fs, 'unlink').mockResolvedValue(undefined);

    await expect(
      createService({ 'upload.driver': 'local' }).deleteFile(
        'uploads/uuid-my..file.png',
      ),
    ).resolves.toBeUndefined();

    expect(unlinkSpy).toHaveBeenCalled();
  });

  it('rejects local delete keys with traversal path segments', async () => {
    const unlinkSpy = jest.spyOn(fs, 'unlink').mockResolvedValue(undefined);

    await expect(
      createService({ 'upload.driver': 'local' }).deleteFile(
        'uploads/../secret.txt',
      ),
    ).rejects.toThrow('Invalid file key');

    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it('throws when local delete fails for reasons other than a missing file', async () => {
    jest
      .spyOn(fs, 'unlink')
      .mockRejectedValue(
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      );

    await expect(
      createService({ 'upload.driver': 'local' }).deleteFile('uploads/a.png'),
    ).rejects.toThrow('Failed to delete file');
  });

  it('serializes local quota checks with writes', async () => {
    const service = createService({
      'upload.driver': 'local',
      'upload.localMaxBytes': 10,
    });
    const size = 8;
    const file = pngFile({ size });
    let finishFirstWrite!: () => void;

    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const sizeSpy = jest
      .spyOn(service as any, 'getDirectorySize')
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(size);
    const writeSpy = jest
      .spyOn(service as any, 'writeFileStream')
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstWrite = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const first = service.uploadFile(file);
    await new Promise((resolve) => setImmediate(resolve));

    const second = service.uploadFile(file);
    await new Promise((resolve) => setImmediate(resolve));

    expect(sizeSpy).toHaveBeenCalledTimes(1);

    finishFirstWrite();
    const [firstResult, secondResult] = await Promise.allSettled([
      first,
      second,
    ]);

    expect(firstResult.status).toBe('fulfilled');
    expect(secondResult.status).toBe('rejected');
    if (secondResult.status === 'rejected') {
      expect((secondResult.reason as Error).message).toContain(
        'Upload storage quota exceeded',
      );
    }
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(sizeSpy).toHaveBeenCalledTimes(2);
  });
});
