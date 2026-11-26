import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from './business.service';
import type { OrderPayHooks } from './order-pay-hooks';

/**
 * IKY6QE（道哥 2026-11-26）：下单锁定库存 + 支付落账不可失败。
 * 覆盖：下单原子锁定 / 库存被改低后支付仍落账 / 超时·取消释放锁 /
 * 存量单（未持锁）支付直接扣 / 限购在途占名额 / 锁定巡检回收多锁 /
 * 关单前查微信分流（已支付不关 / 未支付关 / 查不清不关）。
 */
describe('order pay safety (IKY6QE)', () => {
  const db = new PrismaService();
  const service = new BusinessService(db);
  const CAMPUS = 'campus-hbut';
  const PREFIX = 'IKY6QE';
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  let userId = '';
  let CATEGORY_ID = '';
  let BUILDING_ID = '';
  let BUILDING_NAME = '';
  const cleanup: Array<() => Promise<unknown>> = [];

  const makeProduct = async (over: Partial<{ stock: number; purchaseLimit: string; purchaseLimitQty: number; procurementMode: string | null; localPurchasePrice: number | null }> = {}) =>
    db.product.create({
      data: {
        campusId: CAMPUS,
        categoryId: CATEGORY_ID,
        name: `${PREFIX}商品${Math.random().toString(36).slice(2, 8)}`,
        subtitle: '',
        price: 500,
        originalPrice: 500,
        stock: over.stock ?? 10,
        ...(over.purchaseLimit ? { purchaseLimit: over.purchaseLimit } : {}),
        ...(over.purchaseLimitQty ? { purchaseLimitQty: over.purchaseLimitQty } : {}),
        ...(over.procurementMode !== undefined ? { procurementMode: over.procurementMode } : {}),
        ...(over.localPurchasePrice !== undefined ? { localPurchasePrice: over.localPurchasePrice } : {}),
        status: 'on-sale',
        tag: '',
        image: '',
        weight: 0,
      },
    });

  const makeAddress = async () =>
    db.address.create({
      data: {
        userId,
        campusId: CAMPUS,
        campusName: '湖北工业大学',
        buildingId: BUILDING_ID,
        buildingName: BUILDING_NAME,
        floor: 6,
        room: `6${Math.floor(Math.random() * 90 + 10)}`,
        contactName: '测试用户',
        phone: '13800000000',
        isDefault: false,
      },
    });

  const lineOf = (product: { id: string; name: string }, quantity: number) => ({
    product: { id: product.id, name: product.name, price: 500, stock: 10, categoryId: CATEGORY_ID, campusId: CAMPUS },
    quantity,
    asSeckill: false,
  });

  beforeAll(async () => {
    // spec 库分类/楼栋为随机 id：先取 campus-hbut 现有分类与楼栋做 fixture
    const [category] = await db.category.findMany({
      where: { campusId: CAMPUS },
      take: 1,
    });
    const [building] = await db.building.findMany({
      where: { campusId: CAMPUS },
      take: 1,
    });
    expect(category).toBeDefined();
    expect(building).toBeDefined();
    CATEGORY_ID = category.id;
    BUILDING_ID = building.id;
    BUILDING_NAME = building.name;
    userId = (
      await db.user.create({
        data: {
          openid: `iky6qe-${Math.random().toString(36).slice(2, 10)}`,
          nickname: 'IKY6QE测试',
          campusId: CAMPUS,
          phone: '13900000001',
        },
      })
    ).id;
    cleanup.push(() => db.user.delete({ where: { id: userId } }));
  });

  afterAll(async () => {
    for (const undo of cleanup.reverse()) await undo().catch(() => undefined);
    await db.$disconnect();
  });

  // 购物车是用户级的：失败/未支付用例留下的行会污染后续用例的结算校验
  afterEach(async () => {
    await db.cartItem.deleteMany({ where: { userId } });
  });

  it('下单即原子锁定：可售减少、锁定等量增加、订单标记持锁', async () => {
    const product = await makeProduct({ stock: 5 });
    cleanup.push(() => db.product.delete({ where: { id: product.id } }));
    const address = await makeAddress();
    cleanup.push(() => db.address.delete({ where: { id: address.id } }));
    await db.cartItem.create({
      data: { userId, productId: product.id, quantity: 2, asSeckill: false },
    });
    const order = await service.createOrder(userId, CAMPUS, {
      addressId: address.id,
      deliveryMode: 'instant',
    } as never);
    cleanup.push(() => db.order.delete({ where: { id: order.id } }));
    const after = await db.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stock).toBe(3);
    expect(after.lockedStock).toBe(2);
    const row = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.stockLocked).toBe(true);
  });

  it('库存不足时下单失败：不产生订单、不涉及资金、可售不动', async () => {
    const product = await makeProduct({ stock: 1 });
    cleanup.push(() => db.product.delete({ where: { id: product.id } }));
    const address = await makeAddress();
    cleanup.push(() => db.address.delete({ where: { id: address.id } }));
    await db.cartItem.create({
      data: { userId, productId: product.id, quantity: 2, asSeckill: false },
    });
    await expect(
      service.createOrder(userId, CAMPUS, {
        addressId: address.id,
        deliveryMode: 'instant',
      } as never),
    ).rejects.toThrow('库存不足');
    const after = await db.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stock).toBe(1);
    expect(after.lockedStock).toBe(0);
  });

  it('下单后库存被盘点改低：支付仍落账（paid/小票前提/paidAt 全就位），锁兑现', async () => {
    const product = await makeProduct({ stock: 5 });
    cleanup.push(() => db.product.delete({ where: { id: product.id } }));
    const address = await makeAddress();
    cleanup.push(() => db.address.delete({ where: { id: address.id } }));
    await db.cartItem.create({
      data: { userId, productId: product.id, quantity: 2, asSeckill: false },
    });
    const order = await service.createOrder(userId, CAMPUS, {
      addressId: address.id,
      deliveryMode: 'instant',
    } as never);
    cleanup.push(() => db.order.delete({ where: { id: order.id } }));
    // 仓管把可售改到 1（低于本单锁定量 2）——支付不允许因此失败
    await db.product.update({ where: { id: product.id }, data: { stock: 1 } });
    const paid = await service.pay(userId, order.id, {
      transactionId: 'wx-iky6qe-1',
    });
    expect(paid.status).toBe('paid');
    const row = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.paidAt).not.toBeNull();
    expect(row.wxTransactionId).toBe('wx-iky6qe-1');
    const after = await db.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    // 锁兑现：锁定清零、可售不动、销量累计
    expect(after.lockedStock).toBe(0);
    expect(after.stock).toBe(1);
    expect(after.sales).toBe(2);
  });

  it('超时关单释放锁并回补可售；关单前查到已支付的单不关、查不清的单不关', async () => {
    const product = await makeProduct({ stock: 5 });
    cleanup.push(() => db.product.delete({ where: { id: product.id } }));
    const address = await makeAddress();
    cleanup.push(() => db.address.delete({ where: { id: address.id } }));
    await db.cartItem.create({
      data: { userId, productId: product.id, quantity: 3, asSeckill: false },
    });
    const paidOrder = await service.createOrder(userId, CAMPUS, {
      addressId: address.id,
      deliveryMode: 'instant',
    } as never);
    cleanup.push(() => db.order.delete({ where: { id: paidOrder.id } }));
    await service.pay(userId, paidOrder.id);

    const staleOrder = await db.order.create({
      data: {
        orderNo: `BCQIKY6QE${Date.now()}`,
        userId,
        campusId: CAMPUS,
        status: 'pending-payment',
        statusText: '等待支付',
        address: json({ buildingName: BUILDING_NAME, room: '612' }),
        deliveryMode: 'instant',
        items: json([lineOf(product, 2)]),
        productAmount: 1000,
        totalQuantity: 2,
        deliveryThreshold: 1000,
        deliveryFee: 0,
        discount: 0,
        payableAmount: 1000,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json([{ key: 'paid', title: '支付成功', done: false }]),
        stockLocked: true,
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
      },
    });
    cleanup.push(() => db.order.delete({ where: { id: staleOrder.id } }));
    await db.product.update({
      where: { id: product.id },
      data: { lockedStock: { increment: 2 }, stock: { decrement: 2 } },
    });

    const pendingOrder = await db.order.create({
      data: {
        orderNo: `BCQIKY6QP${Date.now()}`,
        userId,
        campusId: CAMPUS,
        status: 'pending-payment',
        statusText: '等待支付',
        address: json({ buildingName: BUILDING_NAME, room: '612' }),
        deliveryMode: 'instant',
        items: json([lineOf(product, 1)]),
        productAmount: 500,
        totalQuantity: 1,
        deliveryThreshold: 1000,
        deliveryFee: 0,
        discount: 0,
        payableAmount: 500,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json([{ key: 'paid', title: '支付成功', done: false }]),
        stockLocked: true,
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
      },
    });
    cleanup.push(() => db.order.delete({ where: { id: pendingOrder.id } }));
    await db.product.update({
      where: { id: product.id },
      data: { lockedStock: { increment: 1 }, stock: { decrement: 1 } },
    });

    const unknownOrder = await db.order.create({
      data: {
        orderNo: `BCQIKY6QU${Date.now()}`,
        userId,
        campusId: CAMPUS,
        status: 'pending-payment',
        statusText: '等待支付',
        address: json({ buildingName: BUILDING_NAME, room: '612' }),
        deliveryMode: 'instant',
        items: json([lineOf(product, 1)]),
        productAmount: 500,
        totalQuantity: 1,
        deliveryThreshold: 1000,
        deliveryFee: 0,
        discount: 0,
        payableAmount: 500,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json([{ key: 'paid', title: '支付成功', done: false }]),
        stockLocked: true,
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
      },
    });
    cleanup.push(() => db.order.delete({ where: { id: unknownOrder.id } }));
    await db.product.update({
      where: { id: product.id },
      data: { lockedStock: { increment: 1 }, stock: { decrement: 1 } },
    });

    const settleSpy = jest
      .fn<Promise<boolean>, [unknown]>()
      .mockImplementation(async (order: { id: string }) => {
        if (order.id === paidOrder.id) return true; // 已支付
        if (order.id === staleOrder.id) throw new Error('微信查单超时'); // 查不清
        return false;
      });
    const closeSpy = jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined);
    service.registerPayHooks({
      settleBeforeClose: settleSpy,
      closeWechatOrder: closeSpy,
    } as OrderPayHooks);

    await service.expireAllPendingOrders();

    // 已支付的单：不关（哪怕超时）
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: paidOrder.id } })).status,
    ).toBe('paid');
    // 查不清的单：本轮不关（下一轮重试）
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: staleOrder.id } }))
        .status,
    ).toBe('pending-payment');
    // 确认未支付的单：关单 + 释放锁回补可售 + 通知微信关闭
    const closed = await db.order.findUniqueOrThrow({
      where: { id: pendingOrder.id },
    });
    expect(closed.status).toBe('cancelled');
    const after = await db.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    // staleOrder 仍持有 2（本轮查不清不关）；pending/unknown 各 1 已释放
    expect(after.lockedStock).toBe(2);
    expect(closeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ orderNo: pendingOrder.orderNo }),
    );
    // 通知微信关闭只对实际关掉的单
    expect(closeSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ orderNo: staleOrder.orderNo }),
    );
  });

  it('用户取消：与关单同款释放锁', async () => {
    const product = await makeProduct({ stock: 5 });
    cleanup.push(() => db.product.delete({ where: { id: product.id } }));
    const address = await makeAddress();
    cleanup.push(() => db.address.delete({ where: { id: address.id } }));
    await db.cartItem.create({
      data: { userId, productId: product.id, quantity: 2, asSeckill: false },
    });
    const order = await service.createOrder(userId, CAMPUS, {
      addressId: address.id,
      deliveryMode: 'instant',
    } as never);
    cleanup.push(() => db.order.delete({ where: { id: order.id } }));
    const closeSpy = jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined);
    service.registerPayHooks({
      settleBeforeClose: async () => false,
      closeWechatOrder: closeSpy,
    } as OrderPayHooks);
    await service.cancel(userId, order.id);
    const after = await db.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stock).toBe(5);
    expect(after.lockedStock).toBe(0);
    expect(closeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ orderNo: order.orderNo }),
    );
  });

  it('存量单（stockLocked=false）：支付直接扣可售（兼容上线前订单）', async () => {
    const product = await makeProduct({ stock: 5 });
    cleanup.push(() => db.product.delete({ where: { id: product.id } }));
    const legacy = await db.order.create({
      data: {
        orderNo: `BCQIKY6QL${Date.now()}`,
        userId,
        campusId: CAMPUS,
        status: 'pending-payment',
        statusText: '等待支付',
        address: json({ buildingName: BUILDING_NAME, room: '612' }),
        deliveryMode: 'instant',
        items: json([lineOf(product, 2)]),
        productAmount: 1000,
        totalQuantity: 2,
        deliveryThreshold: 1000,
        deliveryFee: 0,
        discount: 0,
        payableAmount: 1000,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json([{ key: 'paid', title: '支付成功', done: false }]),
        stockLocked: false,
      },
    });
    cleanup.push(() => db.order.delete({ where: { id: legacy.id } }));
    await service.pay(userId, legacy.id);
    const after = await db.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stock).toBe(3);
    expect(after.lockedStock).toBe(0);
  });

  it('限购在途占名额：待支付单阻止再次下单，取消后名额释放', async () => {
    const product = await makeProduct({
      stock: 10,
      purchaseLimit: 'once',
      purchaseLimitQty: 1,
    }).then((row) =>
      db.product.update({ where: { id: row.id }, data: { price: 2000, originalPrice: 2000 } }),
    );
    cleanup.push(() => db.product.delete({ where: { id: product.id } }));
    const address = await makeAddress();
    cleanup.push(() => db.address.delete({ where: { id: address.id } }));
    await db.cartItem.create({
      data: { userId, productId: product.id, quantity: 1, asSeckill: false },
    });
    const order = await service.createOrder(userId, CAMPUS, {
      addressId: address.id,
      deliveryMode: 'instant',
    } as never);
    cleanup.push(() => db.order.delete({ where: { id: order.id } }));
    // 在途待支付 → 再下一单被限购拦（双设备绕过通道关闭）
    await db.cartItem.deleteMany({ where: { userId, productId: product.id } });
    await db.cartItem.create({
      data: { userId, productId: product.id, quantity: 1, asSeckill: false },
    });
    await expect(
      service.createOrder(userId, CAMPUS, {
        addressId: address.id,
        deliveryMode: 'instant',
      } as never),
    ).rejects.toThrow(BadRequestException);
    // 取消（释放锁+名额）后可再下
    service.registerPayHooks({
      settleBeforeClose: async () => false,
      closeWechatOrder: async () => {},
    } as OrderPayHooks);
    await service.cancel(userId, order.id);
    await db.cartItem.deleteMany({ where: { userId, productId: product.id } });
    await db.cartItem.create({
      data: { userId, productId: product.id, quantity: 1, asSeckill: false },
    });
    const again = await service.createOrder(userId, CAMPUS, {
      addressId: address.id,
      deliveryMode: 'instant',
    } as never);
    cleanup.push(() => db.order.delete({ where: { id: again.id } }));
  });

  it('锁定巡检：多锁自动回收退回可售，账账相符不误伤', async () => {
    const product = await makeProduct({ stock: 5 });
    cleanup.push(() => db.product.delete({ where: { id: product.id } }));
    const address = await makeAddress();
    cleanup.push(() => db.address.delete({ where: { id: address.id } }));
    await db.cartItem.create({
      data: { userId, productId: product.id, quantity: 2, asSeckill: false },
    });
    const order = await service.createOrder(userId, CAMPUS, {
      addressId: address.id,
      deliveryMode: 'instant',
    } as never);
    cleanup.push(() => db.order.delete({ where: { id: order.id } }));
    // 人为多锁 3 件（模拟释放路径漏写）
    await db.product.update({
      where: { id: product.id },
      data: { stock: { decrement: 3 }, lockedStock: { increment: 3 } },
    });
    const result = await service.auditStockLocks();
    expect(result.repaired).toBe(1);
    const after = await db.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    // 持锁 2 保留；多出的 3 回收后退回可售（0 + 3 = 3）
    expect(after.lockedStock).toBe(2);
    expect(after.stock).toBe(3);
  });
});
