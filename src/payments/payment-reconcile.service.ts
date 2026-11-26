import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { PaymentsService } from './payments.service';
import { BusinessService } from '../business/business.service';

/**
 * 支付对账（IKY6QE，道哥 2026-11-26）：兜住「微信已收款、但我们没收到回调」。
 * 此前白天订单唯一的补偿是前端轮询触发的查单——用户付完款就退出小程序、
 * 或回调丢失时，订单会一直停在待支付，15 分钟后被当超时关掉，钱扣了、单没了。
 *
 * 1) 待支付单（每 2 分钟）：下单满 2 分钟仍待支付 → 向微信查单，已收款即落账。
 *    正常回调秒级到达，2 分钟仍未落账才值得查；不必等到关单前才被发现。
 * 2) 已关单（每 10 分钟）：近 60 分钟内创建、已关闭且未记录支付的单 → 查单，
 *    已收款走晚到支付自动退款（关单与收款几乎同时发生、且之后的回调也丢失的
 *    极端情况）。
 *
 * 每轮限量；查单/落账失败的单不标记，下一轮天然重试（落账与退款均幂等）。
 */
@Injectable()
export class PaymentReconcileService {
  private readonly logger = new Logger(PaymentReconcileService.name);
  /** 待支付单：下单满 2 分钟起查 */
  static readonly PENDING_MIN_AGE_MS = 2 * 60_000;
  /** 已关单：只查近 60 分钟内创建的单（更早关的单若有收款，回调早已到达） */
  static readonly CANCELLED_LOOKBACK_MS = 60 * 60_000;
  static readonly BATCH = 100;

  constructor(
    private readonly db: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  private select = { id: true, userId: true, orderNo: true, campusId: true } as const;

  /** 待支付单对账：返回本轮落账单数 */
  @Cron('0 */2 * * * *')
  async reconcilePending(): Promise<number> {
    const now = Date.now();
    const orders = await this.db.order.findMany({
      where: {
        status: 'pending-payment',
        createdAt: {
          gte: new Date(now - BusinessService.PAYMENT_TIMEOUT_MS),
          lte: new Date(now - PaymentReconcileService.PENDING_MIN_AGE_MS),
        },
      },
      select: this.select,
      orderBy: { createdAt: 'asc' },
      take: PaymentReconcileService.BATCH,
    });
    let landed = 0;
    for (const order of orders) {
      try {
        if ((await this.payments.reconcilePaidOrder(order)) === 'paid') landed++;
      } catch (error) {
        this.logger.warn(
          `待支付单对账失败（下一轮重试）order=${order.orderNo}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (landed)
      this.logger.log(`支付对账：待支付单补落账 ${landed} 单（本轮核对 ${orders.length} 单）`);
    return landed;
  }

  /** 已关单对账：返回本轮发现晚到支付并转自动退款的单数 */
  @Cron('0 */10 * * * *')
  async reconcileCancelled(): Promise<number> {
    const now = Date.now();
    const orders = await this.db.order.findMany({
      where: {
        status: 'cancelled',
        paidAt: null,
        createdAt: {
          gte: new Date(now - PaymentReconcileService.CANCELLED_LOOKBACK_MS),
        },
      },
      select: this.select,
      orderBy: { createdAt: 'desc' },
      take: PaymentReconcileService.BATCH,
    });
    let late = 0;
    for (const order of orders) {
      try {
        if ((await this.payments.reconcilePaidOrder(order)) === 'paid') late++;
      } catch (error) {
        this.logger.warn(
          `已关单对账失败（下一轮重试）order=${order.orderNo}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (late)
      this.logger.warn(
        `支付对账：发现晚到支付 ${late} 单，已转自动退款（本轮核对 ${orders.length} 单）`,
      );
    return late;
  }
}
