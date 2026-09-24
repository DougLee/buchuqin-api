import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';
import { HQ_CAMPUS_ID, OFFICIAL_CAMPUS_ID } from '../common/campus';

export const SKU_BASIS =
  '按支付日期统计当前已完成订单；商品成交额不含配送费、不扣优惠券；毛利使用支付时整分批发成本快照。售后及退款订单不计，不是退款追溯净销售。库存为查询时点参考，不用于历史库存诊断。';
export interface SkuRow {
  id: string;
  campusId: string;
  campusName: string;
  name: string;
  barcode: string;
  categoryId: string;
  categoryName: string;
  sales: number;
  quantity: number;
  cost: number | null;
  margin: number | null;
  marginRate: number | null;
  stock: number | null;
  lockedStock: number | null;
  available: number | null;
  inventoryValue: number | null;
  contribution: number;
  cumulative: number;
  core: boolean;
  quadrant: string;
  advice: string;
  issues: string[];
}
export interface SkuProduct {
  id: string;
  campusId: string;
  name: string;
  barcode: string | null;
  categoryId: string;
  category: { name: string };
  stock: number;
  lockedStock: number;
  wholesalePrice: number;
  unitsPerCase: number;
  status: string;
}
export interface SkuOrder {
  campusId: string;
  items: unknown;
}
const validMoney = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
export function skuDates(start?: string, end?: string, now = new Date()) {
  const today = new Date(now.getTime() + 8 * 3600000)
    .toISOString()
    .slice(0, 10);
  const yesterday = new Date(
    new Date(`${today}T00:00:00+08:00`).getTime() - 86400000,
  );
  const endDate =
    end ||
    new Date(yesterday.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const startDate =
    start ||
    new Date(yesterday.getTime() + 8 * 3600000 - 29 * 86400000)
      .toISOString()
      .slice(0, 10);
  const parse = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
      throw new BadRequestException('日期格式不合法');
    const d = new Date(`${s}T00:00:00+08:00`);
    if (
      !Number.isFinite(d.getTime()) ||
      new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10) !== s
    )
      throw new BadRequestException('日期不合法');
    return d;
  };
  const from = parse(startDate),
    to = parse(endDate);
  if (
    startDate > endDate ||
    endDate >= today ||
    to.getTime() - from.getTime() >= 366 * 86400000
  )
    throw new BadRequestException('请选择截至昨日、不超过366天的日期范围');
  return {
    start: startDate,
    end: endDate,
    from,
    until: new Date(to.getTime() + 86400000),
  };
}
export function aggregateSku(
  products: SkuProduct[],
  orders: SkuOrder[],
  campuses: { id: string; name: string }[],
  categoryId = '',
  keyword = '',
) {
  const names = new Map(campuses.map((c) => [c.id, c.name]));
  const rows = new Map<string, SkuRow>();
  const onSale = new Set(
    products
      .filter((p) => p.status === 'on-sale')
      .map((p) => `${p.campusId}:${p.id}`),
  );
  const key = (campus: string, id: string) => `${campus}:${id}`;
  for (const p of products) {
    const available = p.stock - p.lockedStock;
    const costValid =
      validMoney(p.wholesalePrice) &&
      Number.isInteger(p.unitsPerCase) &&
      p.unitsPerCase > 0;
    rows.set(key(p.campusId, p.id), {
      id: p.id,
      campusId: p.campusId,
      campusName: names.get(p.campusId) || p.campusId,
      name: p.name,
      barcode: p.barcode || '',
      categoryId: p.categoryId,
      categoryName: p.category.name,
      sales: 0,
      quantity: 0,
      cost: 0,
      margin: null,
      marginRate: null,
      stock: p.stock,
      lockedStock: p.lockedStock,
      available: available >= 0 ? available : null,
      inventoryValue:
        costValid && p.stock >= 0
          ? Math.round((p.stock * p.wholesalePrice) / p.unitsPerCase)
          : null,
      contribution: 0,
      cumulative: 0,
      core: false,
      quadrant: '',
      advice: '',
      issues: available < 0 ? ['锁定数量超过库存，请核查'] : [],
    });
  }
  let invalidLines = 0;
  for (const o of orders) {
    if (!Array.isArray(o.items)) {
      invalidLines++;
      continue;
    }
    for (const raw of o.items) {
      const line = raw as {
        product?: {
          id?: string;
          name?: string;
          price?: unknown;
          unitWholesaleCost?: unknown;
        };
        quantity?: unknown;
      } | null;
      if (
        !line?.product?.id ||
        typeof line.product.id !== 'string' ||
        !validMoney(line.quantity) ||
        line.quantity === 0 ||
        !validMoney(line.product.price)
      ) {
        invalidLines++;
        continue;
      }
      const k = key(o.campusId, line.product.id);
      let r = rows.get(k);
      if (!r) {
        r = {
          id: line.product.id,
          campusId: o.campusId,
          campusName: names.get(o.campusId) || o.campusId,
          name: line.product.name || '缺失商品主档',
          barcode: '',
          categoryId: '',
          categoryName: '未分类',
          sales: 0,
          quantity: 0,
          cost: 0,
          margin: null,
          marginRate: null,
          stock: null,
          lockedStock: null,
          available: null,
          inventoryValue: null,
          contribution: 0,
          cumulative: 0,
          core: false,
          quadrant: '',
          advice: '',
          issues: ['商品主档缺失，库存不可用'],
        };
        rows.set(k, r);
      }
      r.sales += line.product.price * line.quantity;
      r.quantity += line.quantity;
      if (validMoney(line.product.unitWholesaleCost) && r.cost !== null)
        r.cost += line.product.unitWholesaleCost * line.quantity;
      else r.cost = null;
    }
  }
  const q = keyword.trim().toLocaleLowerCase();
  const result = [...rows.values()]
    .filter(
      (r) =>
        (r.quantity > 0 ||
          (r.stock ?? 0) > 0 ||
          onSale.has(key(r.campusId, r.id))) &&
        (!categoryId || r.categoryId === categoryId) &&
        (!q ||
          `${r.id} SKU-${r.id} ${r.barcode} ${r.name}`
            .toLocaleLowerCase()
            .includes(q)),
    )
    .sort(
      (a, b) =>
        b.sales - a.sales ||
        a.id.localeCompare(b.id) ||
        a.campusId.localeCompare(b.campusId),
    );
  const sales = result.reduce((n, r) => n + r.sales, 0);
  const positive = result
    .filter((r) => r.sales > 0)
    .map((r) => r.sales)
    .sort((a, b) => a - b);
  const mid = Math.floor(positive.length / 2);
  const median = positive.length
    ? positive.length % 2
      ? positive[mid]
      : (positive[mid - 1] + positive[mid]) / 2
    : null;
  let accumulated = 0;
  for (const r of result) {
    r.contribution = sales ? r.sales / sales : 0;
    r.core = r.sales > 0 && accumulated < sales * 0.8;
    accumulated += r.sales;
    r.cumulative = sales ? accumulated / sales : 0;
    if (!r.quantity) r.cost = null;
    r.margin = r.cost === null ? null : r.sales - r.cost;
    r.marginRate = r.margin !== null && r.sales > 0 ? r.margin / r.sales : null;
    if (r.quantity && r.cost === null) r.issues.push('历史批发成本快照缺失');
    r.quadrant =
      r.marginRate === null || median === null
        ? '不可分类'
        : `${r.sales >= median ? '高' : '低'}销售·${r.marginRate >= 0.3 ? '高' : '低'}毛利`;
    r.advice = r.issues.length
      ? '核验数据'
      : r.margin !== null && r.margin < 0
        ? '核查定价与成本'
        : r.marginRate !== null && r.marginRate < 0.3
          ? '关注商品毛利'
          : '持续观察';
  }
  const known = result.filter((r) => r.margin !== null);
  const knownSales = known.reduce((n, r) => n + r.sales, 0);
  const margin = known.reduce((n, r) => n + r.margin!, 0);
  return {
    rows: result,
    median,
    invalidLines,
    totals: {
      sales,
      quantity: result.reduce((n, r) => n + r.quantity, 0),
      sellingSkus: positive.length,
      knownMargin: known.length ? margin : null,
      knownMarginRate: knownSales > 0 ? margin / knownSales : null,
      costCoverage: sales > 0 ? knownSales / sales : null,
      inventoryValue: result.some((r) => r.inventoryValue !== null)
        ? result.reduce((n, r) => n + (r.inventoryValue ?? 0), 0)
        : null,
      inventoryMissing: result.filter((r) => r.inventoryValue === null).length,
    },
  };
}
export async function readSkuAnalysis(
  db: PrismaService,
  campusId: string,
  query: {
    start?: string;
    end?: string;
    categoryId?: string;
    keyword?: string;
  },
) {
  const dates = skuDates(query.start, query.end);
  return db.$transaction(
    async (tx) => {
      const campuses = await tx.campus.findMany({
        where: {
          ...(campusId
            ? { id: campusId }
            : { id: { notIn: [HQ_CAMPUS_ID, OFFICIAL_CAMPUS_ID] } }),
          type: 'campus',
          status: { not: 'official' },
        },
        select: { id: true, name: true },
      });
      const scope = { in: campuses.map((c) => c.id) };
      const [products, orders] = await Promise.all([
        tx.product.findMany({
          where: { campusId: scope },
          select: {
            id: true,
            campusId: true,
            name: true,
            barcode: true,
            categoryId: true,
            category: { select: { name: true } },
            stock: true,
            lockedStock: true,
            wholesalePrice: true,
            unitsPerCase: true,
            status: true,
          },
        }),
        tx.order.findMany({
          where: {
            campusId: scope,
            status: 'completed',
            paidAt: { gte: dates.from, lt: dates.until },
          },
          select: { campusId: true, items: true },
        }),
      ]);
      const result = aggregateSku(
        products,
        orders,
        campuses,
        query.categoryId,
        query.keyword,
      );
      return {
        ...result,
        campuses,
        categories: [
          ...new Map(
            products.map((p) => [
              p.categoryId,
              { id: p.categoryId, name: p.category.name },
            ]),
          ).values(),
        ],
        start: dates.start,
        end: dates.end,
        generatedAt: new Date().toISOString(),
        ruleVersion: 'sku-simple-v1',
        basis: SKU_BASIS,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30000,
    },
  );
}
