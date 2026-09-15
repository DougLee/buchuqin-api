import {
  caseToRetailUnits,
  perRetailUnitCostFen,
  retailUnitsToCases,
} from './product-units';

/** 单位换算纯函数（IKFOPU）：订货按件表达、入库换算零售单位；
 *  perRetailUnitCostFen 为 IKFOPQ（订单行成本快照）预留。 */
describe('product units (IKFOPU)', () => {
  it('件→零售：5 件 × 24 = 120 听', () => {
    expect(caseToRetailUnits(24, 5)).toBe(120);
  });

  it('含量 1 恒等（无件概念/存量商品零影响）', () => {
    expect(caseToRetailUnits(1, 7)).toBe(7);
    expect(retailUnitsToCases(1, 7)).toBe(7);
    expect(perRetailUnitCostFen(999, 1)).toBe(999);
  });

  it('零与大量级边界', () => {
    expect(caseToRetailUnits(24, 0)).toBe(0);
    expect(retailUnitsToCases(24, 0)).toBe(0);
    expect(caseToRetailUnits(24, 9999)).toBe(239976);
  });

  it('零售→件：整除与零散向上取整', () => {
    expect(retailUnitsToCases(24, 120)).toBe(5);
    expect(retailUnitsToCases(24, 49)).toBe(3); // 2 件 + 1 零听 → 按 3 件装
    expect(retailUnitsToCases(24, 1)).toBe(1);
  });

  it('每零售单位成本：6000 分 ÷ 24 = 250 分；除不尽向下取整', () => {
    expect(perRetailUnitCostFen(6000, 24)).toBe(250);
    expect(perRetailUnitCostFen(100, 3)).toBe(33); // 不做累乘基数，仅展示
  });

  it('非法输入拒绝：含量 0/负/非整数、负数量', () => {
    for (const bad of [0, -1, 2.5]) {
      expect(() => caseToRetailUnits(bad, 1)).toThrow();
      expect(() => retailUnitsToCases(bad, 1)).toThrow();
      expect(() => perRetailUnitCostFen(1, bad)).toThrow();
    }
    expect(() => caseToRetailUnits(24, -1)).toThrow();
    expect(() => perRetailUnitCostFen(-1, 24)).toThrow();
  });
});
