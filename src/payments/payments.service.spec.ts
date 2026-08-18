import { HttpException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { buildOrderTimeline } from '../common/order-state';
import { PaymentsService } from './payments.service';

/** 微信支付 env 门控（501 硬错误，无 mock 回退）+ 回调验签 + 超时关单（IK8W5I → ADR-0004）。 */
describe('payments wechat (IK8W5I)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new PaymentsService(db, business);
  let userId = '';
  let orderId = '';
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  const WX_KEYS = [
    'WX_APPID_USER',
    'WX_MCH_ID',
    'WX_APIV3_KEY',
    'WX_SERIAL_NO',
    'WX_PRIVATE_KEY_PATH',
    'WX_PRIVATE_KEY',
    'WX_NOTIFY_URL',
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const key of WX_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    const user = await db.user.create({
      data: {
        campusId: 'campus-hbut',
        nickname: '支付测试用户',
        phone: '13900000005',
        role: 'user',
      },
    });
    userId = user.id;
    const address = await db.address.findFirstOrThrow({
      where: { userId: 'user-001' },
    });
    const order = await db.order.create({
      data: {
        orderNo: `BCQPAY${Date.now()}${Math.random()
          .toString(36)
          .slice(2, 6)
          .toUpperCase()}`,
        userId,
        campusId: 'campus-hbut',
        status: 'pending-payment',
        statusText: '等待支付',
        address: json(address),
        deliveryMode: 'instant',
        items: json([]),
        productAmount: 12,
        totalQuantity: 1,
        deliveryThreshold: 10,
        deliveryFee: 2,
        discount: 0,
        payableAmount: 14,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json(buildOrderTimeline('西区 5 栋 612')),
      },
    });
    orderId = order.id;
  });

  afterAll(async () => {
    for (const [key, value] of saved) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await db.notification.deleteMany({ where: { userId } });
    await db.order.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
  });

  it('prepay returns 501 when WX_* merchant config missing (no mock fallback)', async () => {
    try {
      await service.prepay(userId, orderId);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(501);
      expect((error as HttpException).message).toContain('微信支付未配置');
    }
  });

  it('prepay rejects orders not pending payment (config present)', async () => {
    process.env.WX_APPID_USER = 'wx-spec';
    process.env.WX_MCH_ID = 'mch-spec';
    process.env.WX_APIV3_KEY = 'a'.repeat(32);
    process.env.WX_SERIAL_NO = 'serial-spec';
    process.env.WX_PRIVATE_KEY = 'dummy-key';
    process.env.WX_NOTIFY_URL = 'https://example.com/notify';
    try {
      await db.order.update({
        where: { id: orderId },
        data: { status: 'paid', statusText: '仓库正在接单', paidAt: new Date() },
      });
      await expect(service.prepay(userId, orderId)).rejects.toThrow(
        '当前状态不可支付',
      );
      await expect(service.prepay(userId, 'no-such-order')).rejects.toThrow(
        '订单不存在',
      );
    } finally {
      for (const key of WX_KEYS) delete process.env[key];
    }
  });

  it('status reports payment state', async () => {
    const result = await service.status(userId, orderId);
    expect(result.paid).toBe(true);
    expect(result.status).toBe('paid');
    await expect(service.status(userId, 'no-such-order')).rejects.toThrow(
      '订单不存在',
    );
  });

  it('notify returns 501 when merchant config missing', async () => {
    try {
      await service.notify({}, '', {});
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(501);
    }
  });

  it('notify rejects callbacks without signature headers (401, no network)', async () => {
    process.env.WX_APPID_USER = 'wx-spec';
    process.env.WX_MCH_ID = 'mch-spec';
    process.env.WX_APIV3_KEY = 'a'.repeat(32);
    process.env.WX_SERIAL_NO = 'serial-spec';
    process.env.WX_PRIVATE_KEY = 'dummy-key';
    process.env.WX_NOTIFY_URL = 'https://example.com/notify';
    try {
      await expect(service.notify({}, '{}', {})).rejects.toThrow(
        '回调缺少验签头',
      );
      // 时间戳超 5 分钟容差 → 防重放拒绝
      const stale = Math.floor(Date.now() / 1000) - 600;
      await expect(
        service.notify(
          {
            'wechatpay-signature': 'x',
            'wechatpay-timestamp': String(stale),
            'wechatpay-nonce': 'n',
            'wechatpay-serial': 's',
          },
          '{}',
          {},
        ),
      ).rejects.toThrow('回调时间戳超出容差');
    } finally {
      for (const key of WX_KEYS) delete process.env[key];
    }
  });

  it('timeout cron logic closes stale pending-payment orders conditionally', async () => {
    const stale = await db.order.create({
      data: {
        orderNo: `BCQSTALE${Date.now()}`,
        userId,
        campusId: 'campus-hbut',
        status: 'pending-payment',
        statusText: '等待支付',
        address: json({ buildingName: '西区 5 栋', floor: 6, room: '612' }),
        deliveryMode: 'instant',
        items: json([]),
        productAmount: 12,
        totalQuantity: 1,
        deliveryThreshold: 10,
        deliveryFee: 2,
        discount: 0,
        payableAmount: 14,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json(buildOrderTimeline('西区 5 栋 612')),
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
      },
    });
    // 复用 Cron 调的同一方法：全量扫超时单并条件关单。
    const closed = await business.expireAllPendingOrders();
    expect(closed).toBeGreaterThanOrEqual(1);
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: stale.id } })).status,
    ).toBe('cancelled');
    await db.order.delete({ where: { id: stale.id } });
  });
});
