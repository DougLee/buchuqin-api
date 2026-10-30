import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';

/**
 * 看板根级经营 KPI + 楼栋经营榜 + 日报优惠合计（IKRSIX #82/#116/#81b/#84b）：
 * 专建独立校区夹具，断言不受既有数据干扰；结束全量清理。
 */
describe('dashboard KPI / building-rank / daily discount (IKRSIX)', () => {
  const db = new PrismaService();
  const service = new AdminService(db, new BusinessService(db));
  const CAMPUS = 'campus-ops-kpi-test';
  const seed = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  let buildingA = '';
  let buildingB = '';
  let userId = '';
  let productLocal = '';
  const orderIds: string[] = [];

  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as any;

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '经营KPI测试大学',
        shortName: '经营KPI测试',
        warehouseName: '经营KPI测试仓',
      },
    });
    const [a, b] = await Promise.all([
      db.building.create({ data: { campusId: CAMPUS, name: 'KPI楼A' } }),
      db.building.create({ data: { campusId: CAMPUS, name: 'KPI楼B' } }),
    ]);
    buildingA = a.id;
    buildingB = b.id;
    const user = await db.user.create({
      data: {
        campusId: CAMPUS,
        nickname: 'KPI测试用户',
        phone: '13800002222',
        role: 'user',
      },
    });
    userId = user.id;
    const category = await db.category.create({
      data: { campusId: CAMPUS, name: `KPI类目${seed}` },
    });
    const product = await db.product.create({
      data: {
        campusId: CAMPUS,
        categoryId: category.id,
        name: 'KPI测试商品',
        subtitle: '',
        // LOCAL 采购：成本=localPurchasePrice（分/零售单位）
        price: 500,
        originalPrice: 500,
        procurementMode: 'LOCAL',
        localPurchasePrice: 200,
        stock: 10,
        tag: '',
        image: '',
        weight: 0.5,
      },
    });
    productLocal = product.id;
    const mkOrder = (
      id: string,
      o: {
        buildingId: string;
        buildingName: string;
        status?: string;
        discount?: number;
      },
    ) =>
      db.order.create({
        data: {
          id,
          orderNo: id,
          userId,
          campusId: CAMPUS,
          status: 'paid',
          statusText: '已支付',
          paidAt: new Date(),
          address: json({ buildingId: o.buildingId, buildingName: o.buildingName }),
          deliveryMode: 'instant',
          items: [],
          productAmount: 1000,
          totalQuantity: 1,
          deliveryThreshold: 0,
          deliveryFee: 400,
          discount: 0,
          payableAmount: 1400,
          estimatedArrival: '',
          timeline: [],
          ...(o.status ? { status: o.status } : {}),
          ...(o.discount != null ? { discount: o.discount } : {}),
        },
      });
    // 楼A：1400 实付（400 配送费），无退款；楼B：1400 实付，退款 300
    orderIds.push(
      (
        await mkOrder(`kpi-a-${seed}`, {
          buildingId: buildingA,
          buildingName: 'KPI楼A',
          discount: 137,
        })
      ).id,
      (
        await mkOrder(`kpi-b-${seed}`, {
          buildingId: buildingB,
          buildingName: 'KPI楼B',
          status: 'refunded',
          discount: 211,
        })
      ).id,
    );
    const orderB = await db.order.findUniqueOrThrow({
      where: { orderNo: `kpi-b-${seed}` },
    });
    await db.refund.create({
      data: {
        userId,
        orderId: orderB.id,
        amount: 300,
        status: 'refunded',
        refundedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await db.refund.deleteMany({ where: { order: { campusId: CAMPUS } } });
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.inventoryTxn.deleteMany({ where: { productId: productLocal } });
    await db.product.deleteMany({ where: { campusId: CAMPUS } });
    await db.category.deleteMany({ where: { campusId: CAMPUS } });
    await db.user.deleteMany({ where: { campusId: CAMPUS } });
    await db.building.deleteMany({ where: { campusId: CAMPUS } });
    await db.campus.delete({ where: { id: CAMPUS } });
    await db.$disconnect();
  });

  it('dashboard 根级 KPI：totalSales/todayDeliveryFee/stockCost/stocktakeCost/forecastSales', async () => {
    // 盘点核减流水：-2 件 × 本地进货价 200 = 400
    await db.inventoryTxn.create({
      data: {
        productId: productLocal,
        type: 'adjust',
        delta: -2,
        reason: '盘点校准：货损',
        operator: 'spec',
      },
    });
    // dashboard 返回类型是「总部汇总 | 单校区」联合——单校区分支才带根级 KPI，
    // spec 断言单校区形态，断言字段缺失即红
    const report = (await service.dashboard(CAMPUS, true)) as any;
    // totalSales=有效单（排除 pending-payment/cancelled/refunded）实付合计 − 退款合计
    // = 1400（楼A）− 300 = 1100（楼B 已 refunded 不进实付合计）
    expect(report.totalSales).toBe(1100);
    // 今日 paidAt 有效单配送费：有效单口径同看板 kpis（排除待支付/已取消，
    // refunded 单照计，退款额单独统计）——两单各 400
    expect(report.todayDeliveryFee).toBe(800);
    // 存货成本=stock 10 × 本地进货价 200；预计销售额=10 × 售价 500
    expect(report.stockCost).toBe(2000);
    expect(report.forecastSales).toBe(5000);
    // 盘点成本=核减 2 × 200（流水无成本快照，按商品当前成本估算）
    expect(report.stocktakeCost).toBe(400);
    // 无 cost.read：成本口径字段置 0，键位保留（前端契约不破）
    const trimmed = (await service.dashboard(CAMPUS, false)) as any;
    expect(trimmed.stockCost).toBe(0);
    expect(trimmed.stocktakeCost).toBe(0);
  });

  it('building-rank：楼栋归属/退款净额/降序/不截断，缺省本月', async () => {
    const { items } = await service.buildingRank(undefined, undefined, CAMPUS);
    expect(items).toHaveLength(2);
    const [top, second] = items;
    // 楼A：1400 − 0 = 1400；楼B：1400 − 300 = 1100 → 按销售降序
    expect(top.buildingId).toBe(buildingA);
    expect(top.buildingName).toBe('KPI楼A');
    expect(top.orders).toBe(1);
    expect(top.salesTotal).toBe(1400);
    expect(second.buildingId).toBe(buildingB);
    expect(second.salesTotal).toBe(1100);
    // 显式日期窗（同日闭区间）与缺省口径一致
    const today = new Date(Date.now() + 8 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const ranged = await service.buildingRank(today, today, CAMPUS);
    expect(ranged.items.map((x) => x.salesTotal)).toEqual([1400, 1100]);
    // 非法日期拒绝
    await expect(
      service.buildingRank('2026-13-40', today, CAMPUS),
    ).rejects.toThrow('日期范围不合法');
  });

  it('campusDailyReport totals.discountTotal：有效单 discount 字段合计', async () => {
    const today = new Date(Date.now() + 8 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const report = await service.campusDailyReport(today, today, {
      campusId: CAMPUS,
      hqScope: true,
      costRead: true,
    });
    // 两单 discount 137+211（refunded 单仍是有效单，进优惠合计口径）
    expect(report.totals.discountTotal).toBe(348);
    // cost.read 关闭分支同样下发（非成本口径）
    const trimmed = await service.campusDailyReport(today, today, {
      campusId: CAMPUS,
      hqScope: true,
      costRead: false,
    });
    expect(trimmed.totals.discountTotal).toBe(348);
  });
});
