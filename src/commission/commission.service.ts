import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

/** 兜底提成：无命中规则时的固定单价（单位:分/单，IK8W5K）。fulfillment.service 从此处引用。 */
export const COMMISSION_PER_ORDER = 300;

type JsonMap = Record<string, any>;
/** PrismaService 与事务客户端共用形态（都带各 model delegate）。 */
type DbClient = Pick<PrismaService, 'commissionRule' | 'commission' | 'staff'>;

/** 提成规则的匹配维度（来自订单地址/商品重量/配送模式）。 */
export interface CommissionDims {
  buildingId: string | null;
  buildingName: string | null;
  floor: number | null;
  weight: number | null;
  mode: string | null;
}

/** 从订单行提取匹配维度。 */
export function dimsOfOrder(order: JsonMap): CommissionDims {
  const address = (order.address ?? {}) as JsonMap;
  const items = (order.items ?? []) as JsonMap[];
  const weight = items.reduce(
    (sum: number, x: JsonMap) =>
      sum + Number(x.product?.weight ?? x.weight ?? 0) * Number(x.quantity ?? 1),
    0,
  );
  return {
    buildingId: address.buildingId ? String(address.buildingId) : null,
    buildingName: address.buildingName ? String(address.buildingName) : null,
    floor: address.floor == null ? null : Number(address.floor),
    weight: items.length ? Number(weight.toFixed(3)) : null,
    mode: order.deliveryMode ? String(order.deliveryMode) : null,
  };
}

/** 规则择优时的最小形态（seed 回填与 DB 记录共用）。 */
export interface RuleLike {
  buildingId: string | null;
  floor: number | null;
  weightFrom: Prisma.Decimal | number | null;
  weightTo: Prisma.Decimal | number | null;
  mode: string | null;
  price: number; // 金额单位:分（IK8W5K，schema 已转 Int）
  version: number;
}

/** 规则是否命中订单维度；返回命中的维度数（specificity，越多越优先）。 */
export function ruleSpecificity(rule: RuleLike, dims: CommissionDims): number {
  if (
    (rule.buildingId != null &&
      rule.buildingId !== dims.buildingId &&
      rule.buildingId !== dims.buildingName) ||
    (rule.floor != null && rule.floor !== dims.floor) ||
    (rule.weightFrom != null &&
      (dims.weight == null || dims.weight < Number(rule.weightFrom))) ||
    (rule.weightTo != null &&
      (dims.weight == null || dims.weight > Number(rule.weightTo))) ||
    (rule.mode != null && rule.mode !== dims.mode)
  )
    return -1;
  return [
    rule.buildingId != null,
    rule.floor != null,
    rule.weightFrom != null || rule.weightTo != null,
    rule.mode != null,
  ].filter(Boolean).length;
}

