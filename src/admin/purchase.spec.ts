import { PrismaService } from '../database/prisma.service';
import { AdminService } from './admin.service';
import { BusinessService } from '../business/business.service';
import { HQ_CAMPUS_ID, OFFICIAL_CAMPUS_ID } from '../common/campus';

/**
 * 采购单（IKFOQ1，2026-09-15 grilling 定版）：
 * - 一键聚合：批次 confirmed 订货单按商品求和生成（未关闭单禁再生成）
 * - 快捷全收：预填欠收逐行验收，禁超收；坏品入库再出库（到货全入库存，坏品自动扣回）
 * - 状态推导 pending/partial/completed/closed；关闭禁验收、可重开
 * - 金额：行 unitCost 快照（预填 costPrice 可改）；批次详情 grossEstimate
 * 独立 fixture，afterAll 全清理。
 */
describe('purchase order (IKFOQ1)', () => {
  const db = new PrismaService();
  const admin = new AdminService(db, new BusinessService(db));
  const tag = `po-${Date.now()}`;
  const CAT_ID = `po-cat-${tag}`;
  const OFF_A = `po-offA-${tag}`;
  const OFF_B = `po-offB-${tag}`;
  const HQ_A = `po-hqA-${tag}`;
  const HQ_B = `po-hqB-${tag}`;
  const CAMPUS_ID = `po-campus-${tag}`;
  const HQ_OP = 'spec-hq';

  const hour = 3600 * 1000;
  let batchId = '';
  let poId = '';

  /** 官方在售商品 + 总部仓铺货行（stock 初值 0） */
  const seedProduct = async (offId: string, hqId: string, name: string) => {
    await db.product.create({
      data: {
        id: offId,
        campusId: OFFICIAL_CAMPUS_ID,
        categoryId: CAT_ID,
        name,
        subtitle: '',
        price: 500, // 批发价 5 元/听
        originalPrice: 600,
        costPrice: 300, // 进货价 3 元/听
        stock: 9999,
        tag: '',
        image: '',
        weight: 0,
        retailUnit: '听',
        wholesaleUnit: '件',
        unitsPerCase: 24,
        status: 'on-sale',
      } as any,
    });
    await db.product.create({
      data: {
        id: hqId,
        campusId: HQ_CAMPUS_ID,
        categoryId: CAT_ID,
        name: `${name}总部仓行`,
        subtitle: '',
        price: 500,
        originalPrice: 600,
        costPrice: 300,
        stock: 0,
        tag: '',
        image: '',
        weight: 0,
        sourceProductId: offId,
      } as any,
    });
  };

  beforeAll(async () => {
    await db.category.create({
      data: { id: CAT_ID, name: `采购测试分类${tag}` } as any,
    });
    await seedProduct(OFF_A, HQ_A, '采购测试商品A');
    await seedProduct(OFF_B, HQ_B, '采购测试商品B');
    await db.campus.create({
      data: {
        id: CAMPUS_ID,
        name: `采购测试校区${tag}`,
        shortName: '购测',
        warehouseName: '购测仓',
        status: 'active',
      } as any,
    });
    batchId = (
      await admin.createRestockBatch(
        {
          name: `采购批次${tag}`,
          startAt: new Date(Date.now() - hour).toISOString(),
          endAt: new Date(Date.now() + 24 * hour).toISOString(),
        } as any,
        HQ_OP,
      )
    ).id;
    // 两校区确认单：A 商品 5+2=7 件、B 商品 3 件（聚合快照口径）
    for (const campus of [CAMPUS_ID, `po-campus2-${tag}`]) {
      if (campus !== CAMPUS_ID)
        await db.campus.create({
          data: {
            id: campus,
            name: `采购测试校区二${tag}`,
            shortName: '购二',
            warehouseName: '购二仓',
            status: 'active',
          } as any,
        });
      await admin.saveRestockOrder(
        batchId,
        {
          items: [
            { productId: OFF_A, cases: campus === CAMPUS_ID ? 5 : 2 },
            ...(campus === CAMPUS_ID ? [{ productId: OFF_B, cases: 3 }] : []),
          ],
        } as any,
        'spec-op',
        campus,
      );
      await admin.submitRestockOrder(batchId, 'spec-op', campus);
    }
    // 总部仓先备货再确认：确认即锁 A=7×24=168、B=3×24=72（锁后可用 332/428，
    // 采购验收动的是 stock 本身，与锁定无冲突；锁定语义 restock.spec 已覆盖）
    await db.product.update({ where: { id: HQ_A }, data: { stock: 500 } });
    await db.product.update({ where: { id: HQ_B }, data: { stock: 500 } });
    for (const campus of [CAMPUS_ID, `po-campus2-${tag}`]) {
      const order = await db.restockOrder.findUniqueOrThrow({
        where: { batchId_campusId: { batchId, campusId: campus } },
      });
      await admin.auditRestockOrder(order.id, { action: 'confirm' } as any, HQ_OP);
    }
  });

  afterAll(async () => {
    await db.purchaseOrderItem.deleteMany({ where: { order: { batchId } } });
    await db.purchaseOrder.deleteMany({ where: { batchId } });
    await db.restockOrderItem.deleteMany({
      where: { order: { batchId } },
    });
    await db.restockOrder.deleteMany({ where: { batchId } });
    await db.restockBatch.delete({ where: { id: batchId } }).catch(() => {});
    await db.inventoryTxn
      .deleteMany({ where: { productId: { in: [OFF_A, OFF_B, HQ_A, HQ_B] } } })
      .catch(() => {});
    await db.product.deleteMany({ where: { id: { in: [OFF_A, OFF_B, HQ_A, HQ_B] } } });
    await db.campus
      .deleteMany({ where: { id: { in: [CAMPUS_ID, `po-campus2-${tag}`] } } })
      .catch(() => {});
    await db.category.delete({ where: { id: CAT_ID } }).catch(() => {});
    await db.$disconnect();
  });

  it('一键聚合生成：A 7 件/B 3 件，未关闭时再生成被拦', async () => {
    const row = await admin.createPurchaseOrder(
      batchId,
      {
        supplierName: `供应商${tag}`,
        lines: [
          { productId: OFF_A, unitCost: 280 },
          { productId: OFF_B, unitCost: 300 },
        ],
      } as any,
      HQ_OP,
    );
    poId = row.id;
    const detail = await admin.purchaseOrderDetail(poId);
    expect(detail.phase).toBe('pending');
    const a = detail.items.find((i) => i.productId === OFF_A)!;
    const b = detail.items.find((i) => i.productId === OFF_B)!;
    expect(a.requiredCases).toBe(7); // 5+2 两校区聚合
    expect(b.requiredCases).toBe(3);
    expect(a.unitCost).toBe(280); // 预填可改（IQ7）
    // 进行中采购单存在时禁止再生成
    await expect(
      admin.createPurchaseOrder(
        batchId,
        { supplierName: 'x', lines: [{ productId: OFF_A, unitCost: 300 }] } as any,
        HQ_OP,
      ),
    ).rejects.toThrow('进行中的采购单');
  });

  it('快捷全收部分到货：收 A 4 件（坏 1）→ partial、库存 4×24、坏品出库 −24', async () => {
    const res = await admin.receivePurchaseOrder(
      poId,
      {
        lines: [
          { productId: OFF_A, receiveCases: 4, badCases: 1, note: '压坏一件' },
          { productId: OFF_B, receiveCases: 0, badCases: 0 },
        ],
      } as any,
      HQ_OP,
    );
    expect(res.phase).toBe('partial');
    const hqA = await db.product.findUniqueOrThrow({ where: { id: HQ_A } });
    expect(hqA.stock).toBe(500 + 4 * 24 - 1 * 24); // 到货全入、坏品扣回
    const txns = await db.inventoryTxn.findMany({
      where: { productId: HQ_A, type: { in: ['purchase-receive', 'purchase-bad'] } },
    });
    expect(txns.find((t) => t.type === 'purchase-receive')?.delta).toBe(96);
    expect(txns.find((t) => t.type === 'purchase-bad')?.delta).toBe(-24);
    const detail = await admin.purchaseOrderDetail(poId);
    const a = detail.items.find((i) => i.productId === OFF_A)!;
    expect(a.receivedCases).toBe(4);
    expect(a.badCases).toBe(1);
    expect(a.lastNote).toBe('压坏一件');
  });

  it('禁超收与坏品越界：欠收 3 件收 4 拒、坏 2>到货 1 拒', async () => {
    await expect(
      admin.receivePurchaseOrder(
        poId,
        { lines: [{ productId: OFF_A, receiveCases: 4, badCases: 0 }] } as any,
        HQ_OP,
      ),
    ).rejects.toThrow('超收');
    await expect(
      admin.receivePurchaseOrder(
        poId,
        { lines: [{ productId: OFF_A, receiveCases: 1, badCases: 2 }] } as any,
        HQ_OP,
      ),
    ).rejects.toThrow('坏品数不能大于本次到货数');
  });

  it('补收齐 → completed；金额=单价×数量；批次 grossEstimate 聚合正确', async () => {
    await admin.receivePurchaseOrder(
      poId,
      {
        lines: [
          { productId: OFF_A, receiveCases: 3, badCases: 0 },
          { productId: OFF_B, receiveCases: 3, badCases: 0 },
        ],
      } as any,
      HQ_OP,
    );
    const list = await admin.purchaseOrders();
    const row = list.find((p) => p.id === poId)!;
    expect(row.phase).toBe('completed');
    expect(row.requiredCases).toBe(10);
    expect(row.receivedCases).toBe(10);
    // 采购总额 = 7×280 + 3×300 = 2860 分；已收同额
    expect(row.totalCost).toBe(7 * 280 + 3 * 300);
    expect(row.receivedCost).toBe(row.totalCost);
    // 批次毛利预估（IQ8）：批发价合计 − 采购已收
    // 收入 = (7+3) 件 × 24 听 × 500 分 = 120000 分；成本 = 2860 分
    const detail = await admin.restockBatchDetail(batchId, true, '');
    expect(detail.wholesaleTotal).toBe(10 * 24 * 500);
    expect(detail.purchaseReceivedTotal).toBe(2860);
    expect(detail.grossEstimate).toBe(120000 - 2860);
  });

  it('关闭禁验收、重开可继续；关闭单不再拦新单生成（补采）', async () => {
    await admin.closePurchaseOrder(poId, { note: '余款不补' } as any, HQ_OP);
    await expect(
      admin.receivePurchaseOrder(
        poId,
        { lines: [{ productId: OFF_A, receiveCases: 0, badCases: 0 }] } as any,
        HQ_OP,
      ),
    ).rejects.toThrow('已关闭');
    // 重开回到 completed 推导态
    await admin.reopenPurchaseOrder(poId, HQ_OP);
    const list = await admin.purchaseOrders();
    expect(list.find((p) => p.id === poId)!.phase).toBe('completed');
    // 再关闭后允许生成新采购单（补采口径）
    await admin.closePurchaseOrder(poId, {} as any, HQ_OP);
    const row2 = await admin.createPurchaseOrder(
      batchId,
      { supplierName: `补采${tag}`, lines: [{ productId: OFF_A, unitCost: 300 }] } as any,
      HQ_OP,
    );
    // 新单应收以聚合为准（仍是全量 confirmed 聚合），生成后清场由 afterAll 处理
    const detail2 = await admin.purchaseOrderDetail(row2.id);
    expect(detail2.phase).toBe('pending');
    expect(detail2.items.find((i) => i.productId === OFF_A)!.requiredCases).toBe(7);
  });
});
