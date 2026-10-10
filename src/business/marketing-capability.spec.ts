import { Prisma } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from './business.service';
import { AdminService } from '../admin/admin.service';
import { AdminController } from '../admin/admin.controller';
import { RbacService } from '../admin/rbac/rbac.service';
import { specReq } from '../admin/rbac/spec-fixtures';
import { marketingEnabled } from '../common/capability';

/**
 * IKKRMU 营销能力开关（组织 capabilities / 校区 features，营销切片）：
 * - 组织关（capabilities 不含 marketing）→ 全链静默降级 + admin 写端点 403
 * - 校区显式关（组织开但 features 不含 marketing）→ 同上
 * - 只能收窄：组织关时校区显式开无效
 * - 组织 A 现状（capabilities=null / 无归属校区）→ 全开回归，行为零变化
 */
describe('marketing capability switch (IKKRMU)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const admin = new AdminService(db, business);
  const controller = new AdminController(admin, new RbacService(db));
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

  const ORG = 'org-mktspec';
  const CAMPUS = 'campus-mktspec';
  let user = '';
  let bannerId = '';
  let manualCouponId = '';
  let signupCouponId = '';
  let productId = '';

  /** 组织/校区开关统一改（null=继承/全开；Json 列写 DB NULL 用 Prisma.DbNull）。 */
  const setSwitch = async (
    capabilities: string[] | null,
    features: string[] | null,
  ) => {
    await db.organization.update({
      where: { id: ORG },
      data: {
        capabilities:
          capabilities === null ? Prisma.DbNull : json(capabilities),
      },
    });
    await db.campus.update({
      where: { id: CAMPUS },
      data: { features: features === null ? Prisma.DbNull : json(features) },
    });
  };

  beforeAll(async () => {
    await db.organization.create({
      data: { id: ORG, name: '营销能力测试组织', shortName: '营销测' },
    });
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '营销能力测试校区',
        shortName: '营销测',
        warehouseName: '营销测试仓',
        organizationId: ORG,
      },
    });
    user = (
      await db.user.create({
        data: {
          campusId: CAMPUS,
          nickname: '营销开关测试用户',
          phone: '13900000201',
          role: 'user',
        },
      })
    ).id;
    bannerId = (
      await db.banner.create({
        data: {
          campusId: CAMPUS,
          title: '营销测试 Banner',
          subtitle: '',
          badge: '',
          color: '#fff',
          placement: 'home',
          status: 'active',
        },
      })
    ).id;
    await db.banner.create({
      data: {
        campusId: CAMPUS,
        title: '营销测试支付位',
        subtitle: '',
        badge: '',
        color: '#fff',
        placement: 'pay-success',
        status: 'active',
      },
    });
    manualCouponId = (
      await db.coupon.create({
        data: {
          campusId: CAMPUS,
          name: '营销测试手动券',
          amount: 5,
          threshold: 20,
          total: 100,
          status: 'active',
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        },
      })
    ).id;
    signupCouponId = (
      await db.coupon.create({
        data: {
          campusId: CAMPUS,
          name: '营销测试注册券',
          trigger: 'signup',
          amount: 3,
          threshold: 10,
          total: 100,
          status: 'active',
        },
      })
    ).id;
    productId = (
      await db.product.create({
        data: {
          campusId: CAMPUS,
          categoryId: 'drink',
          name: '营销测试推荐位商品',
          subtitle: '',
          price: 3,
          originalPrice: 4,
          stock: 10,
          tag: '',
          image: '',
          weight: 0.5,
          status: 'on-sale',
          featured: true,
          featuredSort: 1,
        },
      })
    ).id;
    await db.lotteryWheel.create({
      data: {
        campusId: CAMPUS,
        active: true,
        prizes: JSON.stringify(
          Array.from({ length: 8 }, () => ({
            type: 'none',
            label: '谢谢参与',
          })),
        ),
      },
    });
  });

  afterAll(async () => {
    await db.lotteryWheel.deleteMany({ where: { campusId: CAMPUS } });
    await db.userCoupon.deleteMany({
      where: { couponId: { in: [manualCouponId, signupCouponId] } },
    });
    await db.coupon.deleteMany({
      where: { id: { in: [manualCouponId, signupCouponId] } },
    });
    await db.banner.deleteMany({ where: { campusId: CAMPUS } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.user.deleteMany({ where: { id: user } });
    await db.campus.deleteMany({ where: { id: CAMPUS } });
    await db.organization.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  it('基线：组织 null + 校区 null（继承）= 全开——营销链路原样输出', async () => {
    await setSwitch(null, null);
    expect(await marketingEnabled(db, CAMPUS)).toBe(true);
    const home = await business.home(CAMPUS);
    expect(home.banners.length).toBeGreaterThanOrEqual(1);
    expect(home.hotProducts.length).toBeGreaterThanOrEqual(1);
    expect(
      (await business.bannerByPlacement(CAMPUS, 'pay-success')).length,
    ).toBeGreaterThanOrEqual(1);
    expect((await business.listFeatured(CAMPUS)).length).toBeGreaterThanOrEqual(
      1,
    );
    const coupons = await business.coupons(user, CAMPUS);
    expect(
      coupons.claimable.some((c: { id: string }) => c.id === manualCouponId),
    ).toBe(true);
    expect((await business.wheel(user, CAMPUS)).active).toBe(true);
    expect((await business.grantSignupCoupons(user, CAMPUS)).granted).toBe(1);
  });

  it('组织关（capabilities 不含 marketing）→ 全链静默降级 + 写端点 403', async () => {
    await setSwitch(['other-capability'], null);
    expect(await marketingEnabled(db, CAMPUS)).toBe(false);
    // 读侧静默：全部下发空，不报错
    const home = await business.home(CAMPUS);
    expect(home.banners).toEqual([]);
    expect(home.hotProducts).toEqual([]);
    expect(await business.bannerByPlacement(CAMPUS, 'pay-success')).toEqual([]);
    expect(await business.listFeatured(CAMPUS)).toEqual([]);
    expect((await business.coupons(user, CAMPUS)).claimable).toEqual([]);
    const wheel = await business.wheel(user, CAMPUS);
    expect(wheel.active).toBe(false);
    expect(wheel.prizes).toEqual([]);
    // signup 新人券不发（静默 granted=0）
    expect((await business.grantSignupCoupons(user, CAMPUS)).granted).toBe(0);
    // 写侧拒绝：C 端领券/抽奖、admin 营销写端点
    await expect(
      business.claimCoupon(user, manualCouponId, CAMPUS),
    ).rejects.toThrow('营销能力未开通');
    await expect(business.drawWheel(user, CAMPUS)).rejects.toThrow(
      '抽奖活动未开启',
    );
    await expect(admin.guardMarketingEnabled(CAMPUS)).rejects.toThrow(
      '营销能力未开通',
    );
    const req = specReq('admin') as unknown as {
      query?: Record<string, string>;
    };
    req.query = { campus: CAMPUS };
    await expect(
      controller.createCoupon(
        req as never,
        {
          campusId: CAMPUS,
          name: '应被拦截的券',
          amount: 1,
          threshold: 1,
          total: 1,
        } as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('只能收窄：组织关时校区显式开无效', async () => {
    await setSwitch([], ['marketing']);
    expect(await marketingEnabled(db, CAMPUS)).toBe(false);
    expect((await business.wheel(user, CAMPUS)).active).toBe(false);
  });

  it('校区显式关（组织开 + features 不含 marketing）→ 同组织关表现', async () => {
    await setSwitch(['marketing'], []);
    expect(await marketingEnabled(db, CAMPUS)).toBe(false);
    expect((await business.home(CAMPUS)).banners).toEqual([]);
    expect((await business.coupons(user, CAMPUS)).claimable).toEqual([]);
    expect((await business.wheel(user, CAMPUS)).active).toBe(false);
    await expect(admin.guardMarketingEnabled(CAMPUS)).rejects.toThrow(
      '营销能力未开通',
    );
  });

  it('恢复组织开 + 校区继承 → 营销链路恢复输出', async () => {
    await setSwitch(['marketing'], null);
    expect(await marketingEnabled(db, CAMPUS)).toBe(true);
    expect((await business.home(CAMPUS)).banners.length).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      (await business.coupons(user, CAMPUS)).claimable.some(
        (c: { id: string }) => c.id === manualCouponId,
      ),
    ).toBe(true);
  });

  it('组织 A 回归：org-a capabilities=null + 无归属/不存在校区 → 恒全开', async () => {
    expect(
      (await db.organization.findUniqueOrThrow({ where: { id: 'org-a' } }))
        .capabilities,
    ).toBeNull();
    expect(await marketingEnabled(db, 'campus-hbut')).toBe(true);
    expect(await marketingEnabled(db, 'campus-official')).toBe(true); // 平台伪校区无归属
    expect(await marketingEnabled(db, 'campus-no-such')).toBe(true);
    expect(await marketingEnabled(db, null)).toBe(true);
    await expect(
      admin.guardMarketingEnabled('campus-hbut'),
    ).resolves.toBeUndefined();
    // 组织 A 校区 home 结构不受影响（查询原样执行）
    const home = await business.home('campus-hbut');
    expect(Array.isArray(home.banners)).toBe(true);
    expect(Array.isArray(home.hotProducts)).toBe(true);
  });
});
