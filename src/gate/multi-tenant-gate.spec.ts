import { generateKeyPairSync } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import type { CreateAddressDto, CreateOrderDto } from '../business/dto';
import { AdminController } from '../admin/admin.controller';
import { AdminService } from '../admin/admin.service';
import { RbacService } from '../admin/rbac/rbac.service';
import type { RbacContext } from '../admin/rbac/rbac.service';
import { AuthController } from '../auth/auth.controller';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { PaymentsService } from '../payments/payments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { buildOrderTimeline } from '../common/order-state';
import { marketingEnabled } from '../common/capability';
import {
  campusOrganizationId,
  resolveOrganizationByAppId,
} from '../common/organization';

/**
 * ============================================================================
 * GATE：多租户发布门禁（IKKRN0）——本套件失败 = 多租户功能不可上线。
 * ============================================================================
 *
 * 门禁语义（钉死）：
 * - 覆盖 IKKRMO~IKKRMU 全部多租户 issue 的**跨issue组合验收**：单 issue
 *   spec 各自过≠组合无回归，本套件按「组织 A 兼容 × 组织 B 独立 × 双组织
 *   对抗」三视角纵向抽验核心链路，任何一条失败都意味着隔离墙或兼容契约
 *   被击穿，禁止发布。
 * - 组织 A 兼容回归是重中之重：旧小程序（env 单组织配置、零 AppID 登记、
 *   零改动）必须在新代码上行为一字不变——wehat-login 兼容路径、支付参数
 *   全走 env、订阅消息单 key、骑手任务池、null capabilities 营销全开。
 * - 迁移对账（GATE 4）为 fixture 外只读检查，防「迁移漏回填/误归属」。
 *
 * 隔离拒绝口径：跨组织资源 ID 交叉读写一律拒绝——不存在的资源视角 404
 * （商品/订单按属主+校区/用户过滤），非法参数 400（跨组织校区/券），越权
 * 403（后台组织边界）。issue 原文「全 403/404」按各域现行拒绝语义落实，
 * 本质门槛=跨组织读写绝无成功路径。
 *
 * IKKRMV（fulfillment/deliveryMode 改造）并行开发注意：GATE 3 配送段以
 * 编写时工作区现状为基底（instant 全链：advance→grab→depart→arrive→
 * receive→delivered→confirmReceipt）。IKKRMV 合入若改变状态机/动作语义，
 * 必须同步更新本段断言（按新语义重写），不得删除门禁断言或跳过整段。
 */

