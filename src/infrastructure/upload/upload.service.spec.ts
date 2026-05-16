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
});
