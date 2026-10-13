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
    return items.reduce((sum, item) => sum + Math.round(item.amount), 0);
  throw new Error(`未知退款来源: ${source}`);
}
