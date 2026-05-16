import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  // App
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'staging', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),
  APP_NAME: Joi.string().default('NestBoot'),
  API_PREFIX: Joi.string().default('api'),
  API_VERSION: Joi.string().default('v1'),
  FRONTEND_URL: Joi.string().default('http://localhost:3001'),

  // Database
  DATABASE_URL: Joi.string().default(
    'postgresql://postgres:postgres@localhost:5432/nestboot?schema=public',
  ),

  // Auth
  JWT_SECRET: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).invalid('change-me-in-production').required(),
    otherwise: Joi.string().optional().default('change-me-in-production'),
  }),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string()
      .min(32)
      .invalid('change-me-refresh-in-production')
      .required(),
    otherwise: Joi.string()
      .optional()
      .default('change-me-refresh-in-production'),
  }),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),
  BCRYPT_ROUNDS: Joi.number().default(12),

  // Redis
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().optional().allow(''),
  REDIS_DB: Joi.number().default(0),

  // Email
  EMAIL_TRANSPORT: Joi.string().valid('smtp').default('smtp'),
  EMAIL_HOST: Joi.string().default('smtp.gmail.com'),
  EMAIL_PORT: Joi.number().default(587),
  EMAIL_SECURE: Joi.boolean().default(false),
  EMAIL_USER: Joi.string().optional().allow(''),
  EMAIL_PASSWORD: Joi.string().optional().allow(''),
  EMAIL_FROM: Joi.string().default('noreply@example.com'),
  EMAIL_FROM_NAME: Joi.string().default('NestBoot'),

  // Webhooks
  WEBHOOK_PROVIDERS: Joi.string().optional().allow(''),
  PAYSTACK_WEBHOOK_SECRET: Joi.string().optional().allow(''),

  // Upload
  UPLOAD_DRIVER: Joi.string().valid('local', 's3').default('local'),
  MAX_FILE_SIZE: Joi.number().default(10485760),
  UPLOAD_LOCAL_DEST: Joi.string().default('./uploads'),
  UPLOAD_PUBLIC_PATH: Joi.string().default('/uploads'),
  ALLOWED_MIME_TYPES: Joi.string().default(
    'image/jpeg,image/png,image/gif,image/webp,application/pdf',
  ),
  PRESIGNED_URL_EXPIRY: Joi.number().default(3600),
  AWS_REGION: Joi.string().default('us-east-1'),
  AWS_S3_BUCKET: Joi.string().optional().allow(''),
  AWS_ACCESS_KEY_ID: Joi.string().optional().allow(''),
  AWS_SECRET_ACCESS_KEY: Joi.string().optional().allow(''),

  // Logging (MongoDB — optional, module disabled if MONGO_LOG_URI is empty)
  MONGO_LOG_URI: Joi.string().optional().allow(''),
  LOG_TTL_REQUEST: Joi.number().default(48),
  LOG_TTL_REQUEST_STATS: Joi.number().default(2160),
  LOG_TTL_QUERY: Joi.number().default(48),
  LOG_TTL_QUERY_STATS: Joi.number().default(2160),
  LOG_TTL_APP: Joi.number().default(720),
  LOG_TTL_CRON: Joi.number().default(168),
  LOG_SAMPLE_RATE: Joi.number().min(0).max(1).default(1.0),
  LOG_SAMPLE_ERROR_RATE: Joi.number().min(0).max(1).default(1.0),
  LOG_SAMPLE_SLOW_RATE: Joi.number().min(0).max(1).default(1.0),
  LOG_SLOW_THRESHOLD: Joi.number().default(1000),
  LOG_QUERY_SLOW_THRESHOLD: Joi.number().default(100),
  LOG_QUERY_SAMPLE_RATE: Joi.number().min(0).max(1).default(1.0),
  LOG_FLUSH_INTERVAL: Joi.number().default(5000),
  LOG_AGGREGATION_INTERVAL: Joi.number().default(300000),
});
