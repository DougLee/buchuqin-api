import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BusinessService } from '../business/business.service';

/**
 * 支付超时关单 Cron（IK8W5I）：
 * 从用户侧懒执行（expirePendingOrders）升级为每分钟全量扫描，
 * 复用 BusinessService 的条件关单逻辑（与并发 pay/cancel 互斥，逐单条件更新）。
 */
@Injectable()
export class OrderTimeoutService {
  private readonly logger = new Logger(OrderTimeoutService.name);
  constructor(private readonly business: BusinessService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async closeExpiredPendingOrders() {
    const closed = await this.business.expireAllPendingOrders();
    if (closed)
      this.logger.log(`支付超时关单：本次关闭 ${closed} 单 pending-payment`);
  }
}
