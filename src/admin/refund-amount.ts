/**
 * 审核后的最终退款金额：
 * - 未发货悔单是整单退款，没有 RefundItem，必须保留申请时锁定的金额；
 * - 售后退款按审核后的商品明细重新汇总。
 */
export function approvedRefundAmount(
  source: string,
  lockedAmount: number,
  items: Array<{ amount: number }>,
) {
  if (source === 'pre-delivery') return Math.round(lockedAmount);
  if (source === 'after-sale')
    return items.length
      ? items.reduce((sum, item) => sum + Math.round(item.amount), 0)
      : Math.round(lockedAmount);
  throw new Error(`未知退款来源: ${source}`);
}

/**
 * 到店分界（IKRSIY #110/#91，2026-10-30 道哥定稿）：
 * 状态机 13 态里 {paid, picking, waiting-first-mile} 为「到店前」；
 * arrived（已到店，骑手扫码/按钮确认取货）及之后一律视为「已到店/已取货」，
 * 配送费可退。'after-sales' 是售后处理中的锁定态，只可能从
 * delivered/completed 进入（pre-delivery 悔单仅存在 paid 单），同样按已到店。
 */
export const ARRIVED_STATUSES = [
  'arrived',
  'first-mile',
  'waiting-handover',
  'last-mile',
  'delivered',
  'completed',
] as const;

export function orderArrived(status: string): boolean {
  return (
    (ARRIVED_STATUSES as readonly string[]).includes(status) ||
    status === 'after-sales'
  );
}

/**
 * 可退上限口径（IKRSIY #110/#91）：
 * - 含配送费（到店后，或到店前+校区 refundDeliveryFeeBeforeArrive 开，或
 *   审核弹窗「退配送费」开关显式开）→ 上限=实付全额 payableAmount；
 * - 不含（到店前且开关关，维持现状）→ 上限=实付−配送费。
 * 金额单位分；auditRefund / createAndApproveRefund / finishRefund /
 * 日报表「整单已退」判定共用本函数，保证同一单只有一种算法。
 */
export function refundCeiling(
  payableAmount: number,
  deliveryFee: number,
  includeDeliveryFee: boolean,
): number {
  return includeDeliveryFee
    ? Math.round(payableAmount)
    : Math.round(payableAmount) - Math.round(deliveryFee);
}
