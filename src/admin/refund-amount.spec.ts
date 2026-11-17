import { approvedRefundAmount, orderArrived, refundCeiling, unshippedRefundAmount } from './refund-amount';

describe('approvedRefundAmount', () => {
  it('保留未发货整单退款申请时锁定的金额（无商品明细）', () => {
    expect(approvedRefundAmount('pre-delivery', 2210, [])).toBe(2210);
  });

  it('售后退款按审核后的商品明细汇总', () => {
    expect(
      approvedRefundAmount('after-sale', 9999, [
        { amount: 120 },
        { amount: 80.4 },
      ]),
    ).toBe(200);
  });

  it('整单售后没有商品明细时保留申请时锁定金额', () => {
    expect(approvedRefundAmount('after-sale', 1888, [])).toBe(1888);
  });

  it('拒绝静默处理未知退款来源', () => {
    expect(() => approvedRefundAmount('unknown', 100, [])).toThrow(
      '未知退款来源: unknown',
    );
  });
});

/**
 * IKRSIY #110/#91 配送费退款上限三例（道哥 2026-10-30 定稿）：
 * 到店分界 {paid,picking,waiting-first-mile}=到店前；arrived 及之后=已到店。
 * refundCeiling(实付, 配送费, 含配送费) —— 含=true 上限实付全额，false 维持现状。
 */
describe('refundCeiling 配送费退款上限（IKRSIY #110/#91）', () => {
  it('到店前且校区开关关：默认不含配送费，上限=实付−配送费（维持现状）', () => {
    // 到店前状态 + refundDeliveryFeeBeforeArrive=false → includeDeliveryFee=false
    expect(orderArrived('paid')).toBe(false);
    expect(refundCeiling(5000, 400, false)).toBe(4600);
  });

  it('已到店（arrived 及之后/售后锁定态）：配送费可退，上限=实付全额', () => {
    for (const status of [
      'arrived',
      'first-mile',
      'waiting-handover',
      'last-mile',
      'delivered',
      'completed',
      'after-sales',
    ]) {
      expect(orderArrived(status)).toBe(true);
    }
    expect(orderArrived('picking')).toBe(false);
    expect(orderArrived('waiting-first-mile')).toBe(false);
    expect(refundCeiling(5000, 400, true)).toBe(5000);
  });

  it('审核开关显式放宽/收紧：开关覆盖默认口径', () => {
    // 到店前+开关关，审核弹窗「退配送费」开=true → 上限放宽到实付全额
    expect(refundCeiling(5000, 400, true)).toBe(5000);
    // 已到店默认可退，审核开关关=false → 上限收紧回「实付−配送费」
    expect(refundCeiling(5000, 400, false)).toBe(4600);
  });
});

describe('unshippedRefundAmount 未送达整单退款锁定金额（IKUISI）', () => {
  // 生产事故订单：商品额 15.60 + 运费 1.50 − 券 5.00 = 实付 12.10
  it('券后单缺省锁定=券后商品净实收（实付−运费），不再锁商品额死锁', () => {
    const r = unshippedRefundAmount(1210, 150, undefined, true);
    expect(r.amount).toBe(1060); // 净实收 10.60（旧逻辑锁商品额 15.60 必超上限）
    expect(r.ceiling).toBe(1210); // 已到店上限=实付（含运费）
  });
  it('未到店上限=实付−运费（配送费不可退口径）', () => {
    expect(unshippedRefundAmount(1210, 150, undefined, false)).toEqual({
      amount: 1060,
      ceiling: 1060,
    });
  });
  it('显式金额按状态口径校验：超限值原样返回由 service 拦截（13.60 > 12.10）', () => {
    const r = unshippedRefundAmount(1210, 150, 1360, true);
    expect(r.amount).toBe(1360);
    expect(r.amount > r.ceiling).toBe(true);
  });
  it('显式金额在限内直接锁定（弹窗核定 12.10 含运费全退）', () => {
    const r = unshippedRefundAmount(1210, 150, 1210, true);
    expect(r.amount).toBe(1210);
    expect(r.amount <= r.ceiling).toBe(true);
  });
  it('无券单（实付=商品额+运费）缺省锁定=商品额，行为与旧逻辑一致', () => {
    // 商品 15.60 + 运费 1.50 无券 → 实付 17.10；缺省锁 15.60=商品额
    expect(unshippedRefundAmount(1710, 150, undefined, false).amount).toBe(1560);
  });
});
