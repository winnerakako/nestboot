import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import express from 'express';
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

  // Global prefix
  app.setGlobalPrefix(apiPrefix);

  // Compression (gzip/deflate for responses > 1KB)
  app.use(compressionMiddleware());

  // Public local upload serving
  app.use(uploadPublicPath, express.static(path.resolve(uploadDestination)));

  // Security
  app.use(helmet());
  app.enableCors({
    origin: configService.get<string>('app.frontendUrl'),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

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
