import { PrismaService } from '../database/prisma.service';
import { AdminService } from './admin.service';
import { BusinessService } from '../business/business.service';
import { HQ_CAMPUS_ID, OFFICIAL_CAMPUS_ID } from '../common/campus';

/**
 * 订货批次（IKFOQ0，2026-09-15 grilling 定版）：
 * - 批次窗口推导阶段（upcoming/open/ended/closed），窗口外不可订
 * - 校区一批次一张单（upsert），按件订 + unitsPerCase 快照换算
 * - 多单制（IKJCJF）：填完即提交成一张新单，可多次订货；待审核可删除
 * - 确认不校验不锁库存（IKJC1R 订货驱动采购）
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

  it('非官方在售商品拒绝进入订货单（恒等全集口径）', async () => {
    await expect(save(1, `rs-not-in-batch-${tag}`)).rejects.toThrow('不在官方库在售范围');
  });

  it('提交成单：每次保存一张新单（IKJCJF 多单制、无草稿）', async () => {
    const first = await save(5);
    orderId = first!.id;
    expect(first!.status).toBe('submitted'); // 填完即提交
    expect(first!.items[0].unitsPerCase).toBe(24);
    const second = await save(6);
    expect(second!.id).not.toBe(orderId); // 再订=另一张新单
    expect(second!.status).toBe('submitted');
    // 删除第二张（待审核可删），回到第一张为主单
    await admin.deleteRestockOrder(second!.id, OP, CAMPUS_ID);
    expect(await db.restockOrder.findUnique({ where: { id: second!.id } })).toBeNull();
  });

  it('确认不校验不锁库存（IKJC1R：订货驱动采购）', async () => {
    const res = await admin.auditRestockOrder(
      orderId,
      { action: 'confirm' } as any,
      HQ_OP,
    );
    expect(res.status).toBe('confirmed');
    const hqRow = await db.product.findUnique({ where: { id: HQ_ROW_ID } });
    // 确认环节完全不碰库存：lockedStock 恒 0
    expect(hqRow!.lockedStock).toBe(0);
  });

  it('确认后：重复确认被拦；已确认单不可删除', async () => {
    await expect(
      admin.auditRestockOrder(orderId, { action: 'confirm' } as any, HQ_OP),
    ).rejects.toThrow('只有已提交');
    // confirmed 已进采购聚合，删除被拦
    await expect(
      admin.deleteRestockOrder(orderId, OP, CAMPUS_ID),
    ).rejects.toThrow('只有待审核');
  });

  it('总部仓不足/未铺货不再阻断确认（IKJC1R，新单验证）', async () => {
    // 未铺货：临时删 sourceProductId 关联再恢复——新单确认照常通过
    await db.product.update({
      where: { id: HQ_ROW_ID },
      data: { sourceProductId: null },
    });
    const o2 = await save(4);
    const r1 = await admin.auditRestockOrder(
      o2!.id,
      { action: 'confirm' } as any,
      HQ_OP,
    );
    expect(r1.status).toBe('confirmed');
    await admin.auditRestockOrder(o2!.id, { action: 'revoke' } as any, HQ_OP);
    await db.product.update({
      where: { id: HQ_ROW_ID },
      data: { sourceProductId: OFF_ID },
    });
    // 库存不足（可用 100 < 需 96）同样不阻断
    await db.product.update({ where: { id: HQ_ROW_ID }, data: { stock: 100 } });
    const o3 = await save(4);
    const r2 = await admin.auditRestockOrder(
      o3!.id,
      { action: 'confirm' } as any,
      HQ_OP,
    );
    expect(r2.status).toBe('confirmed');
    await admin.auditRestockOrder(o3!.id, { action: 'revoke' } as any, HQ_OP);
    await db.product.update({ where: { id: HQ_ROW_ID }, data: { stock: 240 } });
  });

  it('撤销确认：lockedStock 恒 0（IKJC1R 不再锁/释放）', async () => {
    const o = await save(5);
    await admin.auditRestockOrder(o!.id, { action: 'confirm' } as any, HQ_OP);
    const res = await admin.auditRestockOrder(
      o!.id,
      { action: 'revoke', note: '订错了' } as any,
      HQ_OP,
    );
    expect(res.status).toBe('submitted');
    const hqRow = await db.product.findUnique({ where: { id: HQ_ROW_ID } });
    expect(hqRow!.lockedStock).toBe(0);
  });

  it('驳回=终态，再订生成新单（IKJCJF 无草稿重提）', async () => {
    const o = await save(8);
    const r = await admin.auditRestockOrder(
      o!.id,
      { action: 'reject', note: '数量待定' } as any,
      HQ_OP,
    );
    expect(r.status).toBe('rejected');
    // 驳回单不可删（仅待审核可删）；再订=另一张新单
    await expect(
      admin.deleteRestockOrder(o!.id, OP, CAMPUS_ID),
    ).rejects.toThrow('只有待审核');
    const fresh = await save(3);
    expect(fresh!.status).toBe('submitted');
    orderId = o!.id; // 主单指向驳回单（后续列表断言按 8 件）
  });

  it('关闭批次后拒新订（关窗幂等）', async () => {
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
  });

  it('列表与详情：校区只看本校区，总部看全校区；商品=在售全集', async () => {
    const campusOrders = await admin.restockOrders(false, CAMPUS_ID, {});
    expect(campusOrders.some((o) => o.id === orderId)).toBe(true);
    const otherCampus = await admin.restockOrders(false, `rs-other-${tag}`, {});
    expect(otherCampus.some((o) => o.id === orderId)).toBe(false);
    const hqOrders = await admin.restockOrders(true, '', {});
    expect(hqOrders.some((o) => o.id === orderId)).toBe(true);
    const detail = await admin.restockBatchDetail(openBatchId, true, '');
    expect(detail.items.some((i) => i.productId === OFF_ID)).toBe(true);
    // IKJCJF 多单制：主单（8 件驳回单）在列，多张并存
    const main = detail.orders.find((o) => o.id === orderId);
    expect(main).toBeDefined();
    expect(main!.totalUnits).toBe(8 * 24);
  });
});
