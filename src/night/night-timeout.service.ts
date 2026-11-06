import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { NightOrderService } from './night-order.service';

/**
 * 夜宵订单超时 Cron（IKSW1F）：
 * - 待支付超时关单：timeoutAt 已过（校区可配时长，缺省 15 分钟）→ 关单
 *   释放券 + 回补库存（与用户取消/支付回调并发互斥靠 closePendingPayment
 *   内部条件更新）；
 * - 送达超时自动完成：delivered 超 24h 未确认 → completed + 佣金转 pending。
 * 每分钟扫描、每轮限量 50 单（与白天 order-timeout/auto-complete 同模式）。
 */
@Injectable()
export class NightTimeoutService {
  private readonly logger = new Logger(NightTimeoutService.name);
  private static readonly BATCH_LIMIT = 50;

  constructor(
    private readonly db: PrismaService,
    private readonly orders: NightOrderService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep() {
    try { await this.orders.reconcilePendingRefunds(NightTimeoutService.BATCH_LIMIT); }
    catch (error) { this.logger.warn(`夜宵退款核对待重试: ${error instanceof Error ? error.message : 'unknown'}`); }
    try { await this.orders.reconcilePendingDepositRefunds(NightTimeoutService.BATCH_LIMIT); }
    catch (error) { this.logger.warn(`夜宵退押核对待重试: ${error instanceof Error ? error.message : 'unknown'}`); }
    try {
      const stale = await this.db.nightOrder.findMany({
        where: { status: 'pending-payment', timeoutAt: { lt: new Date() } },
        select: { id: true },
        take: NightTimeoutService.BATCH_LIMIT,
      });
      for (const row of stale)
        await this.orders.closePendingPayment(row.id, '支付超时已关闭');
      if (stale.length)
        this.logger.log(`夜宵待支付超时关单 ${stale.length} 单`);
    } catch (error) {
      this.logger.warn(
        `夜宵超时关单扫描失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const completed = await this.orders.autoCompleteDelivered(
        NightTimeoutService.BATCH_LIMIT,
      );
      if (completed) this.logger.log(`夜宵送达超时自动完成 ${completed} 单`);
    } catch (error) {
      this.logger.warn(
        `夜宵自动完成扫描失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