/** 四维规则择优：命中维度多者优先，其次版本号新者优先（seed 回填复用同一口径）。 */
export function bestMatch<T extends RuleLike>(
  rules: T[],
  dims: CommissionDims,
): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const rule of rules) {
    const score = ruleSpecificity(rule, dims);
    if (score < 0) continue;
    if (score > bestScore || (score === bestScore && best && rule.version > best.version)) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

/**
 * 提成/结算服务（IK8W5L）：
 * - 规则四维组合（楼栋/楼层/重量档/模式）匹配，订单 delivered 时按快照生成 Commission；
 * - 无匹配规则时按 COMMISSION_PER_ORDER 兜底并标 fallback；
 * - 已结算（paid BmBill 覆盖）的订单退款 → 记负向 Commission(status=adjusted) 挂当前月；
 * - 月度账单 BmBill：底薪 + 提成合计 + 调整 = 应发，pending-review → confirmed → paid。
 */
@Injectable()
export class CommissionService {
  constructor(private readonly db: PrismaService) {}

  /** 当前校园生效规则（版本倒序，bestMatch 内部再做维度择优）。 */
  async loadRules(
    client: DbClient,
    campusId: string,
  ): Promise<
    Array<{
      id: string;
      buildingId: string | null;
      floor: number | null;
      weightFrom: Prisma.Decimal | null;
      weightTo: Prisma.Decimal | null;
      mode: string | null;
      price: number; // 金额单位:分
      version: number;
    }>
  > {
    return client.commissionRule.findMany({
      where: { campusId, status: 'active', effectiveAt: { lte: new Date() } },
      orderBy: { version: 'desc' },
    });
  }

  /** 订单的提成单价（快照口径：命中规则价 / 兜底常量）。 */
  async priceFor(order: JsonMap) {
    const rules = await this.loadRules(this.db, String(order.campusId));
    const dims = dimsOfOrder(order);
    const rule = bestMatch(rules, dims);
    return {
      amount: rule ? rule.price : COMMISSION_PER_ORDER,
      ruleId: rule?.id ?? null,
      ruleVersion: rule?.version ?? null,
      fallback: !rule,
    };
  }

  /**
   * delivered 钩子（在履约事务内调用）：为一/二级配送人生成快照提成。
   * 归属：骑手 = order.riderId；楼长 = 订单楼栋绑定的在职楼长。
   * 幂等：@@unique(orderId, staffId)，upsert 不重复生成。
   */
  async recordForDelivered(
    tx: Prisma.TransactionClient,
    order: JsonMap,
  ): Promise<number> {
    const dims = dimsOfOrder(order);
    const rules = await this.loadRules(tx, String(order.campusId));
    const rule = bestMatch(rules, dims);
    const amount = rule ? rule.price : COMMISSION_PER_ORDER;
    const period = new Date().toISOString().slice(0, 7);
    // 楼长归属：优先 buildingId 关联，历史地址回退楼栋名。
    const manager =
      dims.buildingId || dims.buildingName
        ? await tx.staff.findFirst({
            where: {
              campusId: String(order.campusId),
              role: 'building-manager',
              status: { not: 'deleted' },
              ...(dims.buildingId
                ? { OR: [{ buildingId: dims.buildingId }, { building: dims.buildingName ?? '' }] }
                : { building: dims.buildingName ?? '' }),
            },
          })
        : null;
    const targets = [...new Set([order.riderId, manager?.id].filter(Boolean))] as string[];
    for (const staffId of targets) {
      await tx.commission.upsert({
        where: {
          orderId_staffId_kind: {
            orderId: String(order.id),
            staffId,
            kind: 'commission',
          },
        },
        create: {
          staffId,
          orderId: String(order.id),
          campusId: String(order.campusId),
          ruleId: rule?.id ?? null,
          ruleVersion: rule?.version ?? null,
          amount,
          kind: 'commission',
          status: 'pending',
          fallback: !rule,
          period,
          remark: '订单送达提成',
        },
        update: {},
      });
    }
    return targets.length;
  }

  /**
   * 退款跨期调整（在退款事务内调用）：
   * - 已 settled（被 paid 账单覆盖）→ 记负向 Commission(status=adjusted) 挂当前月，
   *   计入下期账单（简化口径：挂当前月）；
   * - 仍 pending → 原地翻负为 adjusted，账单未出直接对冲。
   */
  async refundAdjust(
    tx: Prisma.TransactionClient,
    orderId: string,
    reason: string,
  ): Promise<void> {
    const records = await tx.commission.findMany({ where: { orderId } });
    if (!records.length) return;
    const currentPeriod = new Date().toISOString().slice(0, 7);
    for (const record of records) {
      if (record.status === 'adjusted') continue;
      if (record.status === 'settled') {
        await tx.commission.create({
          data: {
            staffId: record.staffId,
            orderId: record.orderId,
            campusId: record.campusId,
            ruleId: record.ruleId,
            ruleVersion: record.ruleVersion,
            amount: -record.amount,
            kind: 'adjustment',
            status: 'adjusted',
            fallback: record.fallback,
            period: currentPeriod,
            remark: reason,
          },
        });
      } else {
        // pending：未结算的直接翻负，对冲本月聚合。
        await tx.commission.update({
          where: { id: record.id },
          data: { amount: -record.amount, status: 'adjusted', remark: reason },
        });
      }
    }
  }

  /** 月度聚合（履约端 commissions 与 admin settlements 共用口径）。 */
  async monthly(staffId: string, period: string) {
    const records = await this.db.commission.findMany({
      where: { staffId, period },
      include: { order: { select: { orderNo: true, address: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const positive = records.filter((x) => x.amount > 0);
    const negative = records.filter((x) => x.amount < 0);
    const sum = (xs: typeof records) =>
      xs.reduce((s, x) => s + x.amount, 0);
    return { records, commissionTotal: sum(positive), adjustment: sum(negative) };
  }
}
