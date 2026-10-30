import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { markTimelineStep } from '../common/order-state';

/**
 * 订单自动完成 Cron（IKRSJ3 #115 道哥 2026-10-30 定稿）：
 * delivered（已送达待确认）超 48 小时用户未确认 → 自动 completed「超时自动确认」。
 *
 * 设计要点：
 * - 照抄 auto-outbound.service 模式（Cron 扫描 + 条件更新）；
 * - 送达时间取 timeline 末节点 time（delivered 态末节点即送达节点，与履约
 *   deliveredAt 口径一致）；无送达时间的脏数据跳过不误伤；
 * - 10 分钟扫描精度（48h 粒度足够）；每轮限量 50 单，积压时旧单先消化；
 * - 条件更新（where status=delivered）与用户确认收货/售后并发互斥，
 *   抢不到即放弃；单单失败不阻断本轮。
 */
@Injectable()
export class AutoCompleteService {
  private readonly logger = new Logger(AutoCompleteService.name);
  private static readonly AUTOCOMPLETE_HOURS = 48;
  private static readonly BATCH_LIMIT = 50;

  constructor(private readonly db: PrismaService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async autoCompleteDeliveredOrders() {
    const due = new Date(
      Date.now() - AutoCompleteService.AUTOCOMPLETE_HOURS * 3600 * 1000,
    );
    const orders = await this.db.order.findMany({
      where: { status: 'delivered' },
      select: { id: true, timeline: true },
      take: AutoCompleteService.BATCH_LIMIT,
      orderBy: { paidAt: 'asc' }, // Order 无 updatedAt；送达与支付正相关，旧单先消化
    });
    if (!orders.length) return;

    let total = 0;
    for (const order of orders) {
      const deliveredAt = deliveredTimeOf(order.timeline);
      if (!deliveredAt || deliveredAt > due) continue;
      try {
        const won = await this.db.order.updateMany({
          where: { id: order.id, status: 'delivered' },
          data: {
            status: 'completed',
            statusText: '超时自动确认',
            timeline: markTimelineStep(order.timeline, 'completed'),
          },
        });
        if (won.count) total++;
      } catch (e) {
        this.logger.warn(
          `auto-complete order=${order.id} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    if (total)
      this.logger.log(
        `auto-complete: ${total} delivered orders auto-completed (48h)`,
      );
  }
}

/** 送达时间：timeline 末个带 time 的节点（delivered 态即送达节点）。 */
function deliveredTimeOf(timeline: unknown): Date | null {
  const steps = Array.isArray(timeline)
    ? (timeline as Array<{ time?: string }>)
    : [];
  const time = steps.filter((s) => s?.time).at(-1)?.time;
  const d = time ? new Date(time) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}
