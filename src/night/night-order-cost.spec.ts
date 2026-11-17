import { nightUnitCost, nightOrderProfit } from './night-order-cost';

describe('夜单成本与校区毛利', () => {
  const order = { paidAt: new Date(), status: 'completed', items: [{ unitGrossCost: 300, quantity: 2 }], productAmount: 1000, couponDiscount: 100, commissionTxns: [{ type: 'commission', amount: 180 }, { type: 'deliveryFee', amount: 200 }] };
  it('与白天共用HQ/LOCAL/旧件价换算，未知成本不伪装0', () => {
    expect(nightUnitCost({ procurementMode: 'HQ', wholesalePrice: 250, unitsPerCase: 24 })).toBe(250);
    expect(nightUnitCost({ procurementMode: 'LOCAL', localPurchasePrice: 300 })).toBe(300);
    expect(nightUnitCost({ wholesalePrice: 6000, unitsPerCase: 24 })).toBe(250);
    expect(nightUnitCost(null)).toBeUndefined();
    expect(nightOrderProfit({ ...order, items: [{ quantity: 1 }] })).toBeNull();
  });
  it('毛利扣优惠和楼长佣金，配送费全额转楼长不算校区利润', () => {
    expect(nightOrderProfit(order)).toMatchObject({ cost: 600, netProductRevenue: 900, productGrossProfit: 300, campusGrossProfit: 120, estimated: false });
  });
  it('只认成功退款，回库退成本；不回库全退保留商品损失', () => {
    expect(nightOrderProfit({ ...order, refund: { status: 'processing', productAmount: 900, restock: true } })?.cost).toBe(600);
    const refunded = { ...order, commissionTxns: [{ type: 'commission', amount: 0 }], refund: { status: 'succeeded', productAmount: 900, restock: true } };
    expect(nightOrderProfit(refunded)?.campusGrossProfit).toBe(0);
    expect(nightOrderProfit({ ...refunded, refund: { ...refunded.refund, restock: false } })?.campusGrossProfit).toBe(-600);
  });
});
