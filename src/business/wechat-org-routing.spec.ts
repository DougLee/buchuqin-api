import { generateKeyPairSync, createVerify, createCipheriv } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from './business.service';
import { PaymentsService } from '../payments/payments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { buildOrderTimeline } from '../common/order-state';
import { orgWechatConfig } from '../common/wechat-org';

/**
 * IKKRMT（ADR-0001 决策 1+2）：微信支付/退款/订阅消息按组织路由。
 * 双组织矩阵：组织 B（Organization 行 7 字段齐备，独立商户号+独立 AppID）
 * vs 组织 A（org-a 行未配，env 兜底）。全部微信调用走 fetch 桩——只断言
 * 请求侧的配置选取（appid/mchid/notify_url/签名钥/密钥路由），不打真实
 * 微信接口。
 */
describe('wechat routing by organization (IKKRMT)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new PaymentsService(db, business);
  const notifications = new NotificationsService(db);
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

  // 组织 B：行内齐备（私钥入库用单行 \n 转义形态，验证 normalizePem 还原）
  const { publicKey: orgBPublicKey, privateKey: orgBPrivateKey } =
    generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ORG_B = {
    id: 'org-wxspec-b',
    appId: 'wxspec-app-b',
    secret: 'secret-org-b',
    mchId: '1900000109',
    apiV3Key: 'b'.repeat(32),
    serialNo: 'serial-org-b',
    privateKeyEscaped: orgBPrivateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString()
      .replaceAll('\n', '\\n'),
    notifyDomain: 'https://api-orgb.example.com',
  };
  // 组织 A：env 兜底凭证（现状路径）
  const { publicKey: orgAPublicKey, privateKey: orgAPrivateKey } =
    generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ENV_A = {
    appId: 'wxspec-app-a',
    mchId: '1900000101',
    apiV3Key: 'a'.repeat(32),
    serialNo: 'serial-env-a',
    privateKey: orgAPrivateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    notifyUrl: 'https://api-orga.example.com/api/v1/payments/wechat/notify',
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
    'WX_TMPL_PAID',
    'WX_TMPL_DELIVERED',
  ] as const;
  const saved = new Map<string, string | undefined>();

  const realFetch = global.fetch;
  /** fetch 桩：记录全部请求（url+init），按微信端点返回可控行文。 */
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
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
      if (u.includes('/v3/pay/transactions/jsapi'))
        return respond({ prepay_id: 'prepay-spec-x' });
      if (u.includes('/v3/refund/domestic/refunds'))
        return respond({ refund_id: 'wx-refund-spec', status: 'SUCCESS' });
      if (u.includes('stable_token')) {
        const body = JSON.parse(bodyText(init)) as { appid?: string };
        return respond({
          access_token: `tok-${body.appid ?? 'none'}`,
          expires_in: 7200,
        });
      }
      if (u.includes('message/subscribe/send')) return respond({ errcode: 0 });
      return respond({});
    };
  };
  const lastCall = (needle: string) =>
    [...calls].reverse().find((c) => c.url.includes(needle));
  const authHeader = (c: { init?: RequestInit }) =>
    String((c.init?.headers as Record<string, string>)?.Authorization ?? '');

  let campusB = '';
  let userA = '';
  let userB = '';
  let orderA = '';
  let orderB = '';
  let refundB = '';

  const makeOrder = async (userId: string, campusId: string) =>
    (
      await db.order.create({
        data: {
          orderNo: `BCQWX${Date.now()}${Math.random()
            .toString(36)
            .slice(2, 6)
            .toUpperCase()}`,
          userId,
          campusId,
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
        },
      })
    ).id;

  const setEnvOrgA = () => {
    process.env.WX_APPID_USER = ENV_A.appId;
    process.env.WX_SECRET_USER = 'secret-env-a';
    process.env.WX_MCH_ID = ENV_A.mchId;
    process.env.WX_APIV3_KEY = ENV_A.apiV3Key;
    process.env.WX_SERIAL_NO = ENV_A.serialNo;
    process.env.WX_PRIVATE_KEY = ENV_A.privateKey;
    process.env.WX_PRIVATE_KEY_PATH = '';
    process.env.WX_NOTIFY_URL = ENV_A.notifyUrl;
    process.env.WX_TMPL_PAID = 'tmpl-paid-spec';
    process.env.WX_TMPL_DELIVERED = 'tmpl-delivered-spec';
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
        name: '微信路由测试组织B',
        shortName: '路由B',
        wxAppId: ORG_B.appId,
        wxSecret: ORG_B.secret,
        mchId: ORG_B.mchId,
        mchApiV3Key: ORG_B.apiV3Key,
        serialNo: ORG_B.serialNo,
        privateKey: ORG_B.privateKeyEscaped,
        notifyDomain: ORG_B.notifyDomain,
      },
    });
    campusB = (
      await db.campus.create({
        data: {
          name: '微信路由测试校区',
          shortName: '路由校区',
          warehouseName: '路由测试仓',
          organizationId: ORG_B.id,
        },
      })
    ).id;
    userA = (
      await db.user.create({
        data: {
          campusId: 'campus-hbut',
          nickname: '路由测试用户A',
          phone: '13900000101',
          role: 'user',
          openid: 'openid-spec-org-a',
        },
      })
    ).id;
    userB = (
      await db.user.create({
        data: {
          campusId: campusB,
          nickname: '路由测试用户B',
          phone: '13900000102',
          role: 'user',
          openid: 'openid-spec-org-b',
        },
      })
    ).id;
    orderA = await makeOrder(userA, 'campus-hbut');
    orderB = await makeOrder(userB, campusB);
    refundB = (
      await db.refund.create({
        data: { userId: userB, orderId: orderB, amount: 10 },
      })
    ).id;
  });

  afterAll(async () => {
    global.fetch = realFetch;
    for (const [key, value] of saved) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await db.notification.deleteMany({
      where: { userId: { in: [userA, userB] } },
    });
    await db.refund.deleteMany({ where: { id: refundB } });
    await db.commission.deleteMany({
      where: { orderId: { in: [orderA, orderB] } },
    });
    await db.order.deleteMany({ where: { id: { in: [orderA, orderB] } } });
    await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await db.campus.deleteMany({ where: { id: campusB } });
    await db.organization.deleteMany({ where: { id: ORG_B.id } });
    await db.$disconnect();
  });

  describe('orgWechatConfig 配置选取', () => {
    it('组织行 7 字段齐备 → 组织配置（私钥 \n 转义还原，回调 URL 拼全局前缀）', async () => {
      const cfg = await orgWechatConfig(db, ORG_B.id);
      expect(cfg).not.toBeNull();
      expect(cfg!.appId).toBe(ORG_B.appId);
      expect(cfg!.mchId).toBe(ORG_B.mchId);
      expect(cfg!.apiV3Key).toBe(ORG_B.apiV3Key);
      expect(cfg!.serialNo).toBe(ORG_B.serialNo);
      expect(cfg!.privateKey).toContain('\n-----END PRIVATE KEY-----');
      expect(cfg!.notifyUrl).toBe(
        `${ORG_B.notifyDomain}/api/v1/payments/wechat/notify`,
      );
    });

    it('任一字段缺失 / 组织 A 未配置 / 组织不存在 / 空参 → null（回落 env）', async () => {
      await db.organization.update({
        where: { id: ORG_B.id },
        data: { notifyDomain: null },
      });
      try {
        expect(await orgWechatConfig(db, ORG_B.id)).toBeNull();
      } finally {
        await db.organization.update({
          where: { id: ORG_B.id },
          data: { notifyDomain: ORG_B.notifyDomain },
        });
      }
      // 组织 A 现状：org-a 存在但微信字段全空
      expect(await orgWechatConfig(db, 'org-a')).toBeNull();
      expect(await orgWechatConfig(db, 'org-no-such')).toBeNull();
      expect(await orgWechatConfig(db, null)).toBeNull();
      expect(await orgWechatConfig(db, '  ')).toBeNull();
    });
  });

  describe('prepay 支付路由（微信调用全桩）', () => {
    it('组织 B 订单：AppID/商户号/notify_url/签名钥全部取组织行配置', async () => {
      setEnvOrgA(); // env 也在场——必须仍选组织 B（组织行优先）
      try {
        const res = await service.prepay(userB, orderB);
        const call = lastCall('/v3/pay/transactions/jsapi')!;
        const body = JSON.parse(bodyText(call.init)) as {
          appid: string;
          mchid: string;
          notify_url: string;
        };
        expect(body.appid).toBe(ORG_B.appId);
        expect(body.mchid).toBe(ORG_B.mchId);
        expect(body.notify_url).toBe(
          `${ORG_B.notifyDomain}/api/v1/payments/wechat/notify`,
        );
        expect(authHeader(call)).toContain(`mchid="${ORG_B.mchId}"`);
        expect(authHeader(call)).toContain(`serial_no="${ORG_B.serialNo}"`);
        // 组织 B 订单：env 模板属于组织 A 小程序，下发空数组（前端静默跳过授权）
        expect(res.subscribeTemplates).toEqual([]);
        // paySign 用组织 B 商户证书签——组织 B 公钥可验
        const {
          appId,
          timeStamp,
          nonceStr,
          package: pkg,
          paySign,
        } = res.payParams;
        expect(appId).toBe(ORG_B.appId);
        const verifier = createVerify('RSA-SHA256');
        verifier.update(`${appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`);
        expect(verifier.verify(orgBPublicKey, paySign, 'base64')).toBe(true);
      } finally {
        for (const key of WX_KEYS) delete process.env[key];
      }
    });

    it('组织 B 行配置不齐 → 整套回落 env（不混搭）', async () => {
      setEnvOrgA();
      await db.organization.update({
        where: { id: ORG_B.id },
        data: { mchId: null },
      });
      try {
        await service.prepay(userB, orderB);
        const call = lastCall('/v3/pay/transactions/jsapi')!;
        const body = JSON.parse(bodyText(call.init)) as {
          appid: string;
          mchid: string;
          notify_url: string;
        };
        expect(body.appid).toBe(ENV_A.appId);
        expect(body.mchid).toBe(ENV_A.mchId);
        expect(body.notify_url).toBe(ENV_A.notifyUrl);
      } finally {
        for (const key of WX_KEYS) delete process.env[key];
        await db.organization.update({
          where: { id: ORG_B.id },
          data: { mchId: ORG_B.mchId },
        });
      }
    });

    it('组织 A 订单：env 路径一字不变（appid/商户号/notify_url/模板/签名钥）', async () => {
      setEnvOrgA();
      try {
        const res = await service.prepay(userA, orderA);
        const call = lastCall('/v3/pay/transactions/jsapi')!;
        const body = JSON.parse(bodyText(call.init)) as {
          appid: string;
          mchid: string;
          notify_url: string;
        };
        expect(body.appid).toBe(ENV_A.appId);
        expect(body.mchid).toBe(ENV_A.mchId);
        expect(body.notify_url).toBe(ENV_A.notifyUrl);
        expect(authHeader(call)).toContain(`mchid="${ENV_A.mchId}"`);
        expect(res.subscribeTemplates).toEqual([
          'tmpl-paid-spec',
          'tmpl-delivered-spec',
        ]);
        const {
          appId,
          timeStamp,
          nonceStr,
          package: pkg,
          paySign,
        } = res.payParams;
        const verifier = createVerify('RSA-SHA256');
        verifier.update(`${appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`);
        expect(verifier.verify(orgAPublicKey, paySign, 'base64')).toBe(true);
      } finally {
        for (const key of WX_KEYS) delete process.env[key];
      }
    });

    it('env 不齐且未命中组织配置 → 501（组织 A 现状硬错误不变）', async () => {
      await db.organization.update({
        where: { id: ORG_B.id },
        data: { notifyDomain: null },
      });
      try {
        await expect(service.prepay(userB, orderB)).rejects.toThrow(
          '微信支付未配置',
        );
      } finally {
        await db.organization.update({
          where: { id: ORG_B.id },
          data: { notifyDomain: ORG_B.notifyDomain },
        });
      }
    });
  });

  describe('退款路由（applyWechatRefund / queryWechatRefund）', () => {
    it('按原订单所属组织取商户凭证（不接受请求参数切换）', async () => {
      setEnvOrgA();
      try {
        const orderNo = (
          await db.order.findUniqueOrThrow({ where: { id: orderB } })
        ).orderNo;
        const applied = await service.applyWechatRefund(
          orderNo,
          1400,
          500,
          refundB,
          '路由测试退款',
        );
        expect(applied.refundId).toBe('wx-refund-spec');
        // POST /v3/refund/domestic/refunds：鉴权头为组织 B 商户号
        const post = lastCall('/v3/refund/domestic/refunds')!;
        expect(post.init!.method).toBe('POST');
        expect(authHeader(post)).toContain(`mchid="${ORG_B.mchId}"`);
        expect(authHeader(post)).toContain(`serial_no="${ORG_B.serialNo}"`);

        const queried = await service.queryWechatRefund(refundB);
        expect(queried.status).toBe('SUCCESS');
        // GET /v3/refund/domestic/refunds/:id：同样走组织 B 商户号
        const get = lastCall(`/v3/refund/domestic/refunds/${refundB}`)!;
        expect(get.init?.method).toBeUndefined(); // GET 缺省
        expect(authHeader(get)).toContain(`mchid="${ORG_B.mchId}"`);
      } finally {
        for (const key of WX_KEYS) delete process.env[key];
      }
    });

    it('组织 A 退款：env 商户号（回归）', async () => {
      setEnvOrgA();
      try {
        const orderNo = (
          await db.order.findUniqueOrThrow({ where: { id: orderA } })
        ).orderNo;
        await service.applyWechatRefund(
          orderNo,
          1400,
          500,
          'refund-env-a-spec',
          '测试',
        );
        const call = lastCall('/v3/refund/domestic/refunds')!;
        expect(authHeader(call)).toContain(`mchid="${ENV_A.mchId}"`);
      } finally {
        for (const key of WX_KEYS) delete process.env[key];
      }
    });
  });

  describe('回调解密密钥路由（notify）', () => {
    /** 用指定 APIv3 密钥按微信 v3 回调形态加密 event（AES-256-GCM）。 */
    const encryptEvent = (apiV3Key: string, event: object) => {
      const nonce = 'n'.repeat(12);
      const cipher = createCipheriv(
        'aes-256-gcm',
        Buffer.from(apiV3Key, 'utf8'),
        Buffer.from(nonce, 'utf8'),
      );
      cipher.setAAD(Buffer.from('transaction', 'utf8'));
      const data = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(event), 'utf8')),
        cipher.final(),
      ]);
      return {
        ciphertext: Buffer.concat([data, cipher.getAuthTag()]).toString(
          'base64',
        ),
        nonce,
        associated_data: 'transaction',
      };
    };
    const stubVerify = () => {
      (
        service as unknown as { verifyNotifySignature: () => Promise<void> }
      ).verifyNotifySignature = async () => {};
    };

    it('env 键解不开时遍历组织键命中组织 B 密钥 → 落账成功', async () => {
      setEnvOrgA(); // env APIv3Key='a'*32（错钥）→ 组织 B 密钥兜底命中
      stubVerify();
      try {
        const orderNo = (
          await db.order.findUniqueOrThrow({ where: { id: orderB } })
        ).orderNo;
        const res = await service.notify({}, '{}', {
          resource: encryptEvent(ORG_B.apiV3Key, {
            appid: ORG_B.appId,
            mchid: ORG_B.mchId,
            out_trade_no: orderNo,
            transaction_id: 'wx-tid-org-b',
            trade_state: 'SUCCESS',
          }),
        });
        expect(res.code).toBe('SUCCESS');
        expect(
          (await db.order.findUniqueOrThrow({ where: { id: orderB } })).status,
        ).toBe('paid');
      } finally {
        for (const key of WX_KEYS) delete process.env[key];
        await db.order.update({
          where: { id: orderB },
          data: {
            status: 'pending-payment',
            statusText: '等待支付',
            paidAt: null,
          },
        });
      }
    });

    it('组织 A 回调：env 键第一顺位命中（回归）', async () => {
      setEnvOrgA();
      stubVerify();
      try {
        const orderNo = (
          await db.order.findUniqueOrThrow({ where: { id: orderA } })
        ).orderNo;
        const res = await service.notify({}, '{}', {
          resource: encryptEvent(ENV_A.apiV3Key, {
            appid: ENV_A.appId,
            mchid: ENV_A.mchId,
            out_trade_no: orderNo,
            transaction_id: 'wx-tid-org-a',
            trade_state: 'SUCCESS',
          }),
        });
        expect(res.code).toBe('SUCCESS');
        expect(
          (await db.order.findUniqueOrThrow({ where: { id: orderA } })).status,
        ).toBe('paid');
      } finally {
        for (const key of WX_KEYS) delete process.env[key];
      }
    });

    it('全部候选键均未命中 → 401 拒收（不误落账）', async () => {
      setEnvOrgA();
      stubVerify();
      try {
        const orderNo = (
          await db.order.findUniqueOrThrow({ where: { id: orderA } })
        ).orderNo;
        await expect(
          service.notify({}, '{}', {
            resource: encryptEvent('c'.repeat(32), {
              out_trade_no: orderNo,
              trade_state: 'SUCCESS',
            }),
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(
          (await db.order.findUniqueOrThrow({ where: { id: orderA } })).status,
        ).toBe('paid'); // 前一用例已支付，本次绝不能再动账
      } finally {
        for (const key of WX_KEYS) delete process.env[key];
      }
    });
  });

  describe('access_token 缓存按 appid 隔离（订阅消息）', () => {
    const tokenFetches = () =>
      calls.filter((c) => c.url.includes('stable_token')).length;

    it('不同 appid 各自缓存互不驱逐；同 appid 命中缓存不再拉票', async () => {
      const before = tokenFetches();
      const t1 = await (
        notifications as unknown as {
          wechatAccessToken: (a?: string, s?: string) => Promise<string>;
        }
      ).wechatAccessToken('wxspec-tok-a', 's-a');
      const t2 = await (
        notifications as unknown as {
          wechatAccessToken: (a?: string, s?: string) => Promise<string>;
        }
      ).wechatAccessToken('wxspec-tok-a', 's-a'); // 命中缓存
      const t3 = await (
        notifications as unknown as {
          wechatAccessToken: (a?: string, s?: string) => Promise<string>;
        }
      ).wechatAccessToken('wxspec-tok-b', 's-b'); // 新 appid 新票
      expect(t1).toBe('tok-wxspec-tok-a');
      expect(t2).toBe('tok-wxspec-tok-a');
      expect(t3).toBe('tok-wxspec-tok-b');
      expect(tokenFetches() - before).toBe(2); // a 拉一次、b 拉一次，a 复用缓存
    });

    it('组织 A env 单 key 等价：缺省参走 env 凭证', async () => {
      setEnvOrgA();
      try {
        const t = await (
          notifications as unknown as {
            wechatAccessToken: (a?: string, s?: string) => Promise<string>;
          }
        ).wechatAccessToken();
        expect(t).toBe(`tok-${ENV_A.appId}`);
      } finally {
        for (const key of WX_KEYS) delete process.env[key];
      }
    });

    it('组织 B 订单订阅消息用组织凭证取票（模板 env 门控不变，静默降级）', async () => {
      setEnvOrgA();
      try {
        // 订单 B 已在上一批用例转 paid——orderStatusPush('paid') 走组织 B 凭证
        await notifications.orderStatusPush({
          id: orderB,
          userId: userB,
          orderNo: (await db.order.findUniqueOrThrow({ where: { id: orderB } }))
            .orderNo,
          status: 'paid',
          statusText: '支付成功',
          payableAmount: 14,
        });
        const tokenCall = lastCall('stable_token')!;
        const tokenBody = JSON.parse(bodyText(tokenCall.init)) as {
          appid?: string;
          secret?: string;
        };
        expect(tokenBody.appid).toBe(ORG_B.appId);
        expect(tokenBody.secret).toBe(ORG_B.secret);
        // 发送用的票来自组织 B appid 的缓存桶
        const send = lastCall('message/subscribe/send')!;
        expect(send.url).toContain(`access_token=tok-${ORG_B.appId}`);
      } finally {
        for (const key of WX_KEYS) delete process.env[key];
      }
    });
  });
});
