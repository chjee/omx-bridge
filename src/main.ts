import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import {
  BRIDGE_CONFIG,
  DEFAULT_REQUEST_BODY_LIMIT,
  type BridgeConfig,
} from './config/bridge-config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    rawBody: true,
  });
  const configService = app.get(ConfigService);
  const bridgeConfig = app.get<BridgeConfig>(BRIDGE_CONFIG);
  app.enableShutdownHooks();
  const requestBodyLimit = bridgeConfig.requestBodyLimit ?? DEFAULT_REQUEST_BODY_LIMIT;
  app.useBodyParser('json', { limit: requestBodyLimit });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = configService.get<number>('PORT', 3992);
  await app.listen(port, bridgeConfig.host);
}

void bootstrap();
