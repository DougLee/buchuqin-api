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
  const OFF_C = `po-offC-${tag}`;
  const HQ_A = `po-hqA-${tag}`;
  const HQ_B = `po-hqB-${tag}`;
  const CAMPUS_ID = `po-campus-${tag}`;
  const HQ_OP = 'spec-hq';

  const hour = 3600 * 1000;
  let batchId = '';
  let poId = '';
  let batch2Id = '';

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
      data: { campusId: CAMPUS_ID,
      id: CAT_ID, name: `采购测试分类${tag}` } as any,
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
    }
    // 总部仓先备货（IKJC1R 确认不锁库存）（IKJC1R：确认不再锁库存，lockedStock 恒 0）
    await db.product.update({ where: { id: HQ_A }, data: { stock: 500 } });
    await db.product.update({ where: { id: HQ_B }, data: { stock: 500 } });
    for (const campus of [CAMPUS_ID, `po-campus2-${tag}`]) {
      const order = await db.restockOrder.findFirstOrThrow({
        where: { batchId, campusId: campus },
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
    await db.purchaseOrderItem.deleteMany({ where: { order: { batchId: batch2Id } } });
    await db.purchaseOrder.deleteMany({ where: { batchId: batch2Id } });
    await db.restockOrderItem.deleteMany({ where: { order: { batchId: batch2Id } } });
    await db.restockOrder.deleteMany({ where: { batchId: batch2Id } });
    await db.restockBatch.delete({ where: { id: batch2Id } }).catch(() => {});
    await db.inventoryTxn
      .deleteMany({ where: { productId: { in: [OFF_A, OFF_B, OFF_C, HQ_A, HQ_B] } } })
      .catch(() => {});
    await db.product
      .deleteMany({ where: { sourceProductId: OFF_C } })
      .catch(() => {});
    await db.product.deleteMany({ where: { id: { in: [OFF_A, OFF_B, OFF_C, HQ_A, HQ_B] } } });
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
    // 采购总额 = 7×280×24 + 3×300×24 = 68640 分（IKFOPR 按听报价：件×听×每听价）
    expect(row.totalCost).toBe(7 * 280 * 24 + 3 * 300 * 24);
    expect(row.receivedCost).toBe(row.totalCost);
    // 批次毛利预估（IQ8）：批发价合计 − 采购已收
    // 收入 = (7+3) 件 × 24 听 × 500 分 = 120000 分；成本 = 68640 分
    const detail = await admin.restockBatchDetail(batchId, true, '');
    expect(detail.wholesaleTotal).toBe(10 * 24 * 500);
    expect(detail.purchaseReceivedTotal).toBe(68640);
    expect(detail.grossEstimate).toBe(120000 - 68640);
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

  it('未铺货商品验收：自动建总部仓行再入库（IKJC1R 订货驱动采购）', async () => {
    // 官方在售行 C：无总部仓铺货行（模拟新品直接订货采购）
    await db.product.create({
      data: {
        id: OFF_C,
        campusId: OFFICIAL_CAMPUS_ID,
        categoryId: CAT_ID,
        name: '未铺货测试官方商品',
        subtitle: '',
        price: 400,
        originalPrice: 500,
        stock: 9999,
        tag: '',
        image: '',
        weight: 0,
        retailUnit: '听',
        wholesaleUnit: '件',
        unitsPerCase: 12,
        status: 'on-sale',
      } as any,
    });
    // 独立新批次：C 订货→确认（IKJC1R 确认不校验库存/铺货）→聚合生成采购单
    const batch2 = await admin.createRestockBatch(
      {
        name: `C批次${tag}`,
        startAt: new Date(Date.now() - 3600_000).toISOString(),
        endAt: new Date(Date.now() + 86_400_000).toISOString(),
      } as any,
      HQ_OP,
    );
    const cOrder = await admin.saveRestockOrder(
      batch2.id,
      { items: [{ productId: OFF_C, cases: 2 }] } as any,
      'spec-op',
      CAMPUS_ID,
    );
    const confirmed = await admin.auditRestockOrder(
      cOrder!.id,
      { action: 'confirm' } as any,
      HQ_OP,
    );
    expect(confirmed.status).toBe('confirmed');
    batch2Id = batch2.id;
    const po2 = await admin.createPurchaseOrder(
      batch2.id,
      { supplierName: `供应商C${tag}`, lines: [{ productId: OFF_C, unitCost: 260 }] } as any,
      HQ_OP,
    );
    const res = await admin.receivePurchaseOrder(
      po2.id,
      { lines: [{ productId: OFF_C, receiveCases: 2, badCases: 0, note: '' }] } as any,
      HQ_OP,
    );
    expect(res.phase).toBe('completed');
    // 自动建行：总部仓行存在、关联官方行、库存=到货数、下架态
    const created = await db.product.findFirstOrThrow({
      where: { sourceProductId: OFF_C },
    });
    expect(created.campusId).toBe('campus-hq');
    expect(created.stock).toBe(2 * 12);
    expect(created.status).toBe('off-sale');
    const txn = await db.inventoryTxn.findFirstOrThrow({
      where: { productId: created.id, type: 'purchase-receive' },
    });
    expect(txn.delta).toBe(24);
  });
});
