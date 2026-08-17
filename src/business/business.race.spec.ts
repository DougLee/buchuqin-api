import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { BusinessService } from './business.service';

/**
 * 并发竞态集成测试（IK93GS）：
 * Promise.all 双调用断言条件更新互斥——只有一笔成功，库存/券/退款等副作用只发生一次。
 * 使用独立测试用户，避免污染 user-001 的种子数据。
 */
describe('BusinessService concurrency races (PostgreSQL)', () => {
  const db = new PrismaService();
  const service = new BusinessService(db);
  const fulfillment = new FulfillmentService(db);
  const CAMPUS = 'campus-hbut';
  const PRODUCT_ID = 'p001';
  const QUANTITY = 2;
  let userId = '';
  let addressSnapshot: Prisma.InputJsonValue;
  const createdOrderIds: string[] = [];
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

  const makeOrder = async (overrides: {
    status: string;
    statusText: string;
    minutesAgo?: number;
    paidAt?: Date;
    riderId?: string;
    timelineDone?: number;
    package?: Prisma.InputJsonValue;
  }) => {
    const product = await db.product.findUniqueOrThrow({
      where: { id: PRODUCT_ID },
    });
    const snapshot = {
      id: product.id,
      name: product.name,
      subtitle: product.subtitle,
      price: Number(product.price),
      originalPrice: Number(product.originalPrice),
      image: product.image,
      stock: product.stock,
      sales: product.sales,
      tag: product.tag,
      weight: Number(product.weight),
      categoryId: product.categoryId,
    };
    const steps = ['paid', 'picking', 'first-mile', 'last-mile'].map(
      (key, index) => ({
        key,
        title: key,
        description: '',
        done: index < (overrides.timelineDone ?? 0),
        ...(index < (overrides.timelineDone ?? 0)
          ? { time: new Date().toISOString() }
          : {}),
      }),
    );
    const order = await db.order.create({
      data: {
        orderNo: `BCQTEST${Date.now()}${Math.random()
          .toString(36)
          .slice(2, 6)
          .toUpperCase()}`,
        userId,
        campusId: CAMPUS,
        status: overrides.status,
        statusText: overrides.statusText,
        address: addressSnapshot,
        deliveryMode: 'instant',
        items: json([{ product: snapshot, quantity: QUANTITY }]),
        productAmount: Number(product.price) * QUANTITY,
        totalQuantity: QUANTITY,
        deliveryThreshold: 10,
        deliveryFee: 4,
        discount: 0,
        payableAmount: Number(product.price) * QUANTITY + 4,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json(steps),
        ...(overrides.paidAt ? { paidAt: overrides.paidAt } : {}),
        ...(overrides.riderId ? { riderId: overrides.riderId } : {}),
        ...(overrides.package ? { package: overrides.package } : {}),
        createdAt: new Date(Date.now() - (overrides.minutesAgo ?? 0) * 60_000),
      },
    });
    createdOrderIds.push(order.id);
    return order;
  };
  const message = (error: unknown) =>
    error instanceof BadRequestException ? error.message : String(error);

  beforeAll(async () => {
    const user = await db.user.create({
      data: {
        campusId: CAMPUS,
        nickname: '并发测试用户',
        phone: '13900000001',
        role: 'user',
      },
    });
    userId = user.id;
    const address = await db.address.findFirstOrThrow({
      where: { userId: 'user-001' },
    });
    addressSnapshot = json(address);
    await db.address.create({
      data: {
        userId,
        campusId: CAMPUS,
        campusName: address.campusName,
        buildingId: address.buildingId,
        buildingName: address.buildingName,
        floor: address.floor,
        room: address.room,
        contactName: '并发测试',
        phone: '13900000001',
        isDefault: true,
      },
    });
  });

  afterAll(async () => {
    await db.notification.deleteMany({ where: { userId } });
    await db.refund.deleteMany({ where: { userId } });
    await db.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    await db.address.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
  });

  it('concurrent pay: payment applies exactly once (stock decremented once)', async () => {
    const order = await makeOrder({
      status: 'pending-payment',
      statusText: '等待支付',
    });
    const before = await db.product.findUniqueOrThrow({
      where: { id: PRODUCT_ID },
    });
    const results = await Promise.allSettled([
      service.pay(userId, order.id),
      service.pay(userId, order.id),
    ]);
    const won = results.filter((x) => x.status === 'fulfilled');
    const lost = results.filter((x) => x.status === 'rejected');
    // 两种正确的交错结果（READ COMMITTED）：
    // 1) 两笔都读到待支付：一笔成功，另一笔条件更新 count=0 抛“订单状态已变化”；
    // 2) 第二笔读到已提交的 paid：走幂等返回，同样成功。
    // 无论哪种，都只能发生一次支付（paidAt/packageId 相同、库存只扣一次）。
    expect(won.length).toBeGreaterThanOrEqual(1);
    if (won.length === 2) {
      const [a, b] = won as Array<{ value: { paidAt: string } }>;
      expect(a.value.paidAt).toBe(b.value.paidAt);
    } else {
      expect(lost).toHaveLength(1);
      expect(message(lost[0].reason)).toContain('订单状态已变化');
    }
    const after = await db.product.findUniqueOrThrow({
      where: { id: PRODUCT_ID },
    });
    expect(before.stock - after.stock).toBe(QUANTITY);
    const final = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(final.status).toBe('paid');
    expect(final.paidAt).not.toBeNull();
    // 支付通知只发一条（幂等交错下不重复发送副作用）。
    expect(
      await db.notification.count({
        where: { userId, type: 'order', title: '支付成功' },
      }),
    ).toBe(1);
    // 库存恢复，避免影响后续用例。
    await db.product.update({
      where: { id: PRODUCT_ID },
      data: { stock: before.stock },
    });
  });

  it('concurrent cancel of a paid order: single refund and single stock restore', async () => {
    const order = await makeOrder({
      status: 'pending-payment',
      statusText: '等待支付',
    });
    await service.pay(userId, order.id);
    const paid = await db.product.findUniqueOrThrow({
      where: { id: PRODUCT_ID },
    });
    const results = await Promise.allSettled([
      service.cancel(userId, order.id),
      service.cancel(userId, order.id),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((x) => x.status === 'rejected');
    expect(rejected).toHaveLength(1);
    // 两种正确交错：并发窗口内读到 paid → 条件更新失败“订单状态已变化”；
    // 读到已提交的 cancelled → 前置校验拦下“当前状态不可取消”。
    expect(['订单状态已变化', '当前状态不可取消']).toContain(
      message(rejected[0].reason),
    );
    const restored = await db.product.findUniqueOrThrow({
      where: { id: PRODUCT_ID },
    });
    expect(restored.stock - paid.stock).toBe(QUANTITY);
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(1);
    const final = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(final.status).toBe('cancelled');
    expect(final.stockRestored).toBe(true);
  });

  it('concurrent rider accept: only one rider wins the task', async () => {
    const order = await makeOrder({
      status: 'paid',
      statusText: '仓库正在接单',
      timelineDone: 1,
      package: json({ id: 'PKG-RACE-01', status: 'paid' }),
    });
    const results = await Promise.allSettled([
      fulfillment.updateTask(
        'staff-rider-001',
        `task-fulltime-rider-${order.id}`,
        'accept',
      ),
      fulfillment.updateTask(
        'staff-rider-002',
        `task-parttime-rider-${order.id}`,
        'accept',
      ),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((x) => x.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(message(rejected[0].reason)).toContain('任务已被其他配送员接取');
    const final = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(['staff-rider-001', 'staff-rider-002']).toContain(final.riderId);
    expect(final.statusText).toBe('配送员已接单');
  });

  it('pickup validates the real package code', async () => {
    const order = await makeOrder({
      status: 'paid',
      statusText: '仓库正在接单',
      timelineDone: 1,
      riderId: 'staff-rider-001',
      package: json({ id: 'PKG-VERIFY-01', status: 'paid' }),
    });
    const taskId = `task-fulltime-rider-${order.id}`;
    await expect(
      fulfillment.updateTask('staff-rider-001', taskId, 'pickup', {
        packageCode: 'PKG-WRONG',
      }),
    ).rejects.toThrow('包裹码不正确');
    const task = await fulfillment.updateTask(
      'staff-rider-001',
      taskId,
      'pickup',
      {
        packageCode: 'PKG-VERIFY-01',
      },
    );
    expect(task.status).toBe('delivering');
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe('first-mile');
  });

  it('handover validates the room qrToken', async () => {
    const order = await makeOrder({
      status: 'last-mile',
      statusText: '已到楼下，等待楼长交接',
      timelineDone: 3,
      riderId: 'staff-rider-001',
      package: json({ id: 'PKG-VERIFY-02', status: 'last-mile' }),
    });
    const taskId = `task-fulltime-rider-${order.id}`;
    await expect(
      fulfillment.updateTask('staff-rider-001', taskId, 'handover', {
        handoverCode: 'qr-wrong-token',
      }),
    ).rejects.toThrow('交接码不正确');
    const room = await db.room.findFirstOrThrow({
      where: { qrToken: 'qr-seed-address-001' },
    });
    const task = await fulfillment.updateTask(
      'staff-rider-001',
      taskId,
      'handover',
      {
        handoverCode: room.qrToken,
      },
    );
    expect(task.id).toBe(taskId);
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe('last-mile');
  });

  it('expirePendingOrders only closes orders still pending payment', async () => {
    const stale = await makeOrder({
      status: 'pending-payment',
      statusText: '等待支付',
      minutesAgo: 20,
    });
    await service.orders(userId);
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: stale.id } })).status,
    ).toBe('cancelled');
  });
});
