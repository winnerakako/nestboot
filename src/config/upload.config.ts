import { registerAs } from '@nestjs/config';

export default registerAs('upload', () => ({
  driver: (process.env.UPLOAD_DRIVER || 'local') as 'local' | 's3',
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760', 10), // 10MB
  allowedMimeTypes: (
    process.env.ALLOWED_MIME_TYPES ||
    'image/jpeg,image/png,image/gif,image/webp,application/pdf'
  ).split(','),
  localDestination: process.env.UPLOAD_LOCAL_DEST || './uploads',
  publicPath: process.env.UPLOAD_PUBLIC_PATH || '/uploads',
  presignedUrlExpiry: parseInt(process.env.PRESIGNED_URL_EXPIRY || '3600', 10), // 1 hour
  s3: {
    region: process.env.AWS_REGION || 'us-east-1',
    bucket: process.env.AWS_S3_BUCKET || '',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
}));
