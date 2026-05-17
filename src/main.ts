import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { AppModule } from './app.module';
import { SanitizePipe } from './common/pipes';
import { compressionMiddleware } from './common/middlewares';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const port = configService.get<number>('app.port', 3000);
  const apiPrefix = configService.get<string>('app.apiPrefix', 'api');
  const appName = configService.get<string>('app.name', 'NestBoot');
  const env = configService.get<string>('app.env', 'development');
  const uploadDestination = configService.get<string>(
    'upload.localDestination',
    './uploads',
  );
  const uploadPublicPath = configService.get<string>(
    'upload.publicPath',
    '/uploads',
  );

  // Trust proxy — required for correct client IP resolution behind reverse proxies (nginx, ALB, Cloudflare).
  // Uses Express's built-in trust: 1 = trust the first proxy hop. Adjust for your infrastructure.
  // Without this, request.ip is the proxy's IP, breaking rate limiting and audit trails.
  if (env === 'production') {
    const expressApp = app.getHttpAdapter().getInstance();
    expressApp.set('trust proxy', 1);
  }

  const captureRawBody = (req: Request, _res: Response, buf: Buffer) => {
    if (buf.length > 0) {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    }
  };

  // Body size limits — prevent oversized payloads from crashing the process
  app.use(express.json({ limit: '1mb', verify: captureRawBody }));
  app.use(
    express.urlencoded({
      extended: true,
      limit: '1mb',
      verify: captureRawBody,
    }),
  );

  // Global prefix
  app.setGlobalPrefix(apiPrefix);

  // Security headers — must be before any response-sending middleware (e.g. static files)
  app.use(helmet());
  app.enableCors({
    origin: configService.get<string>('app.frontendUrl'),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86400, // Cache preflight responses for 24 hours
  });

  // Compression (gzip/deflate for responses > 1KB)
  app.use(compressionMiddleware());

  // Public local upload serving
  app.use(
    uploadPublicPath,
    express.static(path.resolve(uploadDestination), {
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        );
      },
    }),
  );

  // Validation & Sanitization
  app.useGlobalPipes(
    new SanitizePipe(),
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Swagger (non-production only)
  if (env !== 'production') {
    const config = new DocumentBuilder()
      .setTitle(appName)
      .setDescription(`${appName} API Documentation`)
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);

    logger.log(`Swagger docs available at http://localhost:${port}/docs`);
  }

  // Graceful shutdown
  app.enableShutdownHooks();

  await app.listen(port);
  logger.log(`${appName} running on http://localhost:${port} [${env}]`);
  logger.log(`API: http://localhost:${port}/${apiPrefix}`);
}

void bootstrap();
