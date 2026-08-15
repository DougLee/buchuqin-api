import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'node:fs';
import { AuthController } from './auth/auth.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { BusinessController } from './business/business.controller';
import { BusinessService } from './business/business.service';
import { PrismaService } from './database/prisma.service';
import { FulfillmentController } from './fulfillment/fulfillment.controller';
import { FulfillmentService } from './fulfillment/fulfillment.service';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { FilesController } from './files/files.controller';

// 部署模式下由 API 容器托管管理后台静态站（ADMIN_DIST_DIR 指向挂载目录）；
// 本地开发不设置该变量，行为不变
const adminDistDir = process.env.ADMIN_DIST_DIR ?? '';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ...(adminDistDir && existsSync(adminDistDir)
      ? [
          ServeStaticModule.forRoot({
            rootPath: adminDistDir,
            exclude: ['/api/(.*)'],
          }),
        ]
      : []),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [
    AuthController,
    BusinessController,
    FulfillmentController,
    AdminController,
    FilesController,
  ],
  providers: [
    PrismaService,
    BusinessService,
    FulfillmentService,
    AdminService,
    JwtAuthGuard,
  ],
})
export class AppModule {}
