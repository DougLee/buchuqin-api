import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';

/**
 * 手动采购记录（IKRSIX #97）与盘点统计（IKRSIX #85）：
 * 台账纯登记不动库存；到期预警服务端算好；盘点统计按原因聚合核减流水。
 */
describe('purchase records & stocktake stats (IKRSIX #97/#85)', () => {
  const db = new PrismaService();
  const service = new AdminService(db, new BusinessService(db));
  const CAMPUS = 'campus-ops-purchase-test';
  const seed = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  let productId = '';
  const recordIds: string[] = [];

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '采购盘点测试大学',
        shortName: '采购盘点测试',
        warehouseName: '采购盘点测试仓',
      },
    });
    const category = await db.category.create({
      data: { campusId: CAMPUS, name: `采购盘点类目${seed}` },
    });
    const product = await db.product.create({
      data: {
        campusId: CAMPUS,
        categoryId: category.id,
        name: '采购盘点测试商品',
        subtitle: '',
        price: 600,
        originalPrice: 600,
        // LOCAL 采购：每零售单位成本=localPurchasePrice=200（分）
        procurementMode: 'LOCAL',
        localPurchasePrice: 200,
        stock: 100,
        tag: '',
        image: '',
        weight: 0.3,
      },
    });
    productId = product.id;
  });

  afterAll(async () => {
    await db.inventoryTxn.deleteMany({ where: { productId } });
    await db.purchaseRecord.deleteMany({ where: { campusId: CAMPUS } });
    await db.product.deleteMany({ where: { campusId: CAMPUS } });
    await db.category.deleteMany({ where: { campusId: CAMPUS } });
    await db.campus.delete({ where: { id: CAMPUS } });
    await db.$disconnect();
  });

  it('采购台账：新增+列表+到期预警（≤30 天 expiring / 已过 expired）', async () => {
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86400 * 1000).toISOString().slice(0, 10);
    const created = await service.createPurchaseRecord(
      {
        productName: '乐事薯片（零星采购）',
        qty: 24,
        price: 350,
        expiresAt: day(10),
        purchasedAt: day(0),
        remark: '校区门口批发部',
      },
      'spec-operator',
      CAMPUS,
    );
    recordIds.push(created.id);
    expect(created.campusId).toBe(CAMPUS);
    expect(created.createdBy).toBe('spec-operator');
    // 纯登记：不动库存、不落流水
    expect(
      await db.inventoryTxn.count({ where: { productId } }),
    ).toBe(0);

    const expiring = await service.createPurchaseRecord(
      {
        productName: '咖啡（临期预警）',
        qty: 10,
        price: 800,
        expiresAt: day(30),
        purchasedAt: day(0),
      },
      'spec-operator',
      CAMPUS,
    );
    recordIds.push(expiring.id);
    const expired = await service.createPurchaseRecord(
      {
        productName: '果汁（已过期）',
        qty: 6,
        price: 450,
        expiresAt: day(-1),
        purchasedAt: day(0),
      },
      'spec-operator',
      CAMPUS,
    );
    recordIds.push(expired.id);

    const rows = await service.purchaseRecords(
      undefined,
      undefined,
      CAMPUS,
      undefined,
    );
    expect(rows).toHaveLength(3);
    const byName = new Map(rows.map((r) => [r.productName, r]));
    expect(byName.get('乐事薯片（零星采购）')!.expiring).toBe(true);
    expect(byName.get('乐事薯片（零星采购）')!.expired).toBe(false);
    // 30 天整=预警边界内
    expect(byName.get('咖啡（临期预警）')!.expiring).toBe(true);
    expect(byName.get('果汁（已过期）')!.expired).toBe(true);
    expect(byName.get('果汁（已过期）')!.expiring).toBe(false);
    // 创建人/金额/ISO 时间出参
    const first = byName.get('乐事薯片（零星采购）')!;
    expect(first.price).toBe(350);
    expect(first.createdByName).toBe('spec-operator');
    expect(new Date(first.purchasedAt).toString()).not.toBe('Invalid Date');
    // 关键词过滤
    expect(
      (await service.purchaseRecords(undefined, undefined, CAMPUS, '薯片'))
        .length,
    ).toBe(1);
    // 非法日期拒绝
    await expect(
      service.purchaseRecords('2026-99-99', undefined, CAMPUS),
    ).rejects.toThrow('日期范围不合法');
  });

  it('盘点统计：按原因聚合核减流水，cost=核减数量×商品当前成本，盘盈不进核减', async () => {
    const day = new Date(Date.now() + 8 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    await db.inventoryTxn.createMany({
      data: [
        {
          productId,
          type: 'adjust',
          delta: -3,
          reason: '盘点校准：货损',
          operator: 'spec',
        },
        {
          productId,
          type: 'adjust',
          delta: -2,
          reason: '盘点校准：货损',
          operator: 'spec',
        },
        {
          productId,
          type: 'adjust',
          delta: -1,
          reason: '盘点校准：线下销售',
          operator: 'spec',
        },
        // 盘盈（正 delta）：计条数不进核减合计
        {
          productId,
          type: 'adjust',
          delta: 5,
          reason: '盘点校准',
          operator: 'spec',
        },
        // 非盘点链路流水（人工核减）：不进统计
        {
          productId,
          type: 'adjust',
          delta: -9,
          reason: '手工修正',
          operator: 'spec',
        },
      ],
    });
    const { items } = await service.stocktakeStats(day, day, CAMPUS);
    const byReason = new Map(items.map((x) => [x.reason, x]));
    const damage = byReason.get('货损')!;
    expect(damage.count).toBe(2);
    expect(damage.totalQty).toBe(5);
    expect(damage.totalCost).toBe(5 * 200);
    expect(damage.products).toEqual([
      {
        productId,
        productName: '采购盘点测试商品',
        qty: 5,
        cost: 5 * 200,
      },
    ]);
    const offline = byReason.get('线下销售')!;
    expect(offline.totalQty).toBe(1);
    expect(offline.totalCost).toBe(200);
    // 无前缀「盘点校准」的裸盘点（老数据）：归「未填写原因」，盘盈不计核减
    const blank = byReason.get('未填写原因')!;
    expect(blank.count).toBe(1);
    expect(blank.totalQty).toBe(0);
    expect(blank.totalCost).toBe(0);
    // 人工核减不混入
    expect(byReason.has('手工修正')).toBe(false);
  });
});
