import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';

/**
 * 优惠券领取/核销明细（IKRSIX #99/#184）：UserCoupon 行级视图 join
 * 用户（脱敏）/券模板/核销订单（Order.couponId=UserCoupon.id）+ 筛选参数。
 */
describe('coupon records (IKRSIX #99/#184)', () => {
  const db = new PrismaService();
  const service = new AdminService(db, new BusinessService(db));
  const CAMPUS = 'campus-coupon-records-test';
  const seed = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  let couponA = '';
  let couponB = '';
  let userId = '';
  const orderIds: string[] = [];

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '券明细测试大学',
        shortName: '券明细测试',
        warehouseName: '券明细测试仓',
      },
    });
    const [a, b] = await Promise.all([
      db.coupon.create({
        data: {
          campusId: CAMPUS,
          name: '满10减2',
          amount: 200,
          threshold: 1000,
          status: 'active',
        },
      }),
      db.coupon.create({
        data: {
          campusId: CAMPUS,
          name: '满20减5',
          amount: 500,
          threshold: 2000,
          status: 'active',
        },
      }),
    ]);
    couponA = a.id;
    couponB = b.id;
    const user = await db.user.create({
      data: {
        campusId: CAMPUS,
        nickname: '券明细用户',
        phone: '13900001111',
        role: 'user',
      },
    });
    userId = user.id;
    // 一张已核销（status=used + Order.couponId 直存 UserCoupon.id）、
    // 一张仅领取、一张已释放
    const used = await db.userCoupon.create({
      data: { userId, couponId: couponA, status: 'used', claimedAt: new Date('2026-10-01T08:00:00+08:00') },
    });
    await db.userCoupon.create({
      data: { userId, couponId: couponB, status: 'claimed', claimedAt: new Date('2026-10-02T08:00:00+08:00') },
    });
    await db.userCoupon.create({
      data: { userId, couponId: couponB, status: 'released', claimedAt: new Date('2026-10-03T08:00:00+08:00') },
    });
    const order = await db.order.create({
      data: {
        id: `cr-order-${seed}`,
        orderNo: `CRC${seed}`,
        userId,
        campusId: CAMPUS,
        status: 'completed',
        statusText: '已完成',
        paidAt: new Date('2026-10-05T12:00:00+08:00'),
        address: {},
        deliveryMode: 'instant',
        items: [],
        productAmount: 2000,
        totalQuantity: 1,
        deliveryThreshold: 1000,
        deliveryFee: 0,
        discount: 200,
        payableAmount: 1800,
        estimatedArrival: '',
        timeline: [],
        couponId: used.id,
      },
    });
    orderIds.push(order.id);
  });

  afterAll(async () => {
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.userCoupon.deleteMany({ where: { userId } });
    await db.coupon.deleteMany({ where: { campusId: CAMPUS } });
    await db.user.deleteMany({ where: { campusId: CAMPUS } });
    await db.campus.delete({ where: { id: CAMPUS } });
    await db.$disconnect();
  });

  it('join 用户脱敏/券名/核销订单，按领取时间倒序', async () => {
    const { items, total } = paginateLike(
      await service.couponRecords(CAMPUS, {}),
    );
    expect(total).toBe(3);
    const usedRow = items.find((x) => x.status === 'used')!;
    expect(usedRow.couponId).toBe(couponA);
    expect(usedRow.couponName).toBe('满10减2');
    expect(usedRow.userNickname).toBe('券明细用户');
    // 手机号脱敏：保留前 3 后 4（orders 列表同口径 maskPhone）
    expect(usedRow.userPhone).toBe('139****1111');
    // 核销单号回查 + usedAt=核销订单 paidAt（ISO）
    expect(usedRow.orderNo).toBe(`CRC${seed}`);
    expect(usedRow.usedAt).toBe(
      new Date('2026-10-05T12:00:00+08:00').toISOString(),
    );
    const claimedRow = items.find((x) => x.status === 'claimed')!;
    expect(claimedRow.orderNo).toBeNull();
    expect(claimedRow.usedAt).toBeNull();
    expect(claimedRow.couponName).toBe('满20减5');
  });

  it('筛选：couponId/status/用户关键词（昵称/手机号）/领取日期范围', async () => {
    expect(
      paginateLike(await service.couponRecords(CAMPUS, { couponId: couponA }))
        .total,
    ).toBe(1);
    expect(
      paginateLike(await service.couponRecords(CAMPUS, { status: 'used' }))
        .total,
    ).toBe(1);
    expect(
      paginateLike(await service.couponRecords(CAMPUS, { status: 'locked' }))
        .total,
    ).toBe(0);
    // 关键词命中手机号片段（明文匹配，返回仍脱敏）
    expect(
      paginateLike(
        await service.couponRecords(CAMPUS, { keyword: '13900001111' }),
      ).total,
    ).toBe(3);
    expect(
      paginateLike(await service.couponRecords(CAMPUS, { keyword: '无此人' }))
        .total,
    ).toBe(0);
    // claimedAt 日期范围（北京时间自然日闭区间）
    expect(
      paginateLike(
        await service.couponRecords(CAMPUS, {
          start: '2026-10-01',
          end: '2026-10-01',
        }),
      ).total,
    ).toBe(1);
    expect(
      paginateLike(
        await service.couponRecords(CAMPUS, {
          start: '2026-10-02',
          end: '2026-10-03',
        }),
      ).total,
    ).toBe(2);
    // 非法状态拒绝
    await expect(
      service.couponRecords(CAMPUS, { status: 'active' }),
    ).rejects.toThrow('claimed/locked/used/released');
  });

  /** 与控制器 paginate 包裹同构（取首页全量）。 */
  function paginateLike<T>(items: T[]) {
    return { items, page: 1, pageSize: 20, total: items.length };
  }
});
