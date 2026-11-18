import { perRetailUnitCostFen } from '../common/product-units';

export function nightUnitCost(product?: { procurementMode?: string | null; localPurchasePrice?: number | null; wholesalePrice?: number; unitsPerCase?: number } | null): number | undefined {
  if (!product) return undefined;
  if (product.procurementMode === 'LOCAL') return product.localPurchasePrice ?? undefined;
  if (product.wholesalePrice === undefined) return undefined;
  return product.procurementMode === 'HQ' ? product.wholesalePrice : perRetailUnitCostFen(product.wholesalePrice, product.unitsPerCase || 1);
}

export function nightOrderProfit(order: {
  paidAt: Date | null; status: string; items: unknown; productAmount: number; couponDiscount: number;
  refund?: { status: string; productAmount: number; restock: boolean } | null;
  commissionTxns: Array<{ type: string; amount: number }>;
}) {
  const items = (Array.isArray(order.items) ? order.items : []) as Array<{ unitGrossCost?: number; quantity: number }>;
  if (!order.paidAt || !items.length || items.some(i => !Number.isSafeInteger(i.unitGrossCost) || i.unitGrossCost! < 0)) return null;
  const refund = order.refund?.status === 'succeeded' ? order.refund : null;
  const cost = refund?.restock ? 0 : items.reduce((sum, i) => sum + i.unitGrossCost! * i.quantity, 0);
  const netProductRevenue = order.productAmount - order.couponDiscount - (refund?.productAmount || 0);
  const commission = order.commissionTxns.filter(t => t.type === 'commission').reduce((sum, t) => sum + t.amount, 0);
  return { cost, netProductRevenue, productGrossProfit: netProductRevenue - cost, managerCommission: commission, campusGrossProfit: netProductRevenue - cost - commission, estimated: !['completed', 'refunded', 'cancelled'].includes(order.status) };
}
