import { approvedRefundAmount } from './refund-amount';

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

  it('拒绝静默处理未知退款来源', () => {
    expect(() => approvedRefundAmount('unknown', 100, [])).toThrow(
      '未知退款来源: unknown',
    );
  });
});