describe('GATE: dual-org isolation & legacy-miniprogram compatibility (IKKRN0)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const admin = new AdminService(db, business);
  const rbac = new RbacService(db);
  const controller = new AdminController(admin, rbac);
  const auth = new AuthController(
    new JwtService({ secret: 'test-secret' }),
    db,
    business,
    rbac,
    new NotificationsService(db),
  );
  const payments = new PaymentsService(db, business);
  const fulfillment = new FulfillmentService(db);
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

  /* ============================== fixture 常量 ============================== */

  const tag = `gate${Date.now().toString(36)}`;
  const ORG_A = 'org-a'; // 存量基线（IKKRMM 迁移预置，不重建）
  const CAMPUS_A = 'campus-hbut'; // 组织 A 主校区（存量）
  const ORG_B = `org-gate-b-${tag}`;
  const ORG_B_APPID = `wx-gate-b-user-${tag}`;
  const CAMPUS_B1 = `campus-gate-b1-${tag}`;
  const CAMPUS_B2 = `campus-gate-b2-${tag}`;
  const ROLE_CODE = `spec-gate-${tag}`;
  // 组织 A env 兼容凭证（未登记任何 Organization.wxAppId——旧小程序现状）；
  // env 私钥用真实 RSA 对（假 PEM 会在 prepay 商户签名处抛错）
  const ENV_A_APPID = `wx-gate-a-${tag}`;
  const { privateKey: envAPrivateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  // 组织 B 微信支付行内配置（7 字段齐备，独立商户号+独立回调域名）
  const { privateKey: orgBPrivateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const ORG_B_WX = {
    mchId: '1900000209',
    apiV3Key: 'g'.repeat(32),
    serialNo: `serial-gate-b-${tag}`,
    privateKeyEscaped: orgBPrivateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString()
      .replaceAll('\n', '\\n'),
    notifyDomain: 'https://api-gate-b.example.com',
  };

  /* ============================ 共享资源登记（清理用） ============================ */

  const userIds: string[] = [];
  const staffIds: string[] = [];
  const buildingIds: string[] = [];
  const orderIds: string[] = [];
  const couponIds: string[] = [];
  const productIds: string[] = [];
  const categoryIds: string[] = [];
  const accountIds: string[] = [];
  const usernames = [`gate_orgb_${tag}`, `gate_orga_${tag}`];

  /* ============================== env / fetch 桩 ============================== */

  const ENV_KEYS = [
    'WX_APPID',
    'WX_SECRET',
    'WX_APPID_USER',
    'WX_SECRET_USER',
    'WX_APPID_DELIVERY',
    'WX_SECRET_DELIVERY',
    'WX_MCH_ID',
    'WX_APIV3_KEY',
    'WX_SERIAL_NO',
    'WX_PRIVATE_KEY_PATH',
    'WX_PRIVATE_KEY',
    'WX_NOTIFY_URL',
    'WX_TMPL_PAID',
    'WX_TMPL_DELIVERED',
  ] as const;
  const savedEnv = new Map<string, string | undefined>();
  const realFetch = global.fetch;
  /** fetch 桩：记录请求按端点回可控包（code2session 按 js_code 查映射回 openid）。 */
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const bodyText = (init?: RequestInit) => (init?.body ?? '{}') as string;
  const lastCall = (needle: string) =>
    [...calls].reverse().find((c) => c.url.includes(needle));
  /** code2session 桩映射：code → openid（登录用例先注册再发起）。 */
  const sessionByCode = new Map<string, string>();
  const mockFetch = () => {
    global.fetch = (
      url: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const u =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      calls.push({ url: u, init });
      const respond = (payload: unknown, status = 200) =>
        Promise.resolve(new Response(JSON.stringify(payload), { status }));
      if (u.includes('code2session')) {
        const code = new URL(u).searchParams.get('js_code') ?? '';
        return respond({ openid: sessionByCode.get(code) });
      }
      const body = JSON.parse(bodyText(init)) as { appid?: string };
      if (u.includes('/v3/pay/transactions/jsapi'))
        return respond({ prepay_id: 'prepay-gate-x' });
      if (u.includes('stable_token'))
        return respond({
          access_token: `tok-${body.appid ?? 'gate'}`,
          expires_in: 7200,
        });
      if (u.includes('message/subscribe/send')) return respond({ errcode: 0 });
      return respond({});
    };
  };

  /** 从登录响应 token 解出 userId（兼作 claims.role 回归断言输入）。 */
  const jwtClaims = (token: string) =>
    new JwtService({ secret: 'test-secret' }).verify<{
      id: string;
      campusId: string;
      role: string;
    }>(token);

  /** 直建订单（对抗 fixture：只需行存在，不走交易链路）。 */
  const makeOrder = async (
    userId: string,
    campusId: string,
    status = 'paid',
  ) => {
    const order = await db.order.create({
      data: {
        orderNo: `BCQGT${Date.now()}${Math.random()
          .toString(36)
          .slice(2, 6)
          .toUpperCase()}`,
        userId,
        campusId,
        status,
        statusText: '门禁直建测试单',
        address: json({
          buildingName: `${tag} 直建楼`,
          floor: 1,
          room: '101',
          campusId,
        }),
        deliveryMode: 'instant',
        items: json([]),
        productAmount: 1200,
        totalQuantity: 1,
        deliveryThreshold: 1000,
        deliveryFee: 200,
        discount: 0,
        payableAmount: 1400,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json(buildOrderTimeline(`${tag} 直建楼 101`)),
      },
    });
    orderIds.push(order.id);
    return order;
  };

  /** 建一套可交易商品（pay 的成本快照要求可推导：procurementMode=HQ+批发价）。 */
  const makeProduct = async (
    campusId: string,
    categoryId: string,
    label: string,
  ) => {
    const product = await db.product.create({
      data: {
        campusId,
        categoryId,
        name: `${label}-${tag}`,
        subtitle: '门禁 fixture',
        price: 1200,
        originalPrice: 1500,
        costPrice: 0,
        wholesalePrice: 600,
        procurementMode: 'HQ',
        unitsPerCase: 1,
        stock: 50,
        tag: '',
        image: '',
        weight: 0.5,
        status: 'on-sale',
      },
    });
    productIds.push(product.id);
    return product;
  };

  const makeCoupon = async (campusId: string, label: string) => {
    const coupon = await db.coupon.create({
      data: {
        campusId,
        name: `${label}-${tag}`,
        amount: 300,
        threshold: 1000,
        total: 100,
        status: 'active',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    });
    couponIds.push(coupon.id);
    return coupon;
  };

  /* ============================== fixture 主体 ============================== */

  let ready = false;
  let userA1 = ''; // 组织 A 对抗用户（直建，campus-hbut）
  let userB1 = ''; // 组织 B 对抗用户（直建，campus-b1）
  let productA = '';
  let productB = '';
  let couponA = '';
  let couponB = '';
  let orderA = ''; // 组织 A 直建单（对抗靶）
  let orderB = ''; // 组织 B 直建单（对抗靶）
  let orgBCampusCtx!: RbacContext; // 组织 B 后台 org 级账号
  let orgACampusCtx!: RbacContext; // 组织 A 后台校区级账号（历史口径）

  /** 以真实 getEffective 结果构造后台请求夹具（守卫等价：ctx 挂 req.rbac）。 */
  const reqOf = (
    ctx: RbacContext,
    query: Record<string, string> = {},
  ): AuthRequest =>
    ({
      rbac: ctx,
      query,
      user: { id: ctx.accountId, campusId: ctx.campusId },
    }) as unknown as AuthRequest;

  const ensureFixture = async () => {
    if (ready) return;
    // 组织 B：登记 wxAppId（用户端小程序）+ 微信支付 7 字段 + 营销能力白名单
    await db.organization.create({
      data: {
        id: ORG_B,
        name: '门禁组织B',
        shortName: '门禁B',
        wxAppId: ORG_B_APPID,
        wxSecret: `secret-${tag}`,
        mchId: ORG_B_WX.mchId,
        mchApiV3Key: ORG_B_WX.apiV3Key,
        serialNo: ORG_B_WX.serialNo,
        privateKey: ORG_B_WX.privateKeyEscaped,
        notifyDomain: ORG_B_WX.notifyDomain,
        capabilities: json(['marketing']),
      },
    });
    for (const [id, name] of [
      [CAMPUS_B1, '门禁B一大学'],
      [CAMPUS_B2, '门禁B二大学'],
    ] as const) {
      await db.campus.create({
        data: {
          id,
          name,
          shortName: name,
          warehouseName: `${name}仓`,
          organizationId: ORG_B,
        },
      });
    }
    // 两侧可交易资源：分类/商品/券（组织 A 侧落存量主校区 campus-hbut）
    for (const [campusId, prefix] of [
      [CAMPUS_A, 'a'],
      [CAMPUS_B1, 'b'],
    ] as const) {
      const category = await db.category.create({
        data: { campusId, name: `门禁分类${prefix}-${tag}` },
      });
      categoryIds.push(category.id);
    }
    productA = (await makeProduct(CAMPUS_A, categoryIds[0], '门禁商品A')).id;
    productB = (await makeProduct(CAMPUS_B1, categoryIds[1], '门禁商品B')).id;
    couponA = (await makeCoupon(CAMPUS_A, '门禁券A')).id;
    couponB = (await makeCoupon(CAMPUS_B1, '门禁券B')).id;
    // 对抗用户与订单
    userA1 = (
      await db.user.create({
        data: {
          campusId: CAMPUS_A,
          nickname: `门禁对抗A-${tag}`,
          phone: '',
          role: 'user',
        },
      })
    ).id;
    userIds.push(userA1);
    userB1 = (
      await db.user.create({
        data: {
          campusId: CAMPUS_B1,
          nickname: `门禁对抗B-${tag}`,
          phone: '',
          role: 'user',
        },
      })
    ).id;
    userIds.push(userB1);
    orderA = (await makeOrder(userA1, CAMPUS_A)).id;
    orderB = (await makeOrder(userB1, CAMPUS_B1)).id;
    // 组织 B 履约员工（配送全链用）：骑手 + 与订单同楼栋的楼长。
    // 楼长 buildingId 走真实 Building 行（外键）——addAddress 按校区+楼栋名
    // 自动匹配同一行，isOwnBuilding 以 buildingId 优先比对，闭环一致。
    const gateBuilding = await db.building.create({
      data: { campusId: CAMPUS_B1, name: `${tag}B1栋` },
    });
    buildingIds.push(gateBuilding.id);
    for (const [role, staffNo] of [
      ['fulltime-rider', `gate-rider-${tag}`],
      ['building-manager', `gate-bm-${tag}`],
    ] as const) {
      const staff = await db.staff.create({
        data: {
          campusId: CAMPUS_B1,
          staffNo,
          name: staffNo,
          role,
          roleText: role === 'fulltime-rider' ? '全职配送员' : '楼长',
          building: `${tag}B1栋`,
          buildingId: gateBuilding.id,
          onTimeRate: '100.00',
          income: 0,
        },
      });
      staffIds.push(staff.id);
    }
    // 后台对抗账号：组织 B org 级 vs 组织 A 校区级（历史账号口径）
    await db.rbacState.upsert({
      where: { id: 'global' },
      update: {},
      create: { id: 'global', version: 0 },
    });
    const role = await db.adminRole.upsert({
      where: { code: ROLE_CODE },
      update: {},
      create: {
        code: ROLE_CODE,
        name: '门禁测试角色',
        seeded: true,
        menusMigrated: true,
      },
    });
    const mkAccount = (
      username: string,
      data: { campusId: string; orgLevel?: string; organizationId?: string },
    ) =>
      db.$transaction(async (tx) => {
        const acc = await tx.adminAccount.create({
          data: {
            username,
            passwordHash: 'x',
            role: 'rbac',
            rbacMigrated: true,
            ...data,
          },
        });
        await tx.adminAccountRole.create({
          data: {
            accountId: acc.id,
            roleId: role.id,
            scope: 'campus',
            campusId: data.campusId,
            grantedBy: 'gate-spec',
          },
        });
        return acc;
      });
    accountIds.push(
      (
        await mkAccount(usernames[0], {
          campusId: CAMPUS_B1,
          orgLevel: 'org',
          organizationId: ORG_B,
        })
      ).id,
    );
    accountIds.push((await mkAccount(usernames[1], { campusId: CAMPUS_A })).id);
    orgBCampusCtx = await rbac.getEffective(
      await db.adminAccount.findUniqueOrThrow({
        where: { username: usernames[0] },
      }),
    );
    orgACampusCtx = await rbac.getEffective(
      await db.adminAccount.findUniqueOrThrow({
        where: { username: usernames[1] },
      }),
    );
    ready = true;
  };

  beforeAll(() => {
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    mockFetch();
  });

  afterAll(async () => {
    global.fetch = realFetch;
    for (const [key, value] of savedEnv) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await db.notification.deleteMany({
      where: { userId: { in: userIds } },
    });
    await db.refund.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.afterSale.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.commission.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.userCoupon.deleteMany({
      where: { userId: { in: userIds } },
    });
    await db.cartItem.deleteMany({ where: { userId: { in: userIds } } });
    await db.address.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.staff.deleteMany({ where: { id: { in: staffIds } } });
    await db.building.deleteMany({ where: { id: { in: buildingIds } } });
    await db.coupon.deleteMany({ where: { id: { in: couponIds } } });
    await db.product.deleteMany({ where: { id: { in: productIds } } });
    await db.category.deleteMany({ where: { id: { in: categoryIds } } });
    await db.adminAccount.deleteMany({ where: { id: { in: accountIds } } });
    await db.adminAccount.deleteMany({
      where: { username: { in: usernames } },
    });
    await db.adminRole.deleteMany({ where: { code: ROLE_CODE } });
    await db.campus.deleteMany({
      where: { id: { in: [CAMPUS_B1, CAMPUS_B2] } },
    });
    await db.organization.deleteMany({ where: { id: ORG_B } });
    await db.$disconnect();
  });

  /* ==========================================================================
   * GATE 4：迁移对账（fixture 外只读检查——本段必须最先跑，此时双组织
   * fixture 尚未建立，断言对象=库里存量数据，防迁移漏回填/误归属。
   * ========================================================================== */
  describe('GATE 4 迁移对账：组织 A 校区回填 + campus-official 平台层', () => {
    it('平台层钉死：campus-official 永不归属组织（organizationId 空 + official 状态）', async () => {
      const official = await db.campus.findUnique({
        where: { id: 'campus-official' },
      });
      expect(official).not.toBeNull();
      expect(official!.status).toBe('official');
      expect(official!.organizationId ?? null).toBeNull();
    });

    it('组织 A 回填锚点：主校区 campus-hbut 与总部仓 campus-hq 均 organizationId=org-a', async () => {
      expect(await campusOrganizationId(db, 'campus-hbut')).toBe('org-a');
      expect(await campusOrganizationId(db, 'campus-hq')).toBe('org-a');
    });

    it('全量对账：迁移存量真实校区不存在「漏回填」空归属', async () => {
      const active = await db.campus.findMany({
        where: { type: 'campus', status: 'active' },
        select: { id: true, organizationId: true },
      });
      // 迁移存量口径（IKKRMM 回填 SQL 的 WHERE=id<>'campus-official' 全量）：
      // 一段式 id（campus-<name>，如 campus-hbut）=迁移前预置形态，必须
      // 归属 org-a；多段式 id（campus-xxx-spec / xxx-1791636247569）=spec
      // 套件与运营后建校区（归属由 IKKRMS 分配流程管，默认未分配合法）。
      const leaked = active.filter(
        (c) => /^campus-[a-z0-9]+$/.test(c.id) && c.organizationId !== ORG_A,
      );
      expect(leaked).toEqual([]);
    });

    it('org-a 基线：wxAppId 未登记（env 兼容前提）且 capabilities=null（营销全开）', async () => {
      const orgA = await db.organization.findUniqueOrThrow({
        where: { id: ORG_A },
      });
      expect(orgA.wxAppId ?? null).toBeNull();
      expect(orgA.capabilities).toBeNull();
    });
  });

  /* ==========================================================================
   * GATE 1：双组织隔离对抗——资源 ID 交叉读写全拒绝（每域 ≥2 条）
   * ========================================================================== */
  describe('GATE 1 双组织隔离对抗：跨组织资源 ID 读写全拒绝', () => {
    beforeAll(() => ensureFixture());

    describe('校区数据域', () => {
      it('C 端校区列表互不可见：B 用户不见 org-a 校区，A 用户不见 B 校区', async () => {
        const forB = (await business.campusOptions(CAMPUS_B1)).map((c) => c.id);
        expect(forB).toContain(CAMPUS_B1);
        expect(forB).toContain(CAMPUS_B2);
        expect(forB).not.toContain(CAMPUS_A);
        const forA = (await business.campusOptions(CAMPUS_A)).map((c) => c.id);
        expect(forA).not.toContain(CAMPUS_B1);
        expect(forA).not.toContain(CAMPUS_B2);
      });

      it('跨组织切校区双向 400：B→A 与 A→B 均拒绝且不落库', async () => {
        await expect(
          business.switchUserCampus(userB1, CAMPUS_A),
        ).rejects.toThrow(BadRequestException);
        await expect(
          business.switchUserCampus(userA1, CAMPUS_B1),
        ).rejects.toThrow(BadRequestException);
        expect(
          (await db.user.findUniqueOrThrow({ where: { id: userB1 } })).campusId,
        ).toBe(CAMPUS_B1);
        expect(
          (await db.user.findUniqueOrThrow({ where: { id: userA1 } })).campusId,
        ).toBe(CAMPUS_A);
      });

      it('后台组织边界双向 403：org-b 账号聚焦 org-a 校区拒，org-a 账号聚焦 B 校区拒', async () => {
        await expect(
          controller['campusScope'](reqOf(orgBCampusCtx, { campus: CAMPUS_A })),
        ).rejects.toThrow(ForbiddenException);
        // 组织内校区（B2 无逐校区授权）组织边界放行——组织级语义不因授权集收窄
        await expect(
          controller['campusScope'](
            reqOf(orgBCampusCtx, { campus: CAMPUS_B2 }),
          ),
        ).resolves.toBe(CAMPUS_B2);
        await expect(
          controller['campusScope'](
            reqOf(orgACampusCtx, { campus: CAMPUS_B1 }),
          ),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    describe('商品域', () => {
      it('列表互不可见：A 校区列表不含 B 商品，B 校区列表不含 A 商品', async () => {
        const listA = (await business.listProducts(CAMPUS_A)) as Array<{
          id: string;
        }>;
        const listB = (await business.listProducts(CAMPUS_B1)) as Array<{
          id: string;
        }>;
        expect(listA.every((x) => x.id !== productB)).toBe(true);
        expect(listB.every((x) => x.id !== productA)).toBe(true);
      });

      it('详情跨组织 404：B 用户查 A 商品 / A 用户查 B 商品均「商品不存在」', async () => {
        await expect(business.product(productA, CAMPUS_B1)).rejects.toThrow(
          NotFoundException,
        );
        await expect(business.product(productB, CAMPUS_A)).rejects.toThrow(
          NotFoundException,
        );
      });

      it('跨组织校区地址结算拒：A 用户携 B 校区地址在 A 校区结算 → 400 地址校区不符', async () => {
        // 购物车现状语义（IK8W5J/IKGZSU 定稿）：商品可见性隔离在展示层
        // （列表/详情按校区过滤），结算侧按「地址必须属用户当前校区」收口——
        // 这里钉死结算收口不因多租户改造松动。
        const foreignAddress = await business.addAddress(userA1, CAMPUS_B1, {
          buildingName: `${tag}B1栋`,
          floor: 1,
          room: '102',
          contactName: '门禁跨组织地址',
          phone: '13900000003',
        });
        await business.updateCart(userA1, {
          items: [{ productId: productA, quantity: 1 }],
        });
        await expect(
          business.createOrder(userA1, CAMPUS_A, {
            addressId: foreignAddress.id,
            deliveryMode: 'instant',
          }),
        ).rejects.toThrow('请选择当前校区的收货地址');
      });
    });

    describe('订单域', () => {
      it('读跨组织 404：A 用户读 B 订单 / B 用户读 A 订单均「订单不存在」', async () => {
        await expect(business.order(userA1, orderB)).rejects.toThrow(
          NotFoundException,
        );
        await expect(business.order(userB1, orderA)).rejects.toThrow(
          NotFoundException,
        );
      });

      it('写动作跨组织 404：A 用户取消 B 订单 / B 用户确认收货 A 订单均拒', async () => {
        await expect(business.cancel(userA1, orderB)).rejects.toThrow(
          NotFoundException,
        );
        await expect(business.confirmReceipt(userB1, orderA)).rejects.toThrow(
          NotFoundException,
        );
      });
    });

    describe('优惠券域', () => {
      it('领它组织券拒：A 用户领 B 券 / B 用户领 A 券均被拒', async () => {
        await expect(
          business.claimCoupon(userA1, couponB, CAMPUS_A),
        ).rejects.toThrow();
        await expect(
          business.claimCoupon(userB1, couponA, CAMPUS_B1),
        ).rejects.toThrow();
        // 未产生领取记录
        expect(
          await db.userCoupon.findFirst({
            where: {
              userId: { in: [userA1, userB1] },
              couponId: { in: [couponA, couponB] },
            },
          }),
        ).toBeNull();
      });

      it('领券中心互不可见：A 用户领券中心不含 B 券，B 用户不含 A 券', async () => {
        const forA = await business.coupons(userA1, CAMPUS_A);
        const forB = await business.coupons(userB1, CAMPUS_B1);
        expect(
          forA.claimable.some((c: { id: string }) => c.id === couponB),
        ).toBe(false);
        expect(
          forB.claimable.some((c: { id: string }) => c.id === couponA),
        ).toBe(false);
      });
    });
  });

  /* ==========================================================================
   * GATE 2：组织 A 兼容回归（关键——旧小程序零改动契约）。
   * 链路：wechat-login（env 兼容）→ 商品 → 领券 → 下单 → prepay（env 参数+
   * 订阅单 key）→ mock 支付 → 退款申请；外加骑手任务池与营销全开回归。
   * ========================================================================== */
  describe('GATE 2 组织 A 兼容回归：旧小程序零改动契约', () => {
    beforeAll(() => ensureFixture());

    /** env 兼容凭证（组织 A 现状：登录旧单对 WX_APPID + 支付 WX_APPID_USER 全套）。 */
    const setEnvOrgA = () => {
      process.env.WX_APPID = ENV_A_APPID;
      process.env.WX_SECRET = 'gate-secret-a';
      process.env.WX_APPID_USER = ENV_A_APPID; // 支付 env 凭证要求（payments.configured）
      process.env.WX_SECRET_USER = 'gate-secret-a';
      process.env.WX_MCH_ID = '1900000101';
      process.env.WX_APIV3_KEY = 'a'.repeat(32);
      process.env.WX_SERIAL_NO = 'serial-gate-env-a';
      process.env.WX_PRIVATE_KEY = envAPrivateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString();
      process.env.WX_PRIVATE_KEY_PATH = '';
      process.env.WX_NOTIFY_URL =
        'https://api-gate-a.example.com/api/v1/payments/wechat/notify';
      process.env.WX_TMPL_PAID = 'tmpl-gate-paid';
      process.env.WX_TMPL_DELIVERED = 'tmpl-gate-delivered';
    };

    let loginFallbackUser = '';
    let linkUser = '';
    let linkUserCoupon = '';
    let linkOrder = '';

    it('wechat-login 无 AppID 登记 → env 兼容路径：登录成功 + fallback 全局最早真实校区', async () => {
      setEnvOrgA();
      sessionByCode.set('gate-code-a', `openid-gate-a-${tag}`);
      // 兼容前提：该 AppID 未登记到任何组织（组织 A 现状）
      expect(await resolveOrganizationByAppId(db, ENV_A_APPID)).toBeNull();
      const result = (await auth.wechatLogin({
        code: 'gate-code-a',
        appid: ENV_A_APPID,
      })) as {
        data: {
          token: string;
          isNewUser?: boolean;
          user: { campusId: string };
        };
      };
      expect(result.data.isNewUser).toBe(true);
      const earliest = await db.campus.findFirst({
        where: { type: 'campus', status: 'active' },
        orderBy: { createdAt: 'asc' },
      });
      expect(earliest).not.toBeNull();
      expect(result.data.user.campusId).toBe(earliest!.id);
      const claims = jwtClaims(result.data.token);
      expect(claims.role).toBe('user');
      loginFallbackUser = claims.id;
      userIds.push(loginFallbackUser);
    });

    it('分享链路兼容：携带 org-a 校区 campusId 的登录采纳该校区（分享语义不变）', async () => {
      setEnvOrgA();
      sessionByCode.set('gate-code-a2', `openid-gate-a2-${tag}`);
      const result = (await auth.wechatLogin({
        code: 'gate-code-a2',
        appid: ENV_A_APPID,
        campusId: CAMPUS_A,
      })) as { data: { token: string; user: { campusId: string } } };
      expect(result.data.user.campusId).toBe(CAMPUS_A);
      linkUser = jwtClaims(result.data.token).id;
      userIds.push(linkUser);
    });

    it('商品可见：组织 A 校区目录含 fixture 商品，home 结构原样', async () => {
      const list = (await business.listProducts(CAMPUS_A)) as Array<{
        id: string;
      }>;
      expect(list.some((x) => x.id === productA)).toBe(true);
      const home = await business.home(CAMPUS_A);
      expect(Array.isArray(home.banners)).toBe(true);
      expect(Array.isArray(home.hotProducts)).toBe(true);
      const detail = await business.product(productA, CAMPUS_A);
      expect((detail as { id: string }).id).toBe(productA);
    });

    it('营销全开（org-a capabilities=null）：marketingEnabled 恒 true + 领券中心可见并可领', async () => {
      expect(await marketingEnabled(db, CAMPUS_A)).toBe(true);
      const center = await business.coupons(linkUser, CAMPUS_A);
      expect(
        center.claimable.some((c: { id: string }) => c.id === couponA),
      ).toBe(true);
      linkUserCoupon = (await business.claimCoupon(linkUser, couponA, CAMPUS_A))
        .id;
      expect(linkUserCoupon).toBeTruthy();
    });

    it('下单链路：地址→购物车→结算→下单（含券锁定），状态 pending-payment', async () => {
      const address = await business.addAddress(linkUser, CAMPUS_A, {
        buildingName: `${tag}A栋`,
        floor: 1,
        room: '101',
        contactName: '门禁测试',
        phone: '13900000001',
      });
      await business.updateCart(linkUser, {
        items: [{ productId: productA, quantity: 1 }],
      });
      const quote = await business.checkout(linkUser, CAMPUS_A, {
        addressId: address.id,
        deliveryMode: 'instant',
        couponId: linkUserCoupon,
      });
      // 运费为校区配置值（campus-hbut instant=400 分），不硬编码——按结算回显口径
      expect(quote.discount).toBe(300);
      expect(quote.payableAmount).toBe(
        quote.productAmount + quote.deliveryFee - 300,
      );
      const order = await business.createOrder(linkUser, CAMPUS_A, {
        addressId: address.id,
        deliveryMode: 'instant',
        couponId: linkUserCoupon,
      });
      expect(order.status).toBe('pending-payment');
      orderIds.push(order.id);
      linkOrder = order.id;
      // 下单锁券：claimed → locked
      expect(
        (
          await db.userCoupon.findUniqueOrThrow({
            where: { id: linkUserCoupon },
          })
        ).status,
      ).toBe('locked');
    });

    it('支付参数全走 env：prepay 请求 appid/商户号/回调均 env 值（组织 A 零变化）', async () => {
      setEnvOrgA();
      const res = await payments.prepay(linkUser, linkOrder);
      const call = lastCall('/v3/pay/transactions/jsapi')!;
      const body = JSON.parse(bodyText(call.init)) as {
        appid: string;
        mchid: string;
        notify_url: string;
      };
      expect(body.appid).toBe(ENV_A_APPID);
      expect(body.mchid).toBe('1900000101');
      expect(body.notify_url).toBe(
        'https://api-gate-a.example.com/api/v1/payments/wechat/notify',
      );
      expect(res.payParams.appId).toBe(ENV_A_APPID);
    });

    it('订阅消息单 key：subscribeTemplates=env 一对模板（paid+delivered）', async () => {
      setEnvOrgA();
      const res = await payments.prepay(linkUser, linkOrder);
      expect(res.subscribeTemplates).toEqual([
        'tmpl-gate-paid',
        'tmpl-gate-delivered',
      ]);
    });

    it('mock 支付落账：pay → paid，券 used，库存与快照口径不变', async () => {
      const paid = await business.pay(linkUser, linkOrder);
      expect(paid.status).toBe('paid');
      expect(
        (
          await db.userCoupon.findUniqueOrThrow({
            where: { id: linkUserCoupon },
          })
        ).status,
      ).toBe('used');
      const raw = await db.order.findUniqueOrThrow({
        where: { id: linkOrder },
      });
      expect(raw.paidAt).not.toBeNull();
    });

    it('退款申请：paid 单申请未发货退款 → pending + 订单转售后态', async () => {
      const refund = await business.applyPreDeliveryRefund(
        linkUser,
        linkOrder,
        { reason: '门禁兼容回归退款' },
      );
      expect(refund.status).toBe('pending');
      expect(refund.source).toBe('pre-delivery');
      expect(
        (await db.order.findUniqueOrThrow({ where: { id: linkOrder } })).status,
      ).toBe('after-sales');
    });

    it('骑手任务池正常：存量骑手任务/抢单池可读且不含组织 B 订单', async () => {
      const tasks = await fulfillment.tasks('staff-rider-001');
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      const pool = await fulfillment.availableTasks('staff-rider-001');
      expect(pool.every((t) => t.orderId !== orderB)).toBe(true);
      expect(tasks.every((t) => t.orderId !== orderB)).toBe(true);
    });
  });

  /* ==========================================================================
   * GATE 3：组织 B 独立闭环——登记 wxAppId 的组织从登录到送达全链自营，
   * 全程不落任何 org-a/env 资源（微信配置走组织行，校区限本组织）。
   * ========================================================================== */
  describe('GATE 3 组织 B 独立闭环：登录→限校区→下单→组织微信配置→配送全链', () => {
    beforeAll(() => ensureFixture());

    let orgBUser = '';
    let orgBOrder = '';
    let riderB = '';
    let bmB = '';

    it('组织小程序登录：AppID 命中组织 B → 新用户 fallback 本组织最早校区', async () => {
      process.env.WX_APPID_USER = ORG_B_APPID;
      process.env.WX_SECRET_USER = `secret-${tag}`;
      sessionByCode.set('gate-code-b', `openid-gate-b-${tag}`);
      const result = (await auth.wechatLogin({
        code: 'gate-code-b',
        appid: ORG_B_APPID,
      })) as {
        data: {
          token: string;
          isNewUser?: boolean;
          user: { campusId: string };
        };
      };
      expect(result.data.isNewUser).toBe(true);
      expect(result.data.user.campusId).toBe(CAMPUS_B1);
      const claims = jwtClaims(result.data.token);
      expect(claims.role).toBe('user');
      orgBUser = claims.id;
      userIds.push(orgBUser);
    });

    it('限组织校区：登录带 org-a 校区 400 拒绝（防跨组织导流）+ 校区列表只见本组织', async () => {
      process.env.WX_APPID_USER = ORG_B_APPID;
      process.env.WX_SECRET_USER = `secret-${tag}`;
      sessionByCode.set('gate-code-b-cross', `openid-gate-bx-${tag}`);
      await expect(
        auth.wechatLogin({
          code: 'gate-code-b-cross',
          appid: ORG_B_APPID,
          campusId: CAMPUS_A,
        }),
      ).rejects.toThrow('分享校区不属于当前小程序所在组织');
      expect(
        await db.user.findFirst({
          where: { openid: `openid-gate-bx-${tag}` },
        }),
      ).toBeNull();
      const options = (await business.campusOptions(CAMPUS_B1)).map(
        (c) => c.id,
      );
      expect(options).toEqual(expect.arrayContaining([CAMPUS_B1, CAMPUS_B2]));
      expect(options).not.toContain(CAMPUS_A);
    });

    it('营销能力白名单生效（capabilities=["marketing"]）：领券中心开放可领', async () => {
      expect(await marketingEnabled(db, CAMPUS_B1)).toBe(true);
      const center = await business.coupons(orgBUser, CAMPUS_B1);
      expect(
        center.claimable.some((c: { id: string }) => c.id === couponB),
      ).toBe(true);
      await business.claimCoupon(orgBUser, couponB, CAMPUS_B1);
    });

    it('下单：组织 B 校区地址→购物车→下单，状态 pending-payment', async () => {
      const address = await business.addAddress(orgBUser, CAMPUS_B1, {
        buildingName: `${tag}B1栋`,
        floor: 2,
        room: '203',
        contactName: '门禁组织B',
        phone: '13900000002',
      });
      await business.updateCart(orgBUser, {
        items: [{ productId: productB, quantity: 1 }],
      });
      const order = await business.createOrder(orgBUser, CAMPUS_B1, {
        addressId: address.id,
        deliveryMode: 'instant',
      });
      expect(order.status).toBe('pending-payment');
      // 运费为校区配置（新建校区取默认 400 分），按结算回显口径断言
      expect(order.payableAmount).toBe(order.productAmount + order.deliveryFee);
      orderIds.push(order.id);
      orgBOrder = order.id;
    });

    it('mock 组织微信配置：prepay 请求 appid/商户号/回调全取组织 B 行（env 在场也优先）', async () => {
      // env 也在场——组织行优先是路由铁律（IKKRMT），同时防「组织行失效静默漏 env」
      process.env.WX_MCH_ID = '1900000101';
      process.env.WX_APIV3_KEY = 'a'.repeat(32);
      process.env.WX_SERIAL_NO = 'serial-gate-env-a';
      process.env.WX_PRIVATE_KEY = envAPrivateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString();
      process.env.WX_PRIVATE_KEY_PATH = '';
      const res = await payments.prepay(orgBUser, orgBOrder);
      const call = lastCall('/v3/pay/transactions/jsapi')!;
      const body = JSON.parse(bodyText(call.init)) as {
        appid: string;
        mchid: string;
        notify_url: string;
      };
      expect(body.appid).toBe(ORG_B_APPID);
      expect(body.mchid).toBe(ORG_B_WX.mchId);
      expect(body.notify_url).toBe(
        `${ORG_B_WX.notifyDomain}/api/v1/payments/wechat/notify`,
      );
      expect(res.payParams.appId).toBe(ORG_B_APPID);
      // env 模板属于组织 A 小程序：组织 B 订单下发空数组（前端静默跳过授权）
      expect(res.subscribeTemplates).toEqual([]);
    });

    it('mock 支付落账：pay → paid，进入履约', async () => {
      const paid = await business.pay(orgBUser, orgBOrder);
      expect(paid.status).toBe('paid');
    });

    it('订单隔离回归：org-a 骑手任务池不含组织 B 订单；组织 B 骑手抢单池含', async () => {
      await business.advance(orgBUser, orgBOrder);
      await business.advance(orgBUser, orgBOrder);
      expect(
        (await db.order.findUniqueOrThrow({ where: { id: orgBOrder } })).status,
      ).toBe('waiting-first-mile');
      riderB = staffIds[0];
      bmB = staffIds[1];
      const poolB = await fulfillment.availableTasks(riderB);
      expect(poolB.some((t) => t.orderId === orgBOrder)).toBe(true);
      const poolA = await fulfillment.availableTasks('staff-rider-001');
      expect(poolA.every((t) => t.orderId !== orgBOrder)).toBe(true);
    });

    // 配送全链以编写时工作区现状为基底（IKKRMV deliveryMode 改造并行中：
    // 其合入后若动作语义变化，按新语义更新本两段断言，不得删除门禁）。
    it('配送全链（上）：骑手抢单→出发→到楼下 waiting-handover', async () => {
      await fulfillment.updateTask(
        riderB,
        `task-fulltime-rider-${orgBOrder}`,
        'grab',
      );
      expect(
        (await db.order.findUniqueOrThrow({ where: { id: orgBOrder } }))
          .riderId,
      ).toBe(riderB);
      await fulfillment.updateTask(
        riderB,
        `task-fulltime-rider-${orgBOrder}`,
        'depart',
      );
      await fulfillment.updateTask(
        riderB,
        `task-fulltime-rider-${orgBOrder}`,
        'arrive',
      );
      expect(
        (await db.order.findUniqueOrThrow({ where: { id: orgBOrder } })).status,
      ).toBe('waiting-handover');
    });

    it('配送全链（下）：楼长接货→送达凭证→用户确认收货 completed', async () => {
      await fulfillment.updateTask(
        bmB,
        `task-building-manager-${orgBOrder}`,
        'receive',
      );
      const delivered = await fulfillment.updateTask(
        bmB,
        `task-building-manager-${orgBOrder}`,
        'delivered',
        {
          images: ['https://cos.example/gate-proof.jpg'],
          location: `${tag}B1栋 203`,
        },
      );
      expect(delivered.statusText).toBe('已送达，待确认收货');
      const done = await business.confirmReceipt(orgBUser, orgBOrder);
      expect(done.status).toBe('completed');
      expect(done.statusPhase).toBe('done');
    });
  });
});
