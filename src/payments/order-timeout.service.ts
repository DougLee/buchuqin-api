import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BusinessService } from '../business/business.service';

/**
 * 支付超时关单 Cron（IK8W5I）：
 * 从用户侧懒执行（expirePendingOrders）升级为每分钟全量扫描，
 * 复用 BusinessService 的条件关单逻辑（与并发 pay/cancel 互斥，逐单条件更新）。
 * IKY6QE：关单前先向微信查单（回调丢失时不误关已支付的单），关单同时释放
 * 下单时锁定的库存，关单后通知微信关闭订单。
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

  /**
   * IKY6QE：库存锁定巡检（每 10 分钟）。核对「商品锁定数 == 所有持锁待支付单的
   * 商品数之和」：多锁自动退回可售（释放路径一旦漏写会把库存永久锁死），
   * 少锁只告警。正常情况下账账相符，本任务静默。
   */
  @Cron('0 */10 * * * *')
  async auditStockLocks() {
    try {
      const result = await this.business.auditStockLocks();
      if (result.repaired || result.underLocked)
        this.logger.error(
          `库存锁定巡检发现不一致：回收多锁 ${result.repaired} 项，少锁告警 ${result.underLocked} 项（核对 ${result.checked} 个商品）`,
        );
    } catch (error) {
      this.logger.warn(
        `库存锁定巡检失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
