import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from './notifications.service';
import { buildOrderTimeline } from '../common/order-state';

/**
 * IKPNZJ 微信小程序发货信息自动上报：payload 组装与凭证路由单测。
 * 微信端点全走 fetch 桩——只断言请求侧参数（order_key/logistics_type/
 * delivery_mode/shipping_list/upload_time/payer），不打真实微信接口。
 * 双组织矩阵：组织 B（Organization 行 7 字段齐备，独立商户号）vs 组织 A
 * （env 兜底，campus-hbut 现状）。上报商户号必须与收款同源——收款走
 * campusWechatConfig 严格 7 字段口径，组织 B 命中组织 mchId，组织 A 回落
 * env WX_MCH_ID，不许跨口径混搭。
 */
describe('upload shipping info by organization (IKPNZJ)', () => {
  const db = new PrismaService();
  const service = new NotificationsService(db);
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

  const ORG_B = {
    id: 'org-shipspec-b',
    appId: 'shipspec-app-b',
    secret: 'secret-ship-b',
    mchId: '1900000209',
    apiV3Key: 'b'.repeat(32),
    serialNo: 'serial-ship-b',
    privateKey: 'dummy-private-key-ship-b',
    notifyDomain: 'https://api-shipspec-b.example.com',
  };
  const ENV_A = {
    appId: 'shipspec-app-a',
    secret: 'secret-ship-a',
    mchId: '1900000201',
  };

  const WX_KEYS = [
    'WX_APPID_USER',
    'WX_SECRET_USER',
    'WX_MCH_ID',
    'WX_APIV3_KEY',
    'WX_SERIAL_NO',
    'WX_PRIVATE_KEY_PATH',
    'WX_PRIVATE_KEY',
    'WX_NOTIFY_URL',
  ] as const;
  const saved = new Map<string, string | undefined>();

  const realFetch = global.fetch;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  /** upload_shipping_info 桩返回体（用例内可改写模拟微信错误码）。 */
  let uploadReply: Record<string, unknown> = { errcode: 0, errmsg: 'ok' };
  const respond = (payload: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(payload), { status }));
  const bodyText = (init?: RequestInit) => (init?.body ?? '{}') as string;
  const stubFetch = () => {
    global.fetch = (
      url: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const u =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      calls.push({ url: u, init });
      if (u.includes('stable_token')) {
        const body = JSON.parse(bodyText(init)) as { appid?: string };
        return respond({
          access_token: `tok-${body.appid ?? 'none'}`,
          expires_in: 7200,
        });
      }
      if (u.includes('upload_shipping_info')) return respond(uploadReply);
      return respond({});
    };
  };
  const lastCall = (needle: string) =>
    [...calls].reverse().find((c) => c.url.includes(needle));

  let campusB = '';
  let userA = '';
  let userB = '';
  const orderIds: string[] = [];

  /** 造一笔「已出库」形态订单（package 已固化 lastMileMode），返回整行。 */
  const makeOrder = async (
    userId: string,
    campusId: string,
    extra: { lastMileMode?: string; items?: unknown },
  ) => {
    const row = await db.order.create({
      data: {
        orderNo: `BCQSHIP${Date.now()}${Math.random()
          .toString(36)
          .slice(2, 6)
          .toUpperCase()}`,
        userId,
        campusId,
        status: 'waiting-first-mile',
        statusText: '已出库，待配送员接单',
        address: json({ buildingName: '西区 5 栋', floor: 6, room: '612' }),
        deliveryMode: 'instant',
        items: json(extra.items ?? []),
        productAmount: 12,
        totalQuantity: 2,
        deliveryThreshold: 10,
        deliveryFee: 2,
        discount: 0,
        payableAmount: 14,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json(buildOrderTimeline('西区 5 栋 612')),
        package: json({
          id: 'PKG-SHIPSPEC',
          ...(extra.lastMileMode ? { lastMileMode: extra.lastMileMode } : {}),
        }),
      },
    });
    orderIds.push(row.id);
    return row;
  };

  beforeAll(async () => {
    for (const key of WX_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    stubFetch();
    await db.organization.create({
      data: {
        id: ORG_B.id,
        name: '发货上报测试组织B',
        shortName: '发货B',
        wxAppId: ORG_B.appId,
        wxSecret: ORG_B.secret,
        mchId: ORG_B.mchId,
        mchApiV3Key: ORG_B.apiV3Key,
        serialNo: ORG_B.serialNo,
        privateKey: ORG_B.privateKey,
        notifyDomain: ORG_B.notifyDomain,
      },
    });
    campusB = (
      await db.campus.create({
        data: {
          name: '发货上报测试校区',
          shortName: '发货校区',
          warehouseName: '发货测试仓',
          organizationId: ORG_B.id,
        },
      })
    ).id;
    userA = (
      await db.user.create({
        data: {
          campusId: 'campus-hbut',
          nickname: '发货上报用户A',
          phone: '13900000201',
          role: 'user',
          openid: 'openid-ship-a',
        },
      })
    ).id;
    userB = (
      await db.user.create({
        data: {
          campusId: campusB,
          nickname: '发货上报用户B',
          phone: '13900000202',
          role: 'user',
          openid: 'openid-ship-b',
        },
      })
    ).id;
  });

  afterAll(async () => {
    global.fetch = realFetch;
    for (const [key, value] of saved) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await db.campus.deleteMany({ where: { id: campusB } });
    await db.organization.deleteMany({ where: { id: ORG_B.id } });
    await db.$disconnect();
  });

  afterEach(() => {
    uploadReply = { errcode: 0, errmsg: 'ok' };
    calls.length = 0;
  });

  it('组织 B 订单（骑手配送）：组织 mchid + 组织 appid 换票，payload 全参数正确', async () => {
    process.env.WX_APPID_USER = ENV_A.appId;
    process.env.WX_SECRET_USER = ENV_A.secret;
    process.env.WX_MCH_ID = ENV_A.mchId;
    const order = await makeOrder(userB, campusB, {
      lastMileMode: 'building-manager',
      items: [
        { product: { name: '冰镇杨梅' }, quantity: 2 },
        { product: { name: '现磨豆浆' }, quantity: 1 },
      ],
    });
    await service.uploadShippingInfo({
      id: order.id,
      userId: userB,
      orderNo: order.orderNo,
      status: order.status,
      statusText: order.statusText,
      campusId: campusB,
    });
    // access_token 按组织 B appid 换票（分桶缓存 key=appid）
    const tokenBody = JSON.parse(bodyText(lastCall('stable_token')!.init)) as {
      appid?: string;
    };
    expect(tokenBody.appid).toBe(ORG_B.appId);
    const call = lastCall('upload_shipping_info')!;
    expect(call.url).toContain('access_token=tok-shipspec-app-b');
    const body = JSON.parse(bodyText(call.init)) as {
      order_key: {
        order_number_type: number;
        mchid: string;
        out_trade_no: string;
      };
      logistics_type: number;
      delivery_mode: number;
      shipping_list: Array<{ item_desc: string }>;
      upload_time: string;
      payer: { openid: string };
    };
    expect(body.order_key.order_number_type).toBe(1); // mchid+out_trade_no
    expect(body.order_key.mchid).toBe(ORG_B.mchId); // 组织商户号（收款同源）
    expect(body.order_key.out_trade_no).toBe(order.orderNo);
    expect(body.logistics_type).toBe(2); // 同城配送（骑手送寝室）
    expect(body.delivery_mode).toBe(1); // 统一发货
    expect(body.shipping_list[0].item_desc).toBe('冰镇杨梅*2个、现磨豆浆*1个');
    expect(body.payer.openid).toBe('openid-ship-b');
    // RFC3339（微信 268485216 校验），北京时间 +08:00 尾缀
    expect(body.upload_time).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/,
    );
  });

  it('组织 A 订单（无楼长自取）：env 凭证 + env mchid 兜底，logistics_type=4 用户自提', async () => {
    process.env.WX_APPID_USER = ENV_A.appId;
    process.env.WX_SECRET_USER = ENV_A.secret;
    process.env.WX_MCH_ID = ENV_A.mchId;
    const order = await makeOrder(userA, 'campus-hbut', {
      lastMileMode: 'customer-pickup',
      items: [{ product: { name: '手打柠檬茶' }, quantity: 1 }],
    });
    await service.uploadShippingInfo({
      id: order.id,
      userId: userA,
      orderNo: order.orderNo,
      status: order.status,
      statusText: order.statusText,
      campusId: 'campus-hbut',
    });
    const tokenBody = JSON.parse(bodyText(lastCall('stable_token')!.init)) as {
      appid?: string;
    };
    expect(tokenBody.appid).toBe(ENV_A.appId);
    const body = JSON.parse(
      bodyText(lastCall('upload_shipping_info')!.init),
    ) as {
      order_key: { mchid: string; out_trade_no: string };
      logistics_type: number;
      shipping_list: Array<{ item_desc: string }>;
      payer: { openid: string };
    };
    expect(body.order_key.mchid).toBe(ENV_A.mchId);
    expect(body.order_key.out_trade_no).toBe(order.orderNo);
    expect(body.logistics_type).toBe(4); // 用户自提（用户到楼下自取）
    expect(body.shipping_list[0].item_desc).toBe('手打柠檬茶*1个');
    expect(body.payer.openid).toBe('openid-ship-a');
  });

  it('item_desc 超 120 字截断（微信 10060009 拒收长文）', async () => {
    process.env.WX_APPID_USER = ENV_A.appId;
    process.env.WX_SECRET_USER = ENV_A.secret;
    process.env.WX_MCH_ID = ENV_A.mchId;
    const longName = '超长商品名测试'.repeat(30); // 210 字
    const order = await makeOrder(userA, 'campus-hbut', {
      lastMileMode: 'building-manager',
      items: [{ product: { name: longName }, quantity: 3 }],
    });
    await service.uploadShippingInfo({
      id: order.id,
      userId: userA,
      orderNo: order.orderNo,
      status: order.status,
      statusText: order.statusText,
      campusId: 'campus-hbut',
    });
    const body = JSON.parse(
      bodyText(lastCall('upload_shipping_info')!.init),
    ) as { shipping_list: Array<{ item_desc: string }> };
    expect(body.shipping_list[0].item_desc.length).toBe(120);
    expect(body.shipping_list[0].item_desc.endsWith('…')).toBe(true);
  });

  it.each([
    [10060002, '支付单已完成发货'],
    [10060003, '重新发货机会已用'],
    [10060023, '发货信息未更新'],
  ])('微信幂等错误 %s 不抛出、不重试', async (errcode) => {
    process.env.WX_APPID_USER = ENV_A.appId;
    process.env.WX_SECRET_USER = ENV_A.secret;
    process.env.WX_MCH_ID = ENV_A.mchId;
    const order = await makeOrder(userA, 'campus-hbut', {
      lastMileMode: 'building-manager',
    });
    uploadReply = { errcode, errmsg: 'idempotent-reject' };
    await expect(
      service.uploadShippingInfo({
        id: order.id,
        userId: userA,
        orderNo: order.orderNo,
        status: order.status,
        statusText: order.statusText,
        campusId: 'campus-hbut',
      }),
    ).resolves.toBeUndefined();
    expect(lastCall('upload_shipping_info')).toBeDefined();
  });

  it('其他微信错误（如 10060001 支付单不存在）同样不抛出（不阻断出库）', async () => {
    process.env.WX_APPID_USER = ENV_A.appId;
    process.env.WX_SECRET_USER = ENV_A.secret;
    process.env.WX_MCH_ID = ENV_A.mchId;
    const order = await makeOrder(userA, 'campus-hbut', {
      lastMileMode: 'building-manager',
    });
    uploadReply = { errcode: 10060001, errmsg: 'order not exist' };
    await expect(
      service.uploadShippingInfo({
        id: order.id,
        userId: userA,
        orderNo: order.orderNo,
        status: order.status,
        statusText: order.statusText,
        campusId: 'campus-hbut',
      }),
    ).resolves.toBeUndefined();
  });

  it('env 商户号缺失且组织未配置 → 跳过上报（不打微信）', async () => {
    delete process.env.WX_APPID_USER;
    delete process.env.WX_SECRET_USER;
    delete process.env.WX_MCH_ID;
    const order = await makeOrder(userA, 'campus-hbut', {
      lastMileMode: 'building-manager',
    });
    await service.uploadShippingInfo({
      id: order.id,
      userId: userA,
      orderNo: order.orderNo,
      status: order.status,
      statusText: order.statusText,
      campusId: 'campus-hbut',
    });
    expect(lastCall('upload_shipping_info')).toBeUndefined();
  });

  it('package 无 lastMileMode（历史单防御）→ 默认按同城配送（2）', async () => {
    process.env.WX_APPID_USER = ENV_A.appId;
    process.env.WX_SECRET_USER = ENV_A.secret;
    process.env.WX_MCH_ID = ENV_A.mchId;
    const order = await makeOrder(userA, 'campus-hbut', { items: [] });
    await service.uploadShippingInfo({
      id: order.id,
      userId: userA,
      orderNo: order.orderNo,
      status: order.status,
      statusText: order.statusText,
      campusId: 'campus-hbut',
    });
    const body = JSON.parse(
      bodyText(lastCall('upload_shipping_info')!.init),
    ) as {
      logistics_type: number;
      shipping_list: Array<{ item_desc: string }>;
    };
    expect(body.logistics_type).toBe(2);
    expect(body.shipping_list[0].item_desc).toBe('校园好物'); // 空商品兜底
  });
});
