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
      data: { id: userId, campusId, nickname: '转盘测试', phone: '00000000000' },
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

  afterAll(async () => {
    await db.lotteryDraw.deleteMany({ where: { userId } });
    await db.userCoupon.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: { startsWith: 'wheel-test-' } } });
    await db.coupon.deleteMany({ where: { name: { startsWith: '转盘测试' } } });
    await db.lotteryWheel.deleteMany({ where: { campusId } });
    await db.$disconnect();
  });

  it('rejects draw when wheel is not configured', async () => {
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
        prizes: prize8({ 0: { type: 'coupon', label: '5元券', couponId: coupon.id, weight: 1000 } }),
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
        prizes: prize8({ 3: { type: 'coupon', label: '必中位', couponId: coupon.id, weight: 1000 } }),
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
          prizes: prize8({ 2: { type: 'coupon', label: 'x', couponId: coupon.id } }),
        },
        'wheel-tester',
        campusId,
      ),
    ).rejects.toThrow('不属于本校区');
  });
});
