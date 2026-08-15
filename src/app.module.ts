import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth/auth.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { BusinessController } from './business/business.controller';
import { BusinessService } from './business/business.service';
import { PrismaService } from './database/prisma.service';
import { FulfillmentController } from './fulfillment/fulfillment.controller';
import { FulfillmentService } from './fulfillment/fulfillment.service';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
