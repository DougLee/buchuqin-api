/** 商品单位换算（IKFOPU）：零售按听/瓶卖、订货按件批发的双单位纯函数。
 *  含量=1（无件概念）时一切换算恒等，存量商品零影响。 */

/** 批发单位件数 → 零售单位数（入库方向）：5 件 × 24 = 120 听。 */
export function caseToRetailUnits(unitsPerCase: number, caseQty: number): number {
  if (!Number.isInteger(unitsPerCase) || unitsPerCase < 1)
    throw new Error('每件含量必须是 >=1 的整数');
  if (!Number.isInteger(caseQty) || caseQty < 0)
    throw new Error('件数必须是非负整数');
  return caseQty * unitsPerCase;
}

/** 零售单位数 → 批发单位件数（整件）：余数即零散零售单位，向上取整按件表达。
 *  120 听 ÷ 24 = 5 件；49 听 ÷ 24 = 3 件（2 件 + 1 零听，向上取整保证装得下）。 */
export function retailUnitsToCases(unitsPerCase: number, retailQty: number): number {
  if (!Number.isInteger(unitsPerCase) || unitsPerCase < 1)
    throw new Error('每件含量必须是 >=1 的整数');
  if (!Number.isInteger(retailQty) || retailQty < 0)
    throw new Error('零售数量必须是非负整数');
  return Math.ceil(retailQty / unitsPerCase);
}

/** 每零售单位成本（IKFOPQ 预留，整数分）：批发总价 ÷ 含量。
 *  60 元/件 = 6000 分 ÷ 24 = 250 分/听。除不尽时向下取整——
 *  毛利一律整单「金额−金额」计算，本函数仅用于展示，不做累乘基数。 */
export function perRetailUnitCostFen(caseCostFen: number, unitsPerCase: number): number {
  if (!Number.isInteger(unitsPerCase) || unitsPerCase < 1)
    throw new Error('每件含量必须是 >=1 的整数');
  if (!Number.isInteger(caseCostFen) || caseCostFen < 0)
    throw new Error('成本必须是 >=0 的整数分');
  return Math.floor(caseCostFen / unitsPerCase);
}
