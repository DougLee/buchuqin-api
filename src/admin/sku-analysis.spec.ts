import {
  aggregateSku,
  readSkuAnalysis,
  skuDates,
  type SkuProduct,
} from './sku-analysis';
import { AdminController } from './admin.controller';
const campuses = [
  { id: 'c1', name: '校区一' },
  { id: 'c2', name: '校区二' },
];
const product = (
  id: string,
  overrides: Partial<SkuProduct> = {},
): SkuProduct => ({
  id,
  campusId: 'c1',
  name: id,
  barcode: '0001',
  categoryId: 'cat',
  category: { name: '饮品' },
  stock: 100,
  lockedStock: 20,
  wholesalePrice: 6000,
  unitsPerCase: 24,
  status: 'on-sale',
  ...overrides,
});
const line = (
  id: string,
  price: number,
  cost: number | undefined,
  quantity = 1,
) => ({ product: { id, price, unitWholesaleCost: cost }, quantity });
describe('SKU简化经营分析（无数据库写入）', () => {
  it('北京时间完整30天，拒绝今天、无效日期及过长区间', () => {
    const now = new Date('2026-09-24T02:00:00Z');
    expect(skuDates(undefined, undefined, now)).toMatchObject({
      start: '2026-08-25',
      end: '2026-09-23',
    });
    expect(skuDates('2026-09-17', '2026-09-23', now).from.toISOString()).toBe(
      '2026-09-16T16:00:00.000Z',
    );
    for (const [start, end] of [
      ['2026-02-30', '2026-03-01'],
      ['2026-09-23', '2026-09-24'],
      ['2024-01-01', '2026-09-23'],
    ])
      expect(() => skuDates(start, end, now)).toThrow();
  });
  it('80%核心包含跨线SKU；加权毛利而非平均毛利率', () => {
    const r = aggregateSku(
      ['a', 'b', 'c'].map((id) => product(id)),
      [
        {
          campusId: 'c1',
          items: [line('a', 600, 300), line('b', 300, 270), line('c', 100, 90)],
        },
      ],
      campuses,
    );
    expect(r.rows.map((x) => x.core)).toEqual([true, true, false]);
    expect(r.rows.map((x) => x.cumulative)).toEqual([0.6, 0.9, 1]);
    expect(r.totals.knownMarginRate).toBe(0.34);
    expect(r.median).toBe(300);
  });
  it('快照缺失不当零；零成本有效；中位数包含成本缺失SKU', () => {
    const r = aggregateSku(
      ['a', 'b'].map((id) => product(id)),
      [
        {
          campusId: 'c1',
          items: [line('a', 100, 0), line('b', 900, undefined)],
        },
      ],
      campuses,
    );
    expect(r.rows[0]).toMatchObject({ margin: null, quadrant: '不可分类' });
    expect(r.totals.costCoverage).toBe(0.1);
    expect(r.totals.knownMargin).toBe(100);
    expect(r.median).toBe(500);
  });
  it('同SKU任意行缺成本则该SKU毛利缺失', () => {
    const r = aggregateSku(
      [product('a')],
      [
        {
          campusId: 'c1',
          items: [
            line('a', 100, 20),
            line('a', 100, undefined),
            line('a', 100, 20),
          ],
        },
      ],
      campuses,
    );
    expect(r.rows[0]).toMatchObject({ sales: 300, quantity: 3, cost: null });
  });
  it('多订单不重复累计库存，可售扣锁定，估值按批发单位换算', () => {
    const r = aggregateSku(
      [product('a')],
      [1, 2].map(() => ({ campusId: 'c1', items: [line('a', 100, 20)] })),
      campuses,
    );
    expect(r.rows[0]).toMatchObject({
      sales: 200,
      stock: 100,
      available: 80,
      inventoryValue: 25000,
    });
  });
  it('同条码跨校区独立，丢失主档保留交易并提示', () => {
    const r = aggregateSku(
      [product('a'), product('b', { campusId: 'c2' })],
      [{ campusId: 'c1', items: [line('deleted', 50, 20)] }],
      campuses,
    );
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toMatchObject({
      id: 'deleted',
      stock: null,
      inventoryValue: null,
      margin: 30,
    });
  });
  it('异常锁库不可当可售零，负毛利给核查建议', () => {
    const r = aggregateSku(
      [product('a', { lockedStock: 101 }), product('b')],
      [{ campusId: 'c1', items: [line('b', 100, 200)] }],
      campuses,
    );
    expect(r.rows.find((x) => x.id === 'a')?.available).toBeNull();
    expect(r.rows[0].advice).toBe('核查定价与成本');
  });
  it('全局筛选重算分母，不丢失非法行提示', () => {
    const r = aggregateSku(
      [product('a'), product('b', { categoryId: 'other' })],
      [
        {
          campusId: 'c1',
          items: [line('a', 100, 20), line('b', 900, 50), null],
        },
      ],
      campuses,
      'cat',
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].contribution).toBe(1);
    expect(r.invalidLines).toBe(1);
  });
  it('查询限制普通校区、已完成及支付日期，读取使用一致事务', async () => {
    const tx = {
      campus: { findMany: jest.fn().mockResolvedValue([campuses[0]]) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      order: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const db = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
    await readSkuAnalysis(db as any, 'c1', {
      start: '2026-01-01',
      end: '2026-01-31',
    });
    expect(tx.campus.findMany.mock.calls[0][0].where).toMatchObject({
      id: 'c1',
      type: 'campus',
      status: { not: 'official' },
    });
    expect(tx.order.findMany.mock.calls[0][0].where).toMatchObject({
      campusId: { in: ['c1'] },
      status: 'completed',
    });
    expect(db.$transaction.mock.calls[0][1]).toMatchObject({
      isolationLevel: 'RepeatableRead',
    });
  });
  it('校区账号不能通过参数查询其他校区', async () => {
    const service = { skuAnalysis: jest.fn().mockResolvedValue({ rows: [] }) };
    const controller = new AdminController(service as any, {} as any);
    await controller.skuAnalysis(
      {
        user: { campusId: 'c1' },
        rbac: { platform: false, campusId: 'c1' },
      } as any,
      '2026-01-01',
      '2026-01-31',
      'c2',
    );
    expect(service.skuAnalysis.mock.calls[0][0]).toBe('c1');
  });
  it('无绑定校区账号拒绝查询，平台查询未知校区拒绝', async () => {
    const controller = new AdminController(
      {} as any,
      { knownCampusIds: async () => new Set(['c1']) } as any,
    );
    await expect(
      controller.skuAnalysis({
        user: {},
        rbac: { platform: false, campusId: '' },
      } as any),
    ).rejects.toThrow('账号未绑定校区');
    await expect(
      controller.skuAnalysis(
        { user: {}, rbac: { platform: true } } as any,
        undefined,
        undefined,
        'c2',
      ),
    ).rejects.toThrow('目标校区不存在');
  });
});
