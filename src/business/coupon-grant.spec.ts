import { PrismaService } from '../database/prisma.service';
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
      data: { id: 'cat-coupon-spec', name: '发券测试分类' } as any,
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
});
