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

  it('IK9SO7: 公钥模式 serial 与配置 ID 不一致仍选公钥验签，不回落平台证书', async () => {
    process.env.WX_APPID_USER = 'wx-spec';
    process.env.WX_MCH_ID = 'mch-spec';
    process.env.WX_APIV3_KEY = 'a'.repeat(32);
    process.env.WX_SERIAL_NO = 'serial-spec';
    process.env.WX_PRIVATE_KEY = 'dummy-key';
    process.env.WX_NOTIFY_URL = 'https://example.com/notify';
    // 真实格式 RSA 公钥（单行 \n 转义，与生产 .env 同形态）；
    // serial 故意配成另一个 PUB_KEY_ID_（模拟配置 ID 抄录有误）——
    // 选钥放行、验签本身失败 401，而不是回落平台证书模式打微信接口 502
    process.env.WX_WXPAY_PUBLIC_KEY =
      '-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxniefSmxedoL9lH/mUDS\\neT1Jqy0KLaTKKhCOPNruDVw+ov/nl4TPyfhH6/fGJowPgNh3PwnwwSS5wAxR1BUn\\nMDSOanircN8s59aB8p/Lhh3fxOG9iovcdwULumXvvkye3lxLro5fAFv3kW1wn8Ld\\nQu6drZ4iFUGFryxx2FFrUZTMMtBnJh8C6vrlGbukvrb+OC7uVkyHYh2Kq4t3rT1D\\nSo0F69VZHdLqBi8q6jjen/dg/zTocGO2imGqmVzjD2D+JKCiU2+K3VlTi+hBvUcZ\\nafnT1Fu3x14n0sB78h+z3jUpbTp83GPte5sm03D3TolplJd9bgF7DMofwRspBcrM\\nWwIDAQAB\\n-----END PUBLIC KEY-----\\n';
    process.env.WX_WXPAY_PUBLIC_KEY_ID = 'PUB_KEY_ID_configured';
    const savedKeys = ['WX_WXPAY_PUBLIC_KEY', 'WX_WXPAY_PUBLIC_KEY_ID'].map(
      (key) => [key, process.env[key]] as const,
    );
    try {
      const now = Math.floor(Date.now() / 1000);
      await expect(
        service.notify(
          {
            'wechatpay-signature': 'invalid-signature',
            'wechatpay-timestamp': String(now),
            'wechatpay-nonce': 'nonce-spec',
            'wechatpay-serial': 'PUB_KEY_ID_actual_from_wechat',
          },
          '{}',
          {},
        ),
      ).rejects.toThrow('回调验签失败');
    } finally {
      for (const [key, value] of savedKeys)
        if (value == null) delete process.env[key];
        else process.env[key] = value;
    }
  });

  it('notify freezes order to exception when pay() fails (G1 资损兜底)', async () => {
    process.env.WX_APPID_USER = 'wx-spec';
    process.env.WX_MCH_ID = 'mch-spec';
    process.env.WX_APIV3_KEY = 'a'.repeat(32);
    process.env.WX_SERIAL_NO = 'serial-spec';
    process.env.WX_PRIVATE_KEY = 'dummy-key';
    process.env.WX_NOTIFY_URL = 'https://example.com/notify';
    // 单测聚焦落账失败兜底：覆写私有方法跳过验签/解密（401 拒绝另有用例覆盖）
    const order = await db.order.create({
      data: {
        orderNo: `BCQG1${Date.now()}${Math.random()
          .toString(36)
          .slice(2, 6)
          .toUpperCase()}`,
        userId,
        campusId: 'campus-hbut',
        status: 'pending-payment',
        statusText: '等待支付',
        address: json({ buildingName: '西区 5 栋', floor: 6, room: '612' }),
        deliveryMode: 'instant',
        // 商品不存在 → pay() 库存校验抛错，模拟"扣款成功但落账失败"
        items: json([
          { product: { id: 'ghost-product', name: '幽灵商品', price: 1 }, quantity: 1 },
        ]),
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
    const stub = service as unknown as {
      verifyNotifySignature: () => Promise<void>;
      decryptResource: () => string;
    };
    stub.verifyNotifySignature = async () => {};
    stub.decryptResource = () =>
      JSON.stringify({
        out_trade_no: order.orderNo,
        transaction_id: 'wx-tid-g1',
        trade_state: 'SUCCESS',
      });
    try {
      const cbBody = { resource: { ciphertext: 'x', nonce: 'y' } };
      // 第一次回调：pay 抛错 → 转 exception + 站内通知
      const res = await service.notify({}, '{}', cbBody);
      expect(res.code).toBe('SUCCESS');
      const after = await db.order.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(after.status).toBe('exception');
      expect(after.statusText).toContain('联系客服');
      expect(
        await db.notification.count({
          where: { userId, title: '订单异常提醒' },
        }),
      ).toBe(1);
      // 微信重复回调：pay 仍抛错，但已是 exception → 幂等，不重复通知
      await service.notify({}, '{}', cbBody);
      expect(
        await db.notification.count({
          where: { userId, title: '订单异常提醒' },
        }),
      ).toBe(1);
    } finally {
      for (const key of WX_KEYS) delete process.env[key];
      await db.order.delete({ where: { id: order.id } });
    }
  });
});
