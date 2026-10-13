import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';

describe('dashboard coupon consumption', () => {
  const db = new PrismaService();
  const service = new AdminService(db, new BusinessService(db));
  const orderIds: string[] = [];

  afterAll(async () => {
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.$disconnect();
  });

  it('uses today paid orders and keeps the single-campus total isolated', async () => {
    const users = await db.user.findMany({
      where: { campus: { status: { not: 'official' } } },
      distinct: ['campusId'],
      orderBy: { campusId: 'asc' },
      take: 2,
    });
    expect(users).toHaveLength(2);
    const [targetUser, otherUser] = users;
    const [multiBefore, singleBefore] = await Promise.all([
      service.dashboard(''),
      service.dashboard(targetUser.campusId),
    ]);

    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const seed = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const fixtures = [
      {
        id: `coupon-target-${seed}`,
        user: targetUser,
        status: 'paid',
        paidAt: now,
        discount: 137,
      },
      {
        id: `coupon-other-${seed}`,
        user: otherUser,
        status: 'paid',
        paidAt: now,
        discount: 211,
      },
      {
        id: `coupon-old-${seed}`,
        user: targetUser,
        status: 'paid',
        paidAt: yesterday,
        discount: 307,
      },
      {
        id: `coupon-pending-${seed}`,
        user: targetUser,
        status: 'pending-payment',
        paidAt: now,
        discount: 401,
      },
      {
        id: `coupon-cancelled-${seed}`,
        user: targetUser,
        status: 'cancelled',
        paidAt: now,
        discount: 503,
      },
    ];
    orderIds.push(...fixtures.map(({ id }) => id));
    await db.order.createMany({
      data: fixtures.map(({ id, user, status, paidAt, discount }) => ({
        id,
        orderNo: id,
        userId: user.id,
        campusId: user.campusId,
        status,
        statusText: status,
        createdAt: yesterday,
        paidAt,
        address: {},
        deliveryMode: 'immediate',
        items: [],
        productAmount: 1000,
        totalQuantity: 1,
        deliveryThreshold: 0,
        deliveryFee: 0,
        discount,
        payableAmount: 1000 - discount,
        estimatedArrival: '',
        timeline: [],
      })),
    });

    const [multiAfter, singleAfter] = await Promise.all([
      service.dashboard(''),
      service.dashboard(targetUser.campusId),
    ]);

    expect(multiAfter.kpis.coupon - multiBefore.kpis.coupon).toBe(137 + 211);
    expect(singleAfter.kpis.coupon - singleBefore.kpis.coupon).toBe(137);
    expect(singleAfter.caliber.coupon).toContain('discount');
  });
});
