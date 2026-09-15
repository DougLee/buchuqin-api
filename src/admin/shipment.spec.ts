import { PrismaService } from '../database/prisma.service';
import { AdminService } from './admin.service';
import { BusinessService } from '../business/business.service';
import { HQ_CAMPUS_ID, OFFICIAL_CAMPUS_ID } from '../common/campus';

/**
 * 分拨发货（IKFOQ2，2026-09-15 grilling 定版）：
 * - 发货：已确认订货单整单发（不拆包），总部仓 stock/lockedStock 双降（锁转实扣），
 *   行快照进货价（批次采购实际价优先回退 costPrice）+批发价（实时），restock-out 流水
 * - 库存不足拦截：报缺货数量
 * - 确认到货：按发货数全额入账（不登记差异），校区行缺失自动建（off-sale 态），
 *   restock-in 流水，订货单 received 终态；收货校区本人操作
 * - 状态机：confirmed 才能发、shipped 才能确认、发货后禁撤销确认
 * 独立 fixture，afterAll 全清理。
 */
describe('restock shipment (IKFOQ2)', () => {
  const db = new PrismaService();
  const admin = new AdminService(db, new BusinessService(db));
  const tag = `shp-${Date.now()}`;
  const CAT_ID = `shp-cat-${tag}`;
  const OFF_A = `shp-offA-${tag}`;
  const OFF_B = `shp-offB-${tag}`;
  const HQ_A = `shp-hqA-${tag}`;
  const HQ_B = `shp-hqB-${tag}`;
  const CAMPUS_1 = `shp-campus1-${tag}`;
  const CAMPUS_2 = `shp-campus2-${tag}`;
  const CAMPUS_A = `shp-campA-${tag}`; // 校区1 的 A 铺货行（已存在）
  const HQ_OP = 'spec-hq';
  const OP_1 = 'spec-op1';

  const hour = 3600 * 1000;
  let batchId = '';
  let orderId1 = '';
  let orderId2 = '';

  const seedProduct = async (
    offId: string,
    hqId: string,
    name: string,
    unitsPerCase: number,
    costPrice: number,
  ) => {
    await db.product.create({
      data: {
        id: offId,
        campusId: OFFICIAL_CAMPUS_ID,
        categoryId: CAT_ID,
        name,
        subtitle: '',
        price: 500,
        originalPrice: 600,
        costPrice,
        stock: 9999,
        tag: '',
        image: '',
        weight: 0,
        retailUnit: '听',
        wholesaleUnit: '件',
        unitsPerCase,
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
        costPrice,
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
      data: { id: CAT_ID, name: `发货测试分类${tag}` } as any,
    });
    // A：24 听/件 cost 300；B：12 听/件 cost 500（无采购行，发货回退 costPrice）
    await seedProduct(OFF_A, HQ_A, '发货测试商品A', 24, 300);
    await seedProduct(OFF_B, HQ_B, '发货测试商品B', 12, 500);
    await db.campus.create({
      data: {
        id: CAMPUS_1,
        name: `发货测试校区一${tag}`,
        shortName: '发一',
        warehouseName: '发一仓',
        status: 'active',
      } as any,
    });
    await db.campus.create({
      data: {
        id: CAMPUS_2,
        name: `发货测试校区二${tag}`,
        shortName: '发二',
        warehouseName: '发二仓',
        status: 'active',
      } as any,
    });
    // 校区1 已有 A 铺货行；校区2 完全无行（到货自动建档场景）
    await db.product.create({
      data: {
        id: CAMPUS_A,
        campusId: CAMPUS_1,
        categoryId: CAT_ID,
        name: '发货测试商品A校区行',
        subtitle: '',
        price: 500,
        originalPrice: 600,
        costPrice: 300,
        wholesalePrice: 500,
        stock: 0,
        tag: '',
        image: '',
        weight: 0,
        sourceProductId: OFF_A,
      } as any,
    });
    batchId = (
      await admin.createRestockBatch(
        {
          name: `发货批次${tag}`,
          startAt: new Date(Date.now() - hour).toISOString(),
          endAt: new Date(Date.now() + 24 * hour).toISOString(),
        } as any,
        HQ_OP,
      )
    ).id;
    // campus1：A 2件（48听）；campus2：A 1件+B 1件（24+12听）
    await admin.saveRestockOrder(
      batchId,
      { items: [{ productId: OFF_A, cases: 2 }] } as any,
      OP_1,
      CAMPUS_1,
    );
    await admin.saveRestockOrder(
      batchId,
      {
        items: [
          { productId: OFF_A, cases: 1 },
          { productId: OFF_B, cases: 1 },
        ],
      } as any,
      'spec-op2',
      CAMPUS_2,
    );
    await admin.submitRestockOrder(batchId, OP_1, CAMPUS_1);
    await admin.submitRestockOrder(batchId, 'spec-op2', CAMPUS_2);
    // 备货在确认前（确认锁库存：A 锁 72、B 锁 12）
    await db.product.update({ where: { id: HQ_A }, data: { stock: 500 } });
    await db.product.update({ where: { id: HQ_B }, data: { stock: 240 } });
    for (const campus of [CAMPUS_1, CAMPUS_2]) {
      const order = await db.restockOrder.findUniqueOrThrow({
        where: { batchId_campusId: { batchId, campusId: campus } },
      });
      await admin.auditRestockOrder(order.id, { action: 'confirm' } as any, HQ_OP);
      if (campus === CAMPUS_1) orderId1 = order.id;
      else orderId2 = order.id;
    }
    // 批次采购单（只含 A，unitCost 改 280）→ 发货 A 行成本快照应为 280；
    // B 无采购行 → 回退官方 costPrice 500
    await admin.createPurchaseOrder(
      batchId,
      {
        supplierName: `发货供应商${tag}`,
        lines: [{ productId: OFF_A, unitCost: 280 }],
      } as any,
      HQ_OP,
    );
  });

  afterAll(async () => {
    await db.inventoryTxn.deleteMany({
      where: {
        OR: [
          { productId: { in: [OFF_A, OFF_B, HQ_A, HQ_B, CAMPUS_A] } },
          // 到货自动建档行（campus2 新建）的 restock-in 流水
          { product: { campusId: { in: [CAMPUS_1, CAMPUS_2] } } },
        ],
      },
    });
    await db.purchaseOrderItem.deleteMany({ where: { order: { batchId } } });
    await db.purchaseOrder.deleteMany({ where: { batchId } });
    await db.restockShipmentItem.deleteMany({
      where: { shipment: { batchId } },
    });
    await db.restockShipment.deleteMany({ where: { batchId } });
    await db.restockOrderItem.deleteMany({ where: { order: { batchId } } });
    await db.restockOrder.deleteMany({ where: { batchId } });
    await db.restockBatch.delete({ where: { id: batchId } }).catch(() => {});
    await db.product.deleteMany({
      where: {
        OR: [{ id: { in: [OFF_A, OFF_B, HQ_A, HQ_B, CAMPUS_A] } }, { campusId: { in: [CAMPUS_1, CAMPUS_2] } }],
      },
    });
    await db.campus
      .deleteMany({ where: { id: { in: [CAMPUS_1, CAMPUS_2] } } })
      .catch(() => {});
    await db.category.delete({ where: { id: CAT_ID } }).catch(() => {});
    await db.$disconnect();
  });

  it('发货：锁转实扣双降、成本快照采购价优先、restock-out 流水、状态 shipped', async () => {
    await admin.shipRestockOrder(orderId1, { note: '整箱发' } as any, HQ_OP);
    const hqA = await db.product.findUniqueOrThrow({ where: { id: HQ_A } });
    expect(hqA.stock).toBe(500 - 48); // 2 件 × 24 听
    expect(hqA.lockedStock).toBe(72 - 48); // 确认时锁 72（两单合计），本单 48 转实扣
    const txn = await db.inventoryTxn.findFirstOrThrow({
      where: { productId: HQ_A, type: 'restock-out' },
    });
    expect(txn.delta).toBe(-48);
    const detail = await admin.restockShipmentDetail(orderId1, true, '');
    expect(detail.orderStatus).toBe('shipped');
    expect(detail.totalUnits).toBe(48);
    const a = detail.items.find((i) => i.productId === OFF_A)!;
    // 每件价=听价×听数（IKFOPR 按听报价）：采购实际价 280/听 → 6720/件；批发 500/听 → 12000/件
    expect(a.costPerCase).toBe(280 * 24);
    expect(a.wholesalePerCase).toBe(500 * 24);
    expect(detail.wholesaleTotal).toBe(2 * 500 * 24); // 件数×每件批发价（2 件×12000）
    expect(detail.costTotal).toBe(2 * 280 * 24);
    // 订货单列表带发货时间摘要
    const rows = await admin.restockOrders(true, '', { batchId });
    expect(rows.find((r) => r.id === orderId1)!.shippedAt).toBeTruthy();
  });

  it('库存不足拦截报缺货数量；恢复后可发货，B 行成本回退 costPrice', async () => {
    await db.product.update({ where: { id: HQ_B }, data: { stock: 10 } });
    await expect(
      admin.shipRestockOrder(orderId2, {} as any, HQ_OP),
    ).rejects.toThrow('缺 2');
    await db.product.update({ where: { id: HQ_B }, data: { stock: 240 } });
    await admin.shipRestockOrder(orderId2, {} as any, HQ_OP);
    const detail = await admin.restockShipmentDetail(orderId2, true, '');
    expect(detail.totalUnits).toBe(36); // 24 + 12
    const b = detail.items.find((i) => i.productId === OFF_B)!;
    expect(b.costPerCase).toBe(500 * 12); // 无采购行回退 costPrice 500/听 → 6000/件
    const hqB = await db.product.findUniqueOrThrow({ where: { id: HQ_B } });
    expect(hqB.stock).toBe(240 - 12);
    expect(hqB.lockedStock).toBe(0); // 锁定清零
    // 重复发货拦截（状态机已 shipped，双保险）
    await expect(
      admin.shipRestockOrder(orderId2, {} as any, HQ_OP),
    ).rejects.toThrow('只有已确认的订货单可以发货');
  });

  it('确认到货：已有行入账+自动建档 off-sale+restock-in 流水+received 终态', async () => {
    // 非收货校区确认被拦
    await expect(
      admin.confirmRestockReceipt(orderId1, OP_1, CAMPUS_2),
    ).rejects.toThrow('只有收货校区');
    await admin.confirmRestockReceipt(orderId1, OP_1, CAMPUS_1);
    const rowA = await db.product.findUniqueOrThrow({ where: { id: CAMPUS_A } });
    expect(rowA.stock).toBe(48); // 按发货数全额入账
    const txn = await db.inventoryTxn.findFirstOrThrow({
      where: { productId: CAMPUS_A, type: 'restock-in' },
    });
    expect(txn.delta).toBe(48);
    const order1 = await db.restockOrder.findUniqueOrThrow({
      where: { id: orderId1 },
    });
    expect(order1.status).toBe('received');
    await admin.confirmRestockReceipt(orderId2, 'spec-op2', CAMPUS_2);
    // 校区2 两行均不存在 → 自动建（off-sale、库存=到货听数、资料复制官方行）
    const created = await db.product.findMany({
      where: { campusId: CAMPUS_2, sourceProductId: { in: [OFF_A, OFF_B] } },
    });
    expect(created.length).toBe(2);
    for (const c of created) {
      expect(c.status).toBe('off-sale');
      expect(c.sourceSyncedAt).toBeTruthy();
      expect(c.stock).toBe(c.sourceProductId === OFF_A ? 24 : 12);
    }
    const order2 = await db.restockOrder.findUniqueOrThrow({
      where: { id: orderId2 },
    });
    expect(order2.status).toBe('received');
  });

  it('总部日报：receivedAt 落日×校区聚合，与发货单毛利同源；校区筛选可用', async () => {
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const rep = await admin.hqDailyReport(today, today);
    // 两单批发额 = 2×12000 + (12000+6000) = 42000；成本 = 13440 + (6720+6000) = 26160
    expect(rep.totals.shipments).toBe(2);
    expect(rep.totals.wholesaleTotal).toBe(42000);
    expect(rep.totals.costTotal).toBe(26160);
    expect(rep.totals.gross).toBe(15840);
    expect(rep.totals.marginRate).toBe(Math.round((15840 / 42000) * 10000));
    // campus1 筛选：只含本校区单（24000/13440）
    const rep1 = await admin.hqDailyReport(today, today, CAMPUS_1);
    expect(rep1.rows.length).toBe(1);
    expect(rep1.rows[0].campusId).toBe(CAMPUS_1);
    expect(rep1.totals.wholesaleTotal).toBe(24000);
    expect(rep1.totals.costTotal).toBe(13440);
  });

  it('状态机拦截：shipped 禁撤销确认、received 禁再发/禁再确认、confirmed 门槛', async () => {
    // received 单再发货
    await expect(
      admin.shipRestockOrder(orderId1, {} as any, HQ_OP),
    ).rejects.toThrow('只有已确认的订货单可以发货');
    // received 单再确认到货
    await expect(
      admin.confirmRestockReceipt(orderId1, OP_1, CAMPUS_1),
    ).rejects.toThrow('只有已发货的订货单');
    // received 单撤销确认被拦（revoke 仅 confirmed）
    await expect(
      admin.auditRestockOrder(orderId1, { action: 'revoke' } as any, HQ_OP),
    ).rejects.toThrow('只有已确认的订货单可以撤销确认');
  });
});
