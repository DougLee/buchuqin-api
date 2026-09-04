import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AdminService } from '../admin/admin.service';
import { BusinessService } from './business.service';

/** 抽奖大转盘集成测试（IKD6FA/FB/FC）：连本地库，走真实事务/唯一键。 */
describe('LotteryWheel integration', () => {
  const db = new PrismaService();
  const admin = new AdminService(db, new BusinessService(db));
  const biz = new BusinessService(db);
  const campusId = 'campus-hbut';
  // 测试专用用户（UserCoupon 有 userId 外键）：建真用户，测试后清理。
  const userId = `wheel-test-${Date.now()}`;
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: userId,
        campusId,
        nickname: '转盘测试',
        phone: '00000000000',
      },
    });
  });

  const prize8 = (over: Partial<Record<number, any>> = {}) =>
    Array.from({ length: 8 }, (_, i) => {
      const o = over[i] ?? {};
      return {
        type: 'none',
        label: `槽${i + 1}`,
        weight: 10,
        ...o,
      };
    });
  /** 指定槽位必中：其余槽权重归零（默认 weight=10 有 7.4% 概率抽飞）。 */
  const surePrize8 = (slot: number, prize: Record<string, any>) =>
    prize8({ [slot]: { ...prize, weight: 1000 } }).map((p, i) =>
      i === slot ? p : { ...p, weight: 0 },
    );

  afterAll(async () => {
    // 前缀清理：用例内建的 u3/u4 等派生用户即便中途失败也能回收
    await db.lotteryDraw.deleteMany({
      where: { userId: { startsWith: 'wheel-test-' } },
    });
    await db.userCoupon.deleteMany({
      where: { userId: { startsWith: 'wheel-test-' } },
    });
    await db.user.deleteMany({ where: { id: { startsWith: 'wheel-test-' } } });
    await db.coupon.deleteMany({ where: { name: { startsWith: '转盘测试' } } });
    await db.lotteryWheel.deleteMany({ where: { campusId } });
    await db.$disconnect();
  });

  it('rejects draw when wheel is not configured', async () => {
    // 自愈：先清引用本校 wheel 的 draw（防上次失败遗留卡 FK），再删 wheel
    await db.lotteryDraw.deleteMany({ where: { wheel: { campusId } } });
    await db.lotteryWheel.deleteMany({ where: { campusId } });
    await expect(biz.drawWheel(userId, campusId)).rejects.toThrow(
      '抽奖活动未开启',
    );
  });

  it('issues platform coupon once, then blocks second draw same day', async () => {
    const coupon = await db.coupon.create({
      data: {
        campusId,
        name: '转盘测试5元券',
        amount: 500,
        threshold: 0,
        total: 100,
        status: 'active',
        expiresAt: new Date(Date.now() + 7 * 86400_000),
      },
    });
    await admin.upsertWheel(
      {
        active: true,
        prizes: surePrize8(0, {
          type: 'coupon',
          label: '5元券',
          couponId: coupon.id,
        }),
      },
      'wheel-tester',
      campusId,
    );
    const r = await biz.drawWheel(userId, campusId);
    expect(r.type).toBe('coupon');
    expect(r.userCouponId).toBeTruthy();
    const uc = await db.userCoupon.findUnique({
      where: { id: r.userCouponId! },
    });
    expect(uc?.couponId).toBe(coupon.id);
    // 当日第二抽：唯一键拦截
    await expect(biz.drawWheel(userId, campusId)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('degrades to none when coupon stock is exhausted', async () => {
    // 换新用户（绕开当日限抽），券总量 1 已被上一用例占位……直接造一张已领完的券。
    const u2 = `${userId}-2`;
    const coupon = await db.coupon.create({
      data: {
        campusId,
        name: '转盘测试领完券',
        amount: 100,
        threshold: 0,
        total: 1,
        claimed: 1,
        status: 'active',
        expiresAt: new Date(Date.now() + 7 * 86400_000),
      },
    });
    await admin.upsertWheel(
      {
        active: true,
        prizes: prize8({
          3: {
            type: 'coupon',
            label: '必中位',
            couponId: coupon.id,
            weight: 1000,
          },
        }),
      },
      'wheel-tester',
      campusId,
    );
    const r = await biz.drawWheel(u2, campusId);
    expect(r.type).toBe('none');
    expect(r.prize.label).toBe('谢谢参与');
    await db.lotteryDraw.deleteMany({ where: { userId: u2 } });
    await db.userCoupon.deleteMany({ where: { userId: u2 } });
  });

  it('admin validation: requires 8 slots and campus-owned coupon', async () => {
    const coupon = await db.coupon.create({
      data: {
        campusId: 'campus-other',
        name: '转盘测试外校券',
        amount: 100,
        threshold: 0,
        total: 1,
        status: 'active',
        expiresAt: new Date(Date.now() + 86400_000),
      },
    });
    await expect(
      admin.upsertWheel(
        { active: true, prizes: prize8().slice(0, 7) },
        'wheel-tester',
        campusId,
      ),
    ).rejects.toThrow('奖位必须为 8 个');
    await expect(
      admin.upsertWheel(
        {
          active: true,
          prizes: prize8({
            2: { type: 'coupon', label: 'x', couponId: coupon.id },
          }),
        },
        'wheel-tester',
        campusId,
      ),
    ).rejects.toThrow('不属于本校区');
  });

  // IKDCVO：partner 行配异业券 → 抽中发券入账；coupon 行仍只收 platform 券。
  it('partner prize with partner coupon issues it into my coupons (IKDCVO)', async () => {
    const u3 = `${userId}-3`;
    await db.user.create({
      data: { id: u3, campusId, nickname: '转盘异业', phone: '00000000000' },
    });
    const partner = await db.coupon.create({
      data: {
        campusId,
        name: '转盘测试异业券',
        kind: 'partner',
        trigger: 'lottery',
        remark: '到店出示享第二杯半价',
        amount: 0,
        threshold: 0,
        total: 5,
        status: 'active',
        expiresAt: null,
      },
    });
    await admin.upsertWheel(
      {
        active: true,
        prizes: surePrize8(5, {
          type: 'partner',
          label: '奶茶铺券',
          couponId: partner.id,
          bizTitle: '旧图文标题',
          bizImage: 'https://img.example/old.png',
        }),
      },
      'wheel-tester',
      campusId,
    );
    const r = await biz.drawWheel(u3, campusId);
    expect(r.type).toBe('partner');
    expect(r.userCouponId).toBeTruthy();
    // 发成券：票面优先展示券名/说明，旧图文不再下发
    expect(r.prize.bizTitle).toBe('转盘测试异业券');
    expect(r.prize.bizNote).toBe('到店出示享第二杯半价');
    expect(r.prize.bizImage).toBe('');
    const uc = await db.userCoupon.findUnique({
      where: { id: r.userCouponId! },
    });
    expect(uc?.couponId).toBe(partner.id);
    await db.lotteryDraw.deleteMany({ where: { userId: u3 } });
    await db.userCoupon.deleteMany({ where: { userId: u3 } });
    await db.user.deleteMany({ where: { id: u3 } });
  });

  it('partner prize falls back to legacy image-text when its coupon is exhausted', async () => {
    const u4 = `${userId}-4`;
    await db.user.create({
      data: { id: u4, campusId, nickname: '转盘异业2', phone: '00000000000' },
    });
    const partner = await db.coupon.create({
      data: {
        campusId,
        name: '转盘测试异业券领完',
        kind: 'partner',
        trigger: 'lottery',
        amount: 0,
        threshold: 0,
        total: 1,
        claimed: 1,
        status: 'active',
        expiresAt: null,
      },
    });
    await admin.upsertWheel(
      {
        active: true,
        prizes: surePrize8(2, {
          type: 'partner',
          label: '奶茶铺券',
          couponId: partner.id,
          bizTitle: '旧图文标题',
          bizImage: 'https://img.example/fallback.png',
          bizNote: '旧图文说明',
        }),
      },
      'wheel-tester',
      campusId,
    );
    const r = await biz.drawWheel(u4, campusId);
    // 异业无资金成本：发不出去回落旧图文，不降谢谢参与
    expect(r.type).toBe('partner');
    expect(r.userCouponId).toBeNull();
    expect(r.prize.bizImage).toBe('https://img.example/fallback.png');
    expect(r.prize.bizTitle).toBe('旧图文标题');
    await db.lotteryDraw.deleteMany({ where: { userId: u4 } });
    await db.userCoupon.deleteMany({ where: { userId: u4 } });
    await db.user.deleteMany({ where: { id: u4 } });
  });

  it('wheel coupon slot must reference kind=platform coupon; partner slot must reference kind=partner (IKDCVO)', async () => {
    const partner = await db.coupon.findFirst({
      where: { name: '转盘测试异业券' },
    });
    // coupon 行配异业券 → 拒
    await expect(
      admin.upsertWheel(
        {
          active: true,
          prizes: prize8({
            0: { type: 'coupon', label: 'x', couponId: partner!.id },
          }),
        },
        'wheel-tester',
        campusId,
      ),
    ).rejects.toThrow('优惠券不存在或不属于本校区');
    // partner 行配 platform 券 → 拒（须选异业类型的券）
    const platform = await db.coupon.findFirst({
      where: { name: '转盘测试5元券' },
    });
    await expect(
      admin.upsertWheel(
        {
          active: true,
          prizes: prize8({
            1: {
              type: 'partner',
              label: 'x',
              couponId: platform!.id,
              bizImage: 'https://img.example/x.png',
            },
          }),
        },
        'wheel-tester',
        campusId,
      ),
    ).rejects.toThrow('异业券不存在或不属于本校区');
    // partner 行配券后图片可缺省 → 过
    await admin.upsertWheel(
      {
        active: true,
        prizes: prize8({
          1: { type: 'partner', label: 'x', couponId: partner!.id },
        }),
      },
      'wheel-tester',
      campusId,
    );
  });
});
