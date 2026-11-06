import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { PaymentsService } from '../payments/payments.service';
import { NightOrderService } from './night-order.service';
import { NightRiderService } from './night-rider.service';
import { NightInventoryService } from './night-inventory.service';
import { inNightWindow } from './night.helpers';
import type { Campus } from '@prisma/client';

/**
 * 楼栋夜宵店最小冒烟（IKSW1F）：直连测试库（_spec），自建带 tag 夹具。
 * 覆盖三个必验收场景：
 * 1. 押金缴纳幂等（回调重复只落账一次，deposit 恒等式不漂移）
 * 2. 备货额度校验（库存×售价+本次×售价 ≤ 押金；超额 400 带差额提示）
 * 3. 券双向隔离（白天券/夜宵券互不可领、夜宵订单拒白天券）
 * 附带：下单扣库存/支付佣金两条（券后基数×比例 + 配送费全额）/超时关单回补。
 */

describe('Night store PostgreSQL integration (IKSW1F)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const payments = new PaymentsService(db, business);
  const orders = new NightOrderService(db, payments);
  const rider = new NightRiderService(db, orders);

  const tag = `iksw1f-${Date.now()}`;
  let campus: Campus;
  let buildingId: string;
  let staffId: string;
  let userId: string;
  let addressId: string;
  let storeId: string;
  let catalogProductId: string;
  let nightProductId: string;
  let dayCouponId: string;
  let nightCouponId: string;
  let nightUserCouponId: string;

  // 场次窗口覆盖当前时刻（跨零点安全：now±10 分钟，处理跨零点回绕）
  const nowMin = (() => {
    const hm = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
    const [h, m] = hm.split(':').map(Number);
    return (h % 24) * 60 + m;
  })();
  const wStart = (nowMin - 10 + 1440) % 1440;
  const wEnd = (nowMin + 10) % 1440;
  const fmt = (min: number) =>
    `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

  beforeAll(async () => {
    campus = await db.campus.create({
      data: {
        name: `夜宵测试大学${tag}`,
        shortName: '夜宵测',
        warehouseName: '夜宵测仓',
        // 手动闭店=白天已闭店（互斥放行夜宵）；场次窗口覆盖当前时刻
        manualClosed: true,
        nightEnabled: true,
        nightStartAt: fmt(wStart),
        nightEndAt: fmt(wEnd),
        nightPayTimeout: 15,
        nightAcceptTimeout: 30,
        nightDeliveryFee: 200,
        deliveryFeeInstant: 400,
      },
    });
    const building = await db.building.create({
      data: { campusId: campus.id, name: `夜宵 ${tag.slice(-4)} 栋` },
    });
    buildingId = building.id;
    const staff = await db.staff.create({
      data: {
        campusId: campus.id,
        name: '夜宵楼长',
        role: 'building-manager',
        roleText: '楼长',
        staffNo: `ngt-${tag.slice(-8)}`,
        building: building.name,
        buildingId: building.id,
        onTimeRate: 100,
        income: 0,
      },
    });
    staffId = staff.id;
    const user = await db.user.create({
      data: {
        campusId: campus.id,
        nickname: '夜宵测试用户',
        phone: `1${(Date.now() % 1_000_000_000).toString().padStart(10, '0').slice(0, 10)}`,
      },
    });
    userId = user.id;
    const address = await db.address.create({
      data: {
        userId: user.id,
        campusId: campus.id,
        campusName: campus.name,
        buildingId: building.id,
        buildingName: building.name,
        floor: 3,
        room: '302',
        contactName: '夜宵收货人',
        phone: user.phone,
      },
    });
    addressId = address.id;
    const store = await db.nightStore.create({
      data: {
        campusId: campus.id,
        buildingId: building.id,
        managerStaffId: staff.id,
        commissionRate: 2000, // 20%
        deposit: 50000, // 500 元
        status: 'closed',
      },
    });
    storeId = store.id;
    // 夜主档（Product nightCatalog=true，夜宵价 10 元）
    const category = await db.category.upsert({
      where: { campusId_name: { campusId: campus.id, name: '夜宵专供' } },
      update: {},
      create: { campusId: campus.id, name: '夜宵专供', hidden: true },
    });
    const warehouse = await db.product.create({
      data: {
        campusId: campus.id,
        categoryId: category.id,
        name: '夜宵可乐实物',
        subtitle: '',
        price: 1000,
        originalPrice: 1000,
        image: '',
        tag: '',
        stock: 100,
        weight: 0,
      },
    });
    const catalog = await db.product.create({
      data: {
        campusId: campus.id,
        nightCatalog: true,
        warehouseProductId: warehouse.id,
        categoryId: category.id,
        name: '夜宵可乐',
        subtitle: '',
        price: 1000,
        originalPrice: 1000,
        image: '',
        tag: '',
        stock: 0,
        status: 'on-sale',
        weight: 0,
      },
    });
    catalogProductId = catalog.id;
    const np = await db.nightProduct.create({
      data: { storeId: store.id, catalogProductId: catalog.id },
    });
    nightProductId = np.id;
    // 券模板：白天券 3 元 / 夜宵券 3 元
    const dayCoupon = await db.coupon.create({
      data: {
        campusId: campus.id,
        businessType: 'day',
        name: `白天券${tag.slice(-6)}`,
        amount: 300,
        threshold: 0,
        status: 'active',
        perUserLimit: 0,
      },
    });
    dayCouponId = dayCoupon.id;
    const nightCoupon = await db.coupon.create({
      data: {
        campusId: campus.id,
        businessType: 'night',
        name: `夜宵券${tag.slice(-6)}`,
        amount: 300,
        threshold: 0,
        status: 'active',
        perUserLimit: 0,
      },
    });
    nightCouponId = nightCoupon.id;
    const held = await db.userCoupon.create({
      data: { userId: user.id, couponId: nightCoupon.id },
    });
    nightUserCouponId = held.id;
  });

  afterAll(async () => {
    // 夹具清理（FK 逆序；按 tag 圈定不误伤存量数据）
    const store = storeId
      ? await db.nightStore.findUnique({ where: { id: storeId } })
      : null;
    if (!store) {
      await db.$disconnect();
      return;
    }
    await db.nightCommissionTxn.deleteMany({ where: { storeId } });
    await db.nightStockTxn.deleteMany({ where: { storeId } });
    await db.nightStockOrder.deleteMany({ where: { storeId } });
    await db.nightDepositTxn.deleteMany({ where: { storeId } });
    await db.nightDepositRefund.deleteMany({ where: { storeId } });
    await db.nightDepositOrder.deleteMany({ where: { storeId } });
    await db.nightRefund.deleteMany({ where: { storeId } });
    await db.nightOrder.deleteMany({ where: { storeId } });
    await db.userCoupon.deleteMany({ where: { userId } });
    await db.notification.deleteMany({ where: { userId } });
    await db.coupon.deleteMany({
      where: { id: { in: [dayCouponId, nightCouponId].filter(Boolean) } },
    });
    await db.nightProduct.deleteMany({ where: { storeId } });
    await db.nightStore.delete({ where: { id: storeId } });
    await db.inventoryTxn.deleteMany({
      where: { product: { campusId: campus.id } },
    });
    await db.product.deleteMany({ where: { campusId: campus.id } });
    await db.address.deleteMany({ where: { id: addressId } });
    await db.staff.deleteMany({ where: { id: staffId } });
    await db.building.deleteMany({ where: { id: buildingId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.campus.deleteMany({ where: { id: campus.id } });
    await db.$disconnect();
  });

  /* ---------- 场景 2：备货额度校验 ---------- */

  it('备货申请、校区审核出库、确认实收后才入库；店休也可备货', async () => {
    const r = await rider.createStockOrder(staffId, {
      items: [{ catalogProductId, quantity: 2 }],
    });
    expect(r.totalValue).toBe(2000); // 2 × 1000
    expect(
      (
        await db.nightProduct.findUniqueOrThrow({
          where: { id: nightProductId },
        })
      ).stock,
    ).toBe(0);
    const inventory = new NightInventoryService(db);
    await inventory.reviewStockOrder('test-admin', r.id, true, '同意');
    await inventory.shipStockOrder('test-admin', r.id);
    await inventory.receiveStockOrder(staffId, r.id, [
      { catalogProductId, quantity: 2 },
    ]);
    const np = await db.nightProduct.findUniqueOrThrow({
      where: { id: nightProductId },
    });
    expect(np.stock).toBe(2);
    const txn = await db.nightStockTxn.findFirst({
      where: { nightProductId, type: 'stockIn' },
    });
    expect(txn?.afterStock).toBe(2);
    expect(txn?.delta).toBe(2);
  });

  it('备货下单：超额 400 拒绝且提示押金差额（库存×售价+本次×售价>押金）', async () => {
    // 当前库存 2×1000=2000；再备 50×1000=50000 → 52000 > 押金 50000
    await expect(
      rider.createStockOrder(staffId, {
        items: [{ catalogProductId, quantity: 50 }],
      }),
    ).rejects.toThrow('押金额度不足');
    // 失败回滚：库存不变化、无残留 NightStockOrder
    const np = await db.nightProduct.findUniqueOrThrow({
      where: { id: nightProductId },
    });
    expect(np.stock).toBe(2);
    const cnt = await db.nightStockOrder.count({ where: { storeId } });
    expect(cnt).toBe(1);
  });

  /* ---------- 开店互斥 + 场景 3：券双向隔离 ---------- */

  it('开店：满足互斥+押金+可售商品条件后成功', async () => {
    expect(inNightWindow(fmt(wStart), fmt(wEnd))).toBe(true);
    const r = await rider.openStore(staffId);
    expect(r.status).toBe('open');
  });

  it('券双向隔离：白天券在夜宵渠道拒领；夜宵券在白天渠道拒领', async () => {
    // 夜宵领券口拒白天券
    await expect(
      orders.claimNightCoupon(userId, dayCouponId, campus.id),
    ).rejects.toThrow('该券不可在夜宵渠道领取');
    // 白天领券口拒夜宵券
    await expect(
      business.claimCoupon(userId, nightCouponId, campus.id),
    ).rejects.toThrow('该券仅限夜宵店使用');
  });

  it('夜宵下单：拒白天券；用夜宵券成功且库存原子扣减', async () => {
    await expect(
      orders.submitOrder(userId, {
        storeId,
        items: [{ productId: nightProductId, quantity: 1 }],
        couponId: dayCouponId, // 白天券（id 不存在 UserCoupon，直接构造失败路径）
        addressId,
      }),
    ).rejects.toThrow();
    const order = await orders.submitOrder(userId, {
      storeId,
      items: [{ productId: nightProductId, quantity: 1 }],
      couponId: nightUserCouponId,
      addressId,
      remark: '少冰',
    });
    expect(order.orderNo.startsWith('YX')).toBe(true);
    expect(order.productAmount).toBe(1000);
    expect(order.couponDiscount).toBe(300);
    expect(order.deliveryFee).toBe(200); // nightDeliveryFee
    expect(order.payableAmount).toBe(900);
    expect(order.status).toBe('pending-payment');
    // 库存已扣（下单预占）：2 → 1
    const np = await db.nightProduct.findUniqueOrThrow({
      where: { id: nightProductId },
    });
    expect(np.stock).toBe(1);
    // 券已锁定
    const uc = await db.userCoupon.findUniqueOrThrow({
      where: { id: nightUserCouponId },
    });
    expect(uc.status).toBe('locked');
  });

  /* ---------- 场景 1：押金幂等 + 支付佣金生成 ---------- */

  it('押金缴纳落账幂等：重复回调只记一次，deposit 一次累加', async () => {
    const before = await db.nightStore.findUniqueOrThrow({
      where: { id: storeId },
    });
    expect(before.deposit).toBe(50000);
    const intent = await db.nightDepositOrder.create({
      data: {
        storeId,
        outTradeNo: `NDTEST${tag.slice(-8)}1`,
        amount: 50000,
        targetTier: 100000,
      },
    });
    await orders.applyNightDepositPaid(intent.outTradeNo, 'wx-txn-1');
    await orders.applyNightDepositPaid(intent.outTradeNo, 'wx-txn-1'); // 重复回调
    await orders.applyNightDepositPaid(intent.outTradeNo, 'wx-txn-1'); // 再重复
    const after = await db.nightStore.findUniqueOrThrow({
      where: { id: storeId },
    });
    expect(after.deposit).toBe(100000);
    const txns = await db.nightDepositTxn.findMany({
      where: { storeId, type: 'deposit', payOrderNo: intent.outTradeNo },
    });
    expect(txns.length).toBe(1);
  });

  it('夜宵支付落账：状态流转+券核销+佣金两条（券后基数×比例 + 配送费全额），幂等', async () => {
    const mine = await orders.myOrders(userId, 'pending-payment');
    const orderNo = mine[0].orderNo;
    await orders.applyNightOrderPaid(orderNo, 'wx-yx-1');
    await orders.applyNightOrderPaid(orderNo, 'wx-yx-1'); // 重复回调幂等
    const view = await orders.myOrder(userId, mine[0].id);
    expect(view.status).toBe('pending-accept');
    expect(view.paidAt).toBeTruthy();
    // 券 locked → used
    const uc = await db.userCoupon.findUniqueOrThrow({
      where: { id: nightUserCouponId },
    });
    expect(uc.status).toBe('used');
    // 佣金两条：base=1000-300=700 × 20% = 140；配送费 200
    const txns = await db.nightCommissionTxn.findMany({
      where: { orderId: view.id },
    });
    expect(txns.length).toBe(2);
    const commission = txns.find((t) => t.type === 'commission')!;
    expect(commission.base).toBe(700);
    expect(commission.rate).toBe(2000);
    expect(commission.amount).toBe(140);
    expect(commission.status).toBe('estimated');
    const delivery = txns.find((t) => t.type === 'deliveryFee')!;
    expect(delivery.amount).toBe(200);
    // 楼长收入两列汇总
    const income = await rider.income(staffId);
    expect(income.summary.commission.estimated).toBe(140);
    expect(income.summary.deliveryFee.estimated).toBe(200);
  });

  it('超时关单：回补库存 + 释放券（与支付并发靠条件更新互斥）', async () => {
    // 再下一单（无券），手动把 timeoutAt 置过期后关单
    const order = await orders.submitOrder(userId, {
      storeId,
      items: [{ productId: nightProductId, quantity: 1 }],
      addressId,
    });
    expect(order.status).toBe('pending-payment');
    let np = await db.nightProduct.findUniqueOrThrow({
      where: { id: nightProductId },
    });
    expect(np.stock).toBe(0); // 1 已被上一单占用，本单扣到 0
    await db.nightOrder.update({
      where: { id: order.id },
      data: { timeoutAt: new Date(Date.now() - 1000) },
    });
    await orders.closePendingPayment(order.id, '支付超时已关闭');
    const closed = await db.nightOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(closed.status).toBe('cancelled');
    np = await db.nightProduct.findUniqueOrThrow({
      where: { id: nightProductId },
    });
    expect(np.stock).toBe(1); // 回补
  });

  it('接单/送达/确认收货：佣金 estimated → pending', async () => {
    const todo = await rider.storeOrders(staffId, 'pending-accept');
    const orderId = todo[0].id;
    await rider.accept(staffId, orderId);
    await rider.deliver(staffId, orderId, {
      images: ['https://example.com/proof.jpg'],
    });
    const txns = await db.nightCommissionTxn.findMany({
      where: { orderId },
    });
    expect(txns.every((t) => t.status === 'pending')).toBe(true);
    // 楼长侧单单明细（V1.5 L14 透明化：券扣减可见）
    const earning = await rider.orderEarning(staffId, orderId);
    expect(earning.commissionBase).toBe(700);
    expect(earning.commission).toBe(140);
    expect(earning.deliveryFee).toBe(200);
    expect(earning.total).toBe(340);
  });
});
