import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { existsSync } from 'node:fs';
import { AuthController } from './auth/auth.controller';
import { AnalyticsController } from './analytics/analytics.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { UserRoleGuard } from './auth/user-role.guard';
import { HealthController } from './health/health.controller';
import { BusinessController } from './business/business.controller';
import { BusinessService } from './business/business.service';
import { PrismaService } from './database/prisma.service';
import { FulfillmentController } from './fulfillment/fulfillment.controller';
import { FulfillmentService } from './fulfillment/fulfillment.service';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { RbacService } from './admin/rbac/rbac.service';
import { AdminAuthGuard } from './admin/rbac/admin-auth.guard';
import { CommissionService } from './commission/commission.service';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { OrderTimeoutService } from './payments/order-timeout.service';
import { RefundSyncService } from './payments/refund-sync.service';
// IKM55A 订单自动出库：校区开启后 paid 单 N 秒 Cron 自动出库
import { AutoOutboundService } from './business/auto-outbound.service';
import { AutoCompleteService } from './business/auto-complete.service';
import { FilesController } from './files/files.controller';
import { NotificationsService } from './notifications/notifications.service';
import { GzhController } from './notifications/gzh.controller';
import { PrinterService } from './printer/printer.service';
// 楼栋夜宵店（IKSW1F）：三端接口 + 超时 Cron
import { NightAdminController } from './night/night-admin.controller';
import { NightRiderController } from './night/night-rider.controller';
import { NightUserController } from './night/night-user.controller';
import { NightAdminService } from './night/night-admin.service';
import { NightOrderService } from './night/night-order.service';
import { NightRiderService } from './night/night-rider.service';
import { NightUserService } from './night/night-user.service';
import { NightTimeoutService } from './night/night-timeout.service';

// 部署模式下由 API 容器托管管理后台静态站（ADMIN_DIST_DIR 指向挂载目录）；
// 本地开发不设置该变量，行为不变
const adminDistDir = process.env.ADMIN_DIST_DIR ?? '';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // 支付超时关单 Cron（IK8W5I）：每分钟扫 pending-payment 超 15 分钟的单。
    ScheduleModule.forRoot(),
    // 全局默认限流（APP_GUARD 全局生效）；敏感路由（登录类）
    // 用 @Throttle({ default: { limit: 10, ttl: 60_000 } }) 收紧，两者共存。
    // IKFQM9：120 → 1000——配合 trust proxy 修复后按真实用户 IP 计数，
    // 内部后台翻页/搜索场景 120 仍会误伤（正式官库菜单 Too Many Requests 实证）。
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }]),
    ...(adminDistDir && existsSync(adminDistDir)
      ? [
          ServeStaticModule.forRoot({
            rootPath: adminDistDir,
            // path-to-regexp v8 语法：(.*) 与裸 * 都非法（未匹配路径编译抛
            // PathError → 404 变 500），命名通配 {*path} 才合法
            exclude: ['/api/v1/{*path}'],
          }),
        ]
      : []),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    AnalyticsController,
    BusinessController,
    FulfillmentController,
    AdminController,
    PaymentsController,
    FilesController,
    // 服务号回调（IKI3ZP）：微信服务器推送事件（subscribe 绑定/取关解绑）
    GzhController,
    // 楼栋夜宵店（IKSW1F）：后台/楼长/用户三端
    NightAdminController,
    NightRiderController,
    NightUserController,
  ],
  providers: [
    PrismaService,
    BusinessService,
    FulfillmentService,
    AdminService,
    CommissionService,
    PaymentsService,
    OrderTimeoutService,
    RefundSyncService,
    // IKM55A 订单自动出库（30s 精度扫描，校区开关默认关）
    AutoOutboundService,
    AutoCompleteService,
    // 消息渠道扇出（IK8W5M）：订阅消息/短信/企微，env 门控静默降级。
    NotificationsService,
    // 芯烨云小票打印（IKBT6N）：出库自动出票 + 订单补打，env 门控静默降级。
    PrinterService,
    // 夜宵店服务（IKSW1F）：NightOrderService 构造时向 PaymentsService
    // 注册回调处理器（YX/ND 前缀路由）
    NightAdminService,
    NightOrderService,
    NightRiderService,
    NightUserService,
    NightTimeoutService,
    JwtAuthGuard,
    UserRoleGuard,
    // RBAC V1：权限登记同步 + 有效权限服务 + 后台鉴权守卫
    RbacService,
    AdminAuthGuard,
    // 全局限流守卫：所有路由默认 120/分，路由级 @Throttle 可覆盖
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
