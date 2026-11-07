import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';

describe('dashboard coupon consumption', () => {
  const db = new PrismaService();
  const service = new AdminService(db, new BusinessService(db));
  const orderIds: string[] = [];
  const ownUsers: string[] = [], ownCampuses: string[] = [];
  beforeAll(async () => {
    for (const label of ['甲', '乙']) {
      const campus = await db.campus.create({ data: { name: `券统计隔离${label}`, shortName: label, warehouseName: label } });
      ownCampuses.push(campus.id);
      const user = await db.user.create({ data: { campusId: campus.id, nickname: `券统计用户${label}`, phone: label === "甲" ? "13800009903" : "13800009904" } });
      ownUsers.push(user.id);
    }
  });

  afterAll(async () => {
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.user.deleteMany({ where: { id: { in: ownUsers } } });
    await db.campus.deleteMany({ where: { id: { in: ownCampuses } } });
    await db.$disconnect();
  });

  it('uses today paid orders and keeps the single-campus total isolated', async () => {
    const users = await db.user.findMany({
      where: { id: { in: ownUsers } },
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
