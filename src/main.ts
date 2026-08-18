import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';

const envFlag = (name: string) => {
  const value = process.env[name];
  return value == null ? null : value === 'true';
};

async function bootstrap() {
  // rawBody：微信支付回调验签需要原始请求体字节。
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.setGlobalPrefix('api/v1');
  // 本地 uploads 静态目录（历史图片访问通道）：默认仅开发开启，生产需显式
  // LOCAL_UPLOADS_ENABLED=true（ADR-0003 后新图片走 COS 绝对 URL）。
  const uploadsEnabled =
    envFlag('LOCAL_UPLOADS_ENABLED') ?? process.env.NODE_ENV !== 'production';
  if (uploadsEnabled) {
    const uploadsRoot = join(process.cwd(), 'uploads');
    mkdirSync(uploadsRoot, { recursive: true });
    app.useStaticAssets(uploadsRoot, { prefix: '/api/v1/uploads' });
  }
  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Swagger /docs：默认生产关闭，显式 SWAGGER_ENABLED=true 才暴露。
  const swaggerEnabled =
    envFlag('SWAGGER_ENABLED') ?? process.env.NODE_ENV !== 'production';
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('不出寝食社 MVP API')
      .setDescription('用户小程序、履约小程序与 PC 管理后台使用的统一业务 API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  }
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
