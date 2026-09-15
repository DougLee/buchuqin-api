import { PrismaService } from '../database/prisma.service';
import { AdminService } from './admin.service';
import { BusinessService } from '../business/business.service';
import { HQ_CAMPUS_ID, OFFICIAL_CAMPUS_ID } from '../common/campus';

/**
 * 订货批次（IKFOQ0，2026-09-15 grilling 定版）：
 * - 批次窗口推导阶段（upcoming/open/ended/closed），窗口外不可订
 * - 校区一批次一张单（upsert），按件订 + unitsPerCase 快照换算
 * - 状态机全环：提交/撤回/驳回重提/确认/撤销确认
 * - 确认即锁总部仓库存（可用=stock−lockedStock，不足阻断），撤销释放
 * 独立 fixture，afterAll 全清理。
 */
describe('restock batch (IKFOQ0)', () => {
  const db = new PrismaService();
  const admin = new AdminService(db, new BusinessService(db));
  const tag = `rs-${Date.now()}`;
  const CAT_ID = `rs-cat-${tag}`;
  const OFF_ID = `rs-off-${tag}`;
  const CAMPUS_ID = `rs-campus-${tag}`;
  const HQ_ROW_ID = `rs-hq-${tag}`;
  const OP = 'spec-op';
  const HQ_OP = 'spec-hq';

  const hour = 3600 * 1000;
  let openBatchId = '';
  let upcomingBatchId = '';
  let endedBatchId = '';
  let orderId = '';

  beforeAll(async () => {
    await db.category.create({
      data: { id: CAT_ID, name: `订货测试分类${tag}` } as any,
    });
    // 官方库在售行：1 件 = 24 听
    await db.product.create({
      data: {
        id: OFF_ID,
        campusId: OFFICIAL_CAMPUS_ID,
        categoryId: CAT_ID,
        name: '订货测试官方商品',
        subtitle: '',
        price: 500,
        originalPrice: 600,
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
    // 订货校区 + 总部仓铺货行（stock=240，可用口径 stock−lockedStock）
    await db.campus.create({
      data: {
        id: CAMPUS_ID,
        name: `订货测试校区${tag}`,
        shortName: '订测',
        warehouseName: '订测仓',
        status: 'active',
      } as any,
    });
    await db.product.create({
      data: {
        id: HQ_ROW_ID,
        campusId: HQ_CAMPUS_ID,
        categoryId: CAT_ID,
        name: '订货测试总部仓行',
        subtitle: '',
        price: 500,
        originalPrice: 600,
        stock: 240,
        tag: '',
        image: '',
        weight: 0,
        sourceProductId: OFF_ID,
      } as any,
    });
    const now = Date.now();
    openBatchId = (
      await admin.createRestockBatch(
        {
          name: `开放批次${tag}`,
          startAt: new Date(now - hour).toISOString(),
          endAt: new Date(now + 24 * hour).toISOString(),
          productIds: [OFF_ID],
        } as any,
        HQ_OP,
      )
    ).id;
    upcomingBatchId = (
      await admin.createRestockBatch(
        {
          name: `未开始批次${tag}`,
          startAt: new Date(now + 24 * hour).toISOString(),
          endAt: new Date(now + 48 * hour).toISOString(),
          productIds: [OFF_ID],
        } as any,
        HQ_OP,
      )
    ).id;
    endedBatchId = (
      await admin.createRestockBatch(
        {
          name: `已结束批次${tag}`,
          startAt: new Date(now - 48 * hour).toISOString(),
          endAt: new Date(now - 24 * hour).toISOString(),
          productIds: [OFF_ID],
        } as any,
        HQ_OP,
      )
    ).id;
  });

  afterAll(async () => {
    await db.restockOrderItem.deleteMany({ where: { order: { batchId: { in: [openBatchId, upcomingBatchId, endedBatchId] } } } });
    await db.restockOrder.deleteMany({ where: { batchId: { in: [openBatchId, upcomingBatchId, endedBatchId] } } });
    await db.restockBatch.deleteMany({ where: { id: { in: [openBatchId, upcomingBatchId, endedBatchId] } } });
    await db.product.deleteMany({ where: { id: { in: [OFF_ID, HQ_ROW_ID] } } });
    await db.campus.delete({ where: { id: CAMPUS_ID } }).catch(() => {});
    await db.category.delete({ where: { id: CAT_ID } }).catch(() => {});
    await db.$disconnect();
  });

  const save = (cases: number, productId = OFF_ID) =>
    admin.saveRestockOrder(
      openBatchId,
      { items: [{ productId, cases }] } as any,
      OP,
      CAMPUS_ID,
    );

  it('窗口外不可订：未开始与已结束批次都拒绝保存', async () => {
    await expect(
      admin.saveRestockOrder(
        upcomingBatchId,
        { items: [{ productId: OFF_ID, cases: 1 }] } as any,
        OP,
        CAMPUS_ID,
      ),
    ).rejects.toThrow('批次尚未开始');
    await expect(
      admin.saveRestockOrder(
        endedBatchId,
        { items: [{ productId: OFF_ID, cases: 1 }] } as any,
        OP,
        CAMPUS_ID,
      ),
    ).rejects.toThrow('批次已结束');
  });

  it('批次外商品拒绝进入订货单', async () => {
    await expect(save(1, `rs-not-in-batch-${tag}`)).rejects.toThrow('不在本批次可订范围');
  });

  it('保存订货单：unitsPerCase 快照 + upsert 同一张单', async () => {
    const first = await save(5);
    orderId = first!.id;
    expect(first!.items[0].unitsPerCase).toBe(24);
    const again = await save(6);
    expect(again!.id).toBe(orderId); // 一批次一校区一张
    expect(again!.items).toHaveLength(1);
    expect(again!.items[0].cases).toBe(6);
    await save(5); // 回到 5 件（后续锁定按 5×24=120 断言）
  });

  it('提交 → 确认锁总部仓 120（5 件 × 24 听）', async () => {
    await admin.submitRestockOrder(openBatchId, OP, CAMPUS_ID);
    const res = await admin.auditRestockOrder(
      orderId,
      { action: 'confirm' } as any,
      HQ_OP,
    );
    expect(res.status).toBe('confirmed');
    const hqRow = await db.product.findUnique({ where: { id: HQ_ROW_ID } });
    expect(hqRow!.lockedStock).toBe(120);
  });

  it('确认后：重复确认被拦，校区改单被拦（提交后锁定）', async () => {
    await expect(
      admin.auditRestockOrder(orderId, { action: 'confirm' } as any, HQ_OP),
    ).rejects.toThrow('只有已提交');
    await expect(save(9)).rejects.toThrow('不能修改');
  });

  it('总部仓不足/未铺货阻断确认（信息含明细）', async () => {
    // 先撤销上一用例的确认（回 submitted、lockedStock=0），后续断言口径干净
    await admin.auditRestockOrder(orderId, { action: 'revoke' } as any, HQ_OP);
    // 未铺货：临时删 sourceProductId 关联再恢复
    await db.product.update({
      where: { id: HQ_ROW_ID },
      data: { sourceProductId: null },
    });
    await expect(
      admin.auditRestockOrder(orderId, { action: 'confirm' } as any, HQ_OP),
    ).rejects.toThrow('总部仓未铺货');
    await db.product.update({
      where: { id: HQ_ROW_ID },
      data: { sourceProductId: OFF_ID },
    });
    // 不足：可用 100 < 需 120
    await db.product.update({ where: { id: HQ_ROW_ID }, data: { stock: 100 } });
    await expect(
      admin.auditRestockOrder(orderId, { action: 'confirm' } as any, HQ_OP),
    ).rejects.toThrow('总部仓库存不足');
    await db.product.update({ where: { id: HQ_ROW_ID }, data: { stock: 240 } });
    expect((await db.restockOrder.findUnique({ where: { id: orderId } }))!.status).toBe(
      'submitted',
    );
  });

  it('撤销确认释放锁定：lockedStock 回 0、状态回已提交', async () => {
    await admin.auditRestockOrder(orderId, { action: 'confirm' } as any, HQ_OP);
    let hqRow = await db.product.findUnique({ where: { id: HQ_ROW_ID } });
    expect(hqRow!.lockedStock).toBe(120);
    const res = await admin.auditRestockOrder(
      orderId,
      { action: 'revoke', note: '订错了' } as any,
      HQ_OP,
    );
    expect(res.status).toBe('submitted');
    hqRow = await db.product.findUnique({ where: { id: HQ_ROW_ID } });
    expect(hqRow!.lockedStock).toBe(0);
  });

  it('撤回与驳回重提：状态机全环', async () => {
    const w = await admin.withdrawRestockOrder(openBatchId, OP, CAMPUS_ID); // submitted → draft
    expect(w.status).toBe('draft');
    await admin.submitRestockOrder(openBatchId, OP, CAMPUS_ID);
    const r = await admin.auditRestockOrder(
      orderId,
      { action: 'reject', note: '数量待定' } as any,
      HQ_OP,
    );
    expect(r.status).toBe('rejected');
    await save(8); // 驳回后可改
    const s = await admin.submitRestockOrder(openBatchId, OP, CAMPUS_ID);
    expect(s.status).toBe('submitted');
  });

  it('已提交单锁死批次范围修改；关闭批次后拒新订', async () => {
    await expect(
      admin.updateRestockBatch(
        openBatchId,
        { productIds: [OFF_ID] } as any,
        HQ_OP,
      ),
    ).rejects.toThrow('商品范围不可调整');
    await admin.closeRestockBatch(openBatchId, HQ_OP);
    await expect(
      admin.closeRestockBatch(openBatchId, HQ_OP),
    ).resolves.toBeDefined(); // 幂等
    await expect(
      admin.saveRestockOrder(
        openBatchId,
        { items: [{ productId: OFF_ID, cases: 1 }] } as any,
        OP,
        CAMPUS_ID,
      ),
    ).rejects.toThrow('不能再订货');
    // 收尾：释放确认态锁定（上轮 confirm 后 revoke，此处无锁定）
  });

  it('列表与详情：校区只看本校区，总部看全校区', async () => {
    const campusOrders = await admin.restockOrders(false, CAMPUS_ID, {});
    expect(campusOrders.some((o) => o.id === orderId)).toBe(true);
    const otherCampus = await admin.restockOrders(false, `rs-other-${tag}`, {});
    expect(otherCampus.some((o) => o.id === orderId)).toBe(false);
    const hqOrders = await admin.restockOrders(true, '', {});
    expect(hqOrders.some((o) => o.id === orderId)).toBe(true);
    const detail = await admin.restockBatchDetail(openBatchId, true, '');
    expect(detail.items).toHaveLength(1);
    expect(detail.orders).toHaveLength(1);
    expect(detail.orders[0].totalUnits).toBe(8 * 24);
  });
});
