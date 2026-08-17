import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { buildOrderTimeline } from '../common/order-state';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { BusinessService } from './business.service';

/**
 * 订单状态机全链路集成测试（IK93GQ，PRD §11.1 12 态）：
 * 下单 → pay → picking → waiting-first-mile → 抢单(grab/accept) → pickup
 * → depart(first-mile) → arrive(waiting-handover，楼下待交接节点)
 * → receive(last-mile) → delivered → confirm-receipt(completed)，
 * 以及 exception 旁路（absent）与用户端 statusPhase/异常话术。
 */
describe('order state machine full chain (IK93GQ)', () => {
  const db = new PrismaService();
  const service = new BusinessService(db);
  const fulfillment = new FulfillmentService(db);
  const CAMPUS = 'campus-hbut';
  const PRODUCT_ID = 'p001';
  const RIDER = 'staff-rider-001';
  const MANAGER = 'staff-bm-001';
  let userId = '';
  let addressSnapshot: Prisma.InputJsonValue;
  let stockBefore = 0;
  const createdOrderIds: string[] = [];
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

  const makeOrder = async () => {
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
    const order = await db.order.create({
      data: {
        orderNo: `BCQSM${Date.now()}${Math.random()
          .toString(36)
          .slice(2, 6)
          .toUpperCase()}`,
        userId,
        campusId: CAMPUS,
        status: 'pending-payment',
        statusText: '等待支付',
        address: addressSnapshot,
        deliveryMode: 'instant',
        items: json([{ product: snapshot, quantity: 1 }]),
        productAmount: Number(product.price),
        totalQuantity: 1,
        deliveryThreshold: 10,
        deliveryFee: 4,
        discount: 0,
        payableAmount: Number(product.price) + 4,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json(buildOrderTimeline('西区 5 栋 612')),
      },
    });
    createdOrderIds.push(order.id);
    return order;
  };
  const statusOf = async (id: string) =>
    (await db.order.findUniqueOrThrow({ where: { id } })).status;
  const step = async (id: string, key: string) => {
    const order = await db.order.findUniqueOrThrow({ where: { id } });
    return (order.timeline as Array<Record<string, unknown>>).find(
      (x) => x.key === key,
    );
  };

  beforeAll(async () => {
    const user = await db.user.create({
      data: {
        campusId: CAMPUS,
        nickname: '状态机测试用户',
        phone: '13900000003',
        role: 'user',
      },
    });
    userId = user.id;
    const address = await db.address.findFirstOrThrow({
      where: { userId: 'user-001' },
    });
    addressSnapshot = json(address);
    stockBefore = (
      await db.product.findUniqueOrThrow({ where: { id: PRODUCT_ID } })
    ).stock;
  });

  afterAll(async () => {
    await db.notification.deleteMany({ where: { userId } });
    await db.refund.deleteMany({ where: { userId } });
    // delivered 单已生成提成快照（IK8W5L），先清提成再删单。
    await db.commission.deleteMany({
      where: { orderId: { in: createdOrderIds } },
    });
    await db.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    // 本用例组直接删单不回补库存，恢复基线避免耗尽演示库存。
    await db.product.update({
      where: { id: PRODUCT_ID },
      data: { stock: stockBefore },
    });
    await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
  });

  it('happy path: pending-payment → … → delivered → completed with timeline', async () => {
    const order = await makeOrder();
    // 支付：pending-payment → paid
    const paid = await service.pay(userId, order.id);
    expect(paid.status).toBe('paid');
    expect(paid.statusPhase).toBe('fulfillment');
    expect((await step(order.id, 'paid')).done).toBe(true);

    // 管理端推进：paid → picking → waiting-first-mile（待一级配送，骑手可抢）
    await service.advance(userId, order.id);
    expect(await statusOf(order.id)).toBe('picking');
    await service.advance(userId, order.id);
    expect(await statusOf(order.id)).toBe('waiting-first-mile');
    expect((await step(order.id, 'picking')).done).toBe(true);

    // 骑手抢单（grab=accept 同语义）：写归属，状态不变
    const packageCode = (
      (await db.order.findUniqueOrThrow({ where: { id: order.id } }))
        .package as { id: string }
    ).id;
    await fulfillment.updateTask(RIDER, `task-fulltime-rider-${order.id}`, 'grab');
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).riderId,
    ).toBe(RIDER);
    expect(await statusOf(order.id)).toBe('waiting-first-mile');

    // 扫码取货：仍 waiting-first-mile，包裹标记 picked
    await fulfillment.updateTask(RIDER, `task-fulltime-rider-${order.id}`, 'pickup', {
      packageCode,
    });
    expect(await statusOf(order.id)).toBe('waiting-first-mile');
    expect(
      (
        (await db.order.findUniqueOrThrow({ where: { id: order.id } }))
          .package as { status: string }
      ).status,
    ).toBe('picked');

    // 出发：→ first-mile
    await fulfillment.updateTask(
      RIDER,
      `task-fulltime-rider-${order.id}`,
      'depart',
    );
    expect(await statusOf(order.id)).toBe('first-mile');
    expect((await step(order.id, 'first-mile')).done).toBe(true);

    // 到楼下：→ waiting-handover，写入"楼下待交接"节点
    await fulfillment.updateTask(
      RIDER,
      `task-fulltime-rider-${order.id}`,
      'arrive',
    );
    expect(await statusOf(order.id)).toBe('waiting-handover');
    const handoverStep = await step(order.id, 'waiting-handover');
    expect(handoverStep?.title).toBe('楼下待交接');
    expect(handoverStep?.done).toBe(true);

    // 楼长接货：→ last-mile
    await fulfillment.updateTask(
      MANAGER,
      `task-building-manager-${order.id}`,
      'receive',
    );
    expect(await statusOf(order.id)).toBe('last-mile');
    expect((await step(order.id, 'last-mile')).done).toBe(true);

    // 楼长上楼送达：→ delivered（与 completed 分离），写入送达凭证
    await fulfillment.updateTask(
      MANAGER,
      `task-building-manager-${order.id}`,
      'start-delivery',
    );
    expect(await statusOf(order.id)).toBe('last-mile');
    const delivered = await fulfillment.updateTask(
      MANAGER,
      `task-building-manager-${order.id}`,
      'delivered',
      { images: ['https://cos.example/proof.jpg'], location: '西区 5 栋 612' },
    );
    expect(await statusOf(order.id)).toBe('delivered');
    expect(delivered.statusText).toBe('已送达，待确认收货');
    const proof = (
      (await db.order.findUniqueOrThrow({ where: { id: order.id } }))
        .package as { proof?: { images: string[] } }
    ).proof;
    expect(proof?.images).toHaveLength(1);

    // 用户确认收货：delivered → completed（终态）
    const done = await service.confirmReceipt(userId, order.id);
    expect(done.status).toBe('completed');
    expect(done.statusPhase).toBe('done');
    // timeline 全部节点点亮
    const final = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(
      (final.timeline as Array<{ done: boolean }>).every((x) => x.done),
    ).toBe(true);
  });

  it('exception path: absent at last-mile → exception, user sees 客服话术', async () => {
    const order = await makeOrder();
    await service.pay(userId, order.id);
    await service.advance(userId, order.id);
    await service.advance(userId, order.id);
    await fulfillment.updateTask(RIDER, `task-fulltime-rider-${order.id}`, 'accept');
    const packageCode = (
      (await db.order.findUniqueOrThrow({ where: { id: order.id } }))
        .package as { id: string }
    ).id;
    await fulfillment.updateTask(RIDER, `task-fulltime-rider-${order.id}`, 'pickup', {
      packageCode,
    });
    await fulfillment.updateTask(
      RIDER,
      `task-fulltime-rider-${order.id}`,
      'depart',
    );
    await fulfillment.updateTask(
      RIDER,
      `task-fulltime-rider-${order.id}`,
      'arrive',
    );
    await fulfillment.updateTask(
      MANAGER,
      `task-building-manager-${order.id}`,
      'receive',
    );
    // 楼长上报"用户不在"：→ exception
    await fulfillment.updateTask(
      MANAGER,
      `task-building-manager-${order.id}`,
      'absent',
    );
    expect(await statusOf(order.id)).toBe('exception');
    // 用户端可见：统一话术 + exception 阶段
    const userView = await service.order(userId, order.id);
    expect(userView.statusText).toBe('履约异常，客服处理中');
    expect(userView.statusPhase).toBe('exception');
    const mine = await service.orders(userId, 'all');
    expect(
      mine.find((x) => x.id === order.id)?.statusPhase,
    ).toBe('exception');
  });

  it('confirm-receipt rejects orders not yet delivered', async () => {
    const order = await makeOrder();
    await service.pay(userId, order.id);
    await expect(service.confirmReceipt(userId, order.id)).rejects.toThrow(
      '当前状态不可确认收货',
    );
    // delivered/completed 分离：last-mile 也不能直接确认收货
    await service.advance(userId, order.id);
    await service.advance(userId, order.id);
    await expect(service.confirmReceipt(userId, order.id)).rejects.toThrow(
      '当前状态不可确认收货',
    );
  });
});
