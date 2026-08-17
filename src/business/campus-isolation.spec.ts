import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AdminService } from '../admin/admin.service';
import { BusinessService } from './business.service';

/** service 返回 any 视图，这里显式收窄避免 unsafe 访问。 */
type IdLike = { id: string };

/**
 * 多校园隔离守护测试（IK8W5J）：
 * 校园 A 的 token（campus-hbut）不得看到/操作校园 B 的商品、订单、优惠券。
 * 本批为 service 层全量过滤（不做 ORM 全局中间层），此 spec 防止回退。
 */
describe('cross-campus isolation (IK8W5J)', () => {
  const db = new PrismaService();
  const service = new BusinessService(db);
  const admin = new AdminService(db, service);
  const CAMPUS_A = 'campus-hbut';
  const CAMPUS_B = 'campus-test-b';
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  let userB = '';
  let productB = '';
  let couponB = '';
  let orderB = '';

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS_B,
        name: '隔离测试大学',
        shortName: '隔离测试',
        warehouseName: '隔离测试校园仓',
      },
    });
    userB = (
      await db.user.create({
        data: {
          campusId: CAMPUS_B,
          nickname: '隔离测试用户',
          phone: '13900000002',
          role: 'user',
        },
      })
    ).id;
    productB = (
      await db.product.create({
        data: {
          campusId: CAMPUS_B,
          categoryId: 'drink',
          name: '隔离测试专属可乐',
          subtitle: '仅 B 校园在售',
          price: 3,
          originalPrice: 4,
          stock: 10,
          tag: '测试',
          image: '',
          weight: 0.5,
          status: 'on-sale',
        },
      })
    ).id;
    couponB = (
      await db.coupon.create({
        data: {
          campusId: CAMPUS_B,
          name: '隔离测试券',
          amount: 5,
          threshold: 20,
          total: 100,
          status: 'active',
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        },
      })
    ).id;
    const order = await db.order.create({
      data: {
        orderNo: `BCQISO${Date.now()}`,
        userId: userB,
        campusId: CAMPUS_B,
        status: 'paid',
        statusText: '仓库正在接单',
        address: json({
          buildingName: '隔离测试 1 栋',
          floor: 1,
          room: '101',
        }),
        deliveryMode: 'instant',
        items: json([]),
        productAmount: 10,
        totalQuantity: 1,
        deliveryThreshold: 10,
        deliveryFee: 2,
        discount: 0,
        payableAmount: 12,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json([]),
      },
    });
    orderB = order.id;
  });

  afterAll(async () => {
    await db.order.deleteMany({ where: { id: orderB } });
    await db.product.deleteMany({ where: { id: productB } });
    await db.coupon.deleteMany({ where: { id: couponB } });
    await db.userCoupon.deleteMany({ where: { couponId: couponB } });
    await db.user.deleteMany({ where: { id: userB } });
    await db.campus.delete({ where: { id: CAMPUS_B } });
    await db.$disconnect();
  });

  it('products: campus-A listing must not leak campus-B products', async () => {
    const listA = (await service.listProducts(CAMPUS_A)) as IdLike[];
    expect(listA.every((x) => x.id !== productB)).toBe(true);
    const homeA = (await service.home(CAMPUS_A)) as {
      hotProducts: IdLike[];
    };
    expect(homeA.hotProducts.every((x) => x.id !== productB)).toBe(true);
    const listB = (await service.listProducts(CAMPUS_B)) as IdLike[];
    expect(listB.map((x) => x.id)).toEqual([productB]);
    await expect(service.product(productB, CAMPUS_A)).rejects.toThrow(
      '商品不存在',
    );
  });

  it('orders: campus-B orders must be invisible to campus-A admin/users', async () => {
    // 用户端：A 校用户查不到 B 校订单（userId 天然隔离）。
    const mineA = (await service.orders('user-001')) as IdLike[];
    expect(mineA.every((x) => x.id !== orderB)).toBe(true);
    // 管理端：B 校列表只含 B 校订单，A 校列表不含 B 校订单。
    const adminB = (await admin.orders('all', CAMPUS_B)) as Array<
      IdLike & { campusId: string }
    >;
    expect(adminB.map((x) => x.id)).toContain(orderB);
    expect(adminB.every((x) => x.campusId === CAMPUS_B)).toBe(true);
    const adminA = (await admin.orders('all', CAMPUS_A)) as IdLike[];
    expect(adminA.every((x) => x.id !== orderB)).toBe(true);
    await expect(admin.order(orderB, CAMPUS_A)).rejects.toThrow('订单不存在');
  });

  it('coupons: campus-A user cannot claim a campus-B coupon', async () => {
    await expect(
      service.claimCoupon('user-001', couponB, CAMPUS_A),
    ).rejects.toThrow('该优惠券不属于当前校园');
    const claimableA = await service.coupons('user-001', CAMPUS_A);
    expect(claimableA.claimable.every((x) => x.id !== couponB)).toBe(true);
    const claimableB = await service.coupons(userB, CAMPUS_B);
    expect(claimableB.claimable.map((x) => x.id)).toContain(couponB);
  });
});
