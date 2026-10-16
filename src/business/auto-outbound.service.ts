import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from './business.service';

/**
 * 订单自动出库 Cron（IKM55A 道哥 2026-10-16 定稿）：
 * 校区开启 autoOutboundEnabled 后，paid 单在 paidAt + N 秒（默认 60，
 * 10~600 可配）自动出库——含预约达（B 方案）；picking 单人工已介入不抢跑。
 *
 * 设计要点：
 * - 照抄 order-timeout.service 模式（Cron 扫描 + 复用条件更新逻辑）；
 * - 30 秒扫描精度 → 实际出库落在 N~N+30s；
 * - 复用 BusinessService.outbound：条件更新与人工出库/改状态互斥，抢不到
 *   即放弃（并发安全）；退款单状态已离开 paid 天然跳过；
 * - 每轮每校区限量 20 单防雪崩（积压时逐轮消化）；
 * - 单单失败不阻断本轮（pick 抢单竞争属正常，静默跳过）。
 */
@Injectable()
export class AutoOutboundService {
  private readonly logger = new Logger(AutoOutboundService.name);
  /** 单轮单校区出库上限（IKM55A）：大量积压时分轮消化，通知不瞬间洪峰 */
  private static readonly BATCH_LIMIT = 20;

  constructor(
    private readonly db: PrismaService,
    private readonly business: BusinessService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async autoOutboundPaidOrders() {
    // 开启自动出库的在营校区（每校区独立延迟配置）
    const campuses = await this.db.campus.findMany({
      where: {
        status: 'active',
        autoOutboundEnabled: true,
      },
      select: { id: true, autoOutboundDelaySeconds: true },
    });
    if (!campuses.length) return;

    let total = 0;
    for (const campus of campuses) {
      const due = new Date(
        Date.now() - (campus.autoOutboundDelaySeconds ?? 60) * 1000,
      );
      const orders = await this.db.order.findMany({
        where: {
          campusId: campus.id,
          status: 'paid',
          paidAt: { lte: due },
        },
        select: { id: true },
        take: AutoOutboundService.BATCH_LIMIT,
        orderBy: { paidAt: 'asc' }, // 先支付先出库
      });
      for (const order of orders) {
        try {
          await this.business.outbound(order.id, '系统自动出库');
          total++;
        } catch {
          // 状态已变（人工先出库/改状态/取消）→ 条件更新落空，属正常竞争
        }
      }
    }
    if (total)
      this.logger.log(`订单自动出库：本次出库 ${total} 单 paid`);
  }
}
