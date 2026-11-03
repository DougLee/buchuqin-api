import { PrismaService } from '../database/prisma.service';
import { AdminService } from '../admin/admin.service';
import { BusinessService } from './business.service';

/**
 * 优惠券体系扩展集成测试（IKDCVO）：signup 发放/幂等、长期券（expiresAt
 * 可空）、claimable 只出 manual 券、异业券不参与下单（列表过滤 + checkout 拒用）。
 * 独立 fixture（自建校区/用户/商品/地址/购物车），afterAll 清理。
 */
describe('Coupon kind/trigger/expirable (IKDCVO)', () => {
  const db = new PrismaService();
  const biz = new BusinessService(db);
  const CAMPUS = 'campus-coupon-spec';
  const USER = 'user-coupon-spec';
  const PRODUCT = 'product-coupon-spec';
  const ADDRESS = 'addr-coupon-spec';
  const PREFIX = '发券测试';

  const mkCoupon = (data: Record<string, unknown>) =>
    db.coupon.create({
      data: {
        campusId: CAMPUS,
        amount: 0,
        threshold: 0,
        total: 10,
        status: 'active',
        ...data,
      } as any,
    });

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '发券测试校园',
        shortName: '发券',
        warehouseName: '发券仓',
        // 测试购物车仅 5 元，压低起送门槛避免 quote 被挡
        deliveryThreshold: 0,
      } as any,
    });
    await db.user.create({
      data: {
        id: USER,
        openid: 'openid-coupon-spec',
        nickname: '发券测试用户',
        phone: '13800000002',
        campusId: CAMPUS,
      } as any,
    });
    await db.category.create({
      data: { campusId: CAMPUS,
      id: 'cat-coupon-spec', name: '发券测试分类' } as any,
    });
    await db.product.create({
      data: {
        id: PRODUCT,
        campusId: CAMPUS,
        categoryId: 'cat-coupon-spec',
        name: '发券测试可乐',
        subtitle: 'spec',
        tag: 'spec',
        price: 500,
        originalPrice: 600,
        stock: 50,
        image: '',
        weight: 0.5,
      } as any,
    });
    await db.address.create({
      data: {
        id: ADDRESS,
        userId: USER,
        campusId: CAMPUS,
        campusName: '发券测试校园',
        buildingId: 'building-coupon-spec',
        buildingName: '测试楼',
        floor: 1,
        room: '101',
        contactName: 'spec',
        phone: '13800000002',
        isDefault: true,
      } as any,
    });
    await db.cartItem.create({
      data: { userId: USER, productId: PRODUCT, quantity: 1 },
    });
  });

  afterAll(async () => {
    // IKDEN2：不限量用例引入第二用户，按校区维度清持券
    await db.userCoupon.deleteMany({
      where: { user: { campusId: CAMPUS } },
    });
    await db.coupon.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await db.cartItem.deleteMany({ where: { userId: USER } });
    await db.address.deleteMany({ where: { id: ADDRESS } });
    await db.product.deleteMany({ where: { id: PRODUCT } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.category.deleteMany({ where: { id: 'cat-coupon-spec' } });
    await db.campus.deleteMany({ where: { id: CAMPUS } });
    await db.$disconnect();
  });

  it('grantSignupCoupons issues signup coupons, idempotent on re-run', async () => {
    await mkCoupon({
      name: `${PREFIX}新人红包`,
      trigger: 'signup',
      amount: 300,
    });
    const r1 = await biz.grantSignupCoupons(USER, CAMPUS);
    expect(r1.granted).toBe(1);
    // 幂等：已持有不重发不占名额
    const r2 = await biz.grantSignupCoupons(USER, CAMPUS);
    expect(r2.granted).toBe(0);
    const coupon = await db.coupon.findFirst({
      where: { name: `${PREFIX}新人红包` },
    });
    expect(coupon!.claimed).toBe(1);
    expect(coupon!.issued).toBe(1);
  });

  it('long-lived coupon (expiresAt=null) stays claimable with kind/trigger fields', async () => {
    await mkCoupon({
      name: `${PREFIX}长期券`,
      trigger: 'manual',
      amount: 500,
      expiresAt: null,
    });
    const { claimable } = await biz.coupons(USER, CAMPUS);
    const found = claimable.find((c) => c.name === `${PREFIX}长期券`);
    expect(found).toBeTruthy();
    expect(found!.expiresAt).toBeNull();
    expect(found!.kind).toBe('platform');
    expect(found!.trigger).toBe('manual');
  });

  it('claimable excludes lottery/signup coupons; claim rejects non-manual', async () => {
    await mkCoupon({
      name: `${PREFIX}转盘券`,
      trigger: 'lottery',
      amount: 100,
    });
    // 另建一张未被持有的 signup 券，验证领取接口对 trigger 的拦截
    // （新人红包已被用例 1 发放，claimCoupon 幂等返回属正常，不在此断言）。
    await mkCoupon({
      name: `${PREFIX}新人红包2`,
      trigger: 'signup',
      amount: 100,
    });
    const { claimable } = await biz.coupons(USER, CAMPUS);
    expect(claimable.find((c) => c.name === `${PREFIX}转盘券`)).toBeUndefined();
    expect(
      claimable.find((c) => c.name === `${PREFIX}新人红包2`),
    ).toBeUndefined();
    for (const name of [`${PREFIX}转盘券`, `${PREFIX}新人红包2`]) {
      const c = await db.coupon.findFirst({ where: { name } });
      await expect(biz.claimCoupon(USER, c!.id, CAMPUS)).rejects.toThrow(
        '不支持手动领取',
      );
    }
  });

  it('partner coupons: grantable & visible in mine, filtered from order list, rejected at checkout', async () => {
    const partner = await mkCoupon({
      name: `${PREFIX}异业券`,
      kind: 'partner',
      trigger: 'lottery',
      remark: '到店出示，享第二杯半价',
    });
    const issued = await biz['grantCoupon'](USER, partner.id);
    expect(issued).toBeTruthy();
    const { mine } = await biz.coupons(USER, CAMPUS);
    const view = mine.find((x) => x.coupon.name === `${PREFIX}异业券`);
    expect(view?.coupon.kind).toBe('partner');
    expect(view?.coupon.remark).toBe('到店出示，享第二杯半价');

    const dto = {
      addressId: ADDRESS,
      deliveryMode: 'instant',
      deliverySlot: '',
    } as any;
    // 领一张长期券（manual 可领，expiresAt=null 不过期）用于列表对照
    const longCoupon = await db.coupon.findFirst({
      where: { name: `${PREFIX}长期券` },
    });
    await biz.claimCoupon(USER, longCoupon!.id, CAMPUS);
    // 下单可用券列表只出 platform 券（异业券不掺进来）
    const list = await biz.availableCoupons(USER, CAMPUS, dto);
    expect(list.find((x: any) => x.couponId === partner.id)).toBeUndefined();
    expect(list.find((x: any) => x.name === `${PREFIX}长期券`)).toBeDefined();
    // checkout 拒用异业券
    await expect(
      biz.checkout(USER, CAMPUS, { ...dto, couponId: issued!.id }),
    ).rejects.toThrow('异业券');
  });

  it('unlimited coupons (total=null): claimable & multi-user claim & signup grant, remain=null', async () => {
    // 手动领：不限量券恒可领，remain=null
    const manual = await mkCoupon({
      name: `${PREFIX}不限量手动券`,
      trigger: 'manual',
      amount: 100,
      total: null,
    });
    const { claimable } = await biz.coupons(USER, CAMPUS);
    const found = claimable.find((c) => c.name === `${PREFIX}不限量手动券`);
    expect(found).toBeTruthy();
    expect(found!.remain).toBeNull();
    await biz.claimCoupon(USER, manual.id, CAMPUS);

    // 第二个用户也能领（限量券会被 total 卡，不限量不设限）
    const USER_B = 'user-coupon-spec-b';
    await db.user.create({
      data: {
        id: USER_B,
        openid: 'openid-coupon-spec-b',
        nickname: '不限量用户B',
        phone: '13800000012',
        campusId: CAMPUS,
      } as any,
    });
    try {
      await biz.claimCoupon(USER_B, manual.id, CAMPUS);
      const after = await db.coupon.findUniqueOrThrow({
        where: { id: manual.id },
      });
      expect(after.claimed).toBe(2);
    } finally {
      await db.userCoupon.deleteMany({ where: { userId: USER_B } });
      await db.user.deleteMany({ where: { id: USER_B } });
    }

    // 注册发券通道同样不限量
    await mkCoupon({
      name: `${PREFIX}不限量新人券`,
      trigger: 'signup',
      amount: 200,
      total: null,
    });
    const r = await biz.grantSignupCoupons(USER, CAMPUS);
    expect(r.granted).toBeGreaterThanOrEqual(1);
    const unlimited = await db.coupon.findFirstOrThrow({
      where: { name: `${PREFIX}不限量新人券` },
    });
    expect(unlimited.total).toBeNull();
    expect(unlimited.claimed).toBe(1);
  });

  it('coupon edit (IKDERC): field-level guardrails by claimed count', async () => {
    // 未发放：全字段可改（面额/门槛/总量/有效期）
    const fresh = await mkCoupon({
      name: `${PREFIX}编辑券`,
      trigger: 'manual',
      amount: 100,
      threshold: 500,
      total: 10,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    // IKDERC：编辑管控在 admin.service，用真实实例断言（同 promotions.spec 模式）
    const svc = new AdminService(db, biz);
    const edited = await svc.updateCoupon(
      fresh.id,
      { amount: 200, threshold: 1000, total: 50, remark: '改过了' },
      'spec-op',
      CAMPUS,
    );
    expect(edited.amount).toBe(200);
    expect(edited.threshold).toBe(1000);
    expect(edited.total).toBe(50);

    // 发放 1 张后：面额/门槛锁定、总量不能小于已发、名称可改
    await biz.claimCoupon(USER, fresh.id, CAMPUS);
    await expect(
      svc.updateCoupon(fresh.id, { amount: 300 }, 'spec-op', CAMPUS),
    ).rejects.toThrow('锁定不可修改');
    await expect(
      svc.updateCoupon(fresh.id, { total: 0 as unknown as number }, 'spec-op', CAMPUS),
    ).rejects.toThrow('不能小于已发放数');
    const renamed = await svc.updateCoupon(
      fresh.id,
      { name: `${PREFIX}编辑券改名`, total: null, expiresAt: null },
      'spec-op',
      CAMPUS,
    );
    expect(renamed.name).toBe(`${PREFIX}编辑券改名`);
    // 转不限量 + 长期：null 落库
    expect(renamed.total).toBeNull();
    expect(renamed.expiresAt).toBeNull();
  });

  it('coupon delete (IKDES1): only never-issued coupons are deletable', async () => {
    const svc = new AdminService(db, biz);
    // 从未发放：可删
    const fresh = await mkCoupon({
      name: `${PREFIX}待删券`,
      trigger: 'manual',
      amount: 100,
    });
    const r = await svc.deleteCoupon(fresh.id, 'spec-op', CAMPUS);
    expect(r.deleted).toBe(true);
    expect(await db.coupon.findUnique({ where: { id: fresh.id } })).toBeNull();

    // 已发放（claimed=1）：拒绝，提示走暂停
    const issued = await mkCoupon({
      name: `${PREFIX}已发待删券`,
      trigger: 'manual',
      amount: 100,
    });
    await biz.claimCoupon(USER, issued.id, CAMPUS);
    await expect(
      svc.deleteCoupon(issued.id, 'spec-op', CAMPUS),
    ).rejects.toThrow('请使用「暂停发放」');
  });
});

/**
 * 切换校区补发 signup 新人券 + 「同券终身一次」幂等（IKSN19，道哥
 * 2026-11-03 定稿）：切换到新校区发该校区 signup 券（覆盖确认页选错
 * 纠正的新用户）；同券历史持有含 used 也拦截——堵往返切换重领的
 * 薅口子。粒度按券不按校区，多张 signup 券并存发放不受影响。
 */
describe('campus-switch signup coupon grant (IKSN19)', () => {
  const db = new PrismaService();
  const biz = new BusinessService(db);
  const CAMPUS_A = 'campus-csw-spec-a';
  const CAMPUS_B = 'campus-csw-spec-b';
  const USER2 = 'user-csw-spec';
  const PREFIX = '切换发券测试';

  const mkSignup = (campusId: string, name: string) =>
    db.coupon.create({
      data: {
        campusId,
        name,
        trigger: 'signup',
        amount: 300,
        threshold: 0,
        total: 10,
        status: 'active',
      } as any,
    });

  beforeAll(async () => {
    // 两个校区均不挂组织（campusOrganizationId=null → 切换不加组织限定）
    await db.campus.create({
      data: {
        id: CAMPUS_A,
        name: `${PREFIX}A校`,
        shortName: 'A校',
        warehouseName: 'A仓',
      } as any,
    });
    await db.campus.create({
      data: {
        id: CAMPUS_B,
        name: `${PREFIX}B校`,
        shortName: 'B校',
        warehouseName: 'B仓',
      } as any,
    });
    await db.user.create({
      data: {
        id: USER2,
        openid: 'openid-csw-spec',
        nickname: '切换发券用户',
        phone: '13800000003',
        campusId: CAMPUS_A,
      } as any,
    });
    await mkSignup(CAMPUS_A, `${PREFIX}A新人券`);
    await mkSignup(CAMPUS_B, `${PREFIX}B新人券`);
  });

  afterAll(async () => {
    await db.userCoupon.deleteMany({ where: { userId: USER2 } });
    await db.coupon.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await db.user.deleteMany({ where: { id: USER2 } });
    await db.campus.deleteMany({ where: { id: { in: [CAMPUS_A, CAMPUS_B] } } });
    await db.$disconnect();
  });

  it('switching to campus B grants B signup coupon', async () => {
    await biz.switchUserCampus(USER2, CAMPUS_B);
    // 发券是事务后尽力而为（fire-and-forget），轮询等它落库
    let held: { couponId: string } | null = null;
    for (let i = 0; i < 20 && !held; i++) {
      await new Promise((r) => setTimeout(r, 100));
      held = await db.userCoupon.findFirst({
        where: { userId: USER2, coupon: { campusId: CAMPUS_B } },
        select: { couponId: true },
      });
    }
    expect(held).not.toBeNull();
    const coupon = await db.coupon.findFirst({
      where: { name: `${PREFIX}B新人券` },
    });
    expect(coupon!.claimed).toBe(1);
  });

  /** 轮询等 fire-and-forget 发券落库（spec 库走公网，串行查询链慢） */
  async function waitForHeld(campusId: string, expectedCount: number) {
    let rows: { id: string }[] = [];
    for (let i = 0; i < 40 && rows.length < expectedCount; i++) {
      await new Promise((r) => setTimeout(r, 100));
      rows = await db.userCoupon.findMany({
        where: { userId: USER2, coupon: { campusId } },
        select: { id: true },
      });
    }
    return rows;
  }

  it('lifetime-once per coupon: used coupon still blocks re-grant', async () => {
    // 切回 A：发 A 券
    await biz.switchUserCampus(USER2, CAMPUS_A);
    const aRows = await waitForHeld(CAMPUS_A, 1);
    expect(aRows.length).toBe(1);
    const aHeld = await db.userCoupon.findFirst({
      where: { userId: USER2, coupon: { campusId: CAMPUS_A } },
    });
    expect(aHeld).not.toBeNull();
    // A 券用掉（status=used）——终身一次检查含 used 历史
    await db.userCoupon.update({
      where: { id: aHeld!.id },
      data: { status: 'used' },
    });
    // 切回 B：B 已有 used 历史持有 → 不重发
    await biz.switchUserCampus(USER2, CAMPUS_B);
    const bCoupons = await waitForHeld(CAMPUS_B, 1);
    expect(bCoupons.length).toBe(1);
    const bCoupon = await db.coupon.findFirst({
      where: { name: `${PREFIX}B新人券` },
    });
    expect(bCoupon!.claimed).toBe(1);
    // 切回 A：A 的 used 记录同样拦截 → 不重发
    await biz.switchUserCampus(USER2, CAMPUS_A);
    const aCoupons = await waitForHeld(CAMPUS_A, 1);
    expect(aCoupons.length).toBe(1);
  });
});
