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

  // ---------- IKAJT2：选校区/切换流程 ----------
  it('campusOptions: 仅开放校区，官方库伪校区与停用校区不出现', async () => {
    const options = (await service.campusOptions()) as Array<{
      id: string;
    }>;
    expect(options.map((x) => x.id)).toContain(CAMPUS_A);
    expect(options.map((x) => x.id)).not.toContain('campus-official');
    await db.campus.create({
      data: {
        id: 'campus-inactive-t2',
        name: '停用校区T2',
        shortName: '停用T2',
        warehouseName: '停用仓',
        status: 'inactive',
      },
    });
    const refreshed = (await service.campusOptions()) as Array<{ id: string }>;
    expect(refreshed.map((x) => x.id)).not.toContain('campus-inactive-t2');
    await db.campus.delete({ where: { id: 'campus-inactive-t2' } });
  });

  it('switchUserCampus: 换区清旧区购物车、旧区地址去默认，跨区地址不可结算', async () => {
    const tag = `ikajt2-${Date.now()}`;
    // A 校商品（购物车金额过 A 校门槛）
    const productA = await db.product.create({
      data: {
        campusId: CAMPUS_A,
        categoryId: 'snack',
        name: `${tag}-切换测试A品`,
        subtitle: '',
        price: 2000,
        originalPrice: 2000,
        stock: 10,
        tag: '',
        image: '',
        weight: 0,
        status: 'on-sale',
      },
    });
    // 用户落在 B 校：B 校购物车 + B 校默认地址
    const user = await db.user.create({
      data: {
        campusId: CAMPUS_B,
        nickname: `${tag}-用户`,
        phone: '',
        role: 'user',
      },
    });
    await db.cartItem.create({
      data: { userId: user.id, productId: productB, quantity: 2 },
    });
    const addressB = await db.address.create({
      data: {
        userId: user.id,
        campusId: CAMPUS_B,
        campusName: '隔离测试大学',
        buildingId: '',
        buildingName: '隔离测试 1 栋',
        floor: 1,
        room: '101',
        contactName: '测试',
        phone: '13800000000',
        isDefault: true,
      },
    });
    try {
      // 切到 A 校：campusId 生效、B 校购物车被清、B 校地址保留但去默认
      const switched = await service.switchUserCampus(user.id, CAMPUS_A);
      expect(switched.campusId).toBe(CAMPUS_A);
      const cart = await service.cart(user.id);
      expect(cart.items).toHaveLength(0);
      const kept = await db.address.findUniqueOrThrow({
        where: { id: addressB.id },
      });
      expect(kept.isDefault).toBe(false);
      // 同校区重复切换幂等
      await expect(
        service.switchUserCampus(user.id, CAMPUS_A),
      ).resolves.toBeTruthy();
      // 非开放校区被拒
      await expect(
        service.switchUserCampus(user.id, 'campus-not-exists'),
      ).rejects.toThrow('校区不存在或暂未开放');
      // A 校有车有货，但用 B 校地址结算 → 校区守卫拦截
      await db.cartItem.create({
        data: { userId: user.id, productId: productA.id, quantity: 1 },
      });
      await expect(
        service.checkout(user.id, CAMPUS_A, {
          addressId: addressB.id,
          deliveryMode: 'instant',
          couponId: undefined,
        } as never),
      ).rejects.toThrow('请选择当前校区的收货地址');
      // 切回 B 校：商品/价格回到 B 校口径
      const back = await service.switchUserCampus(user.id, CAMPUS_B);
      expect(back.campusId).toBe(CAMPUS_B);
      const cartB = await service.cart(user.id);
      expect(cartB.items).toHaveLength(0); // A 校车同样被清
    } finally {
      await db.cartItem.deleteMany({ where: { userId: user.id } });
      await db.address.deleteMany({ where: { userId: user.id } });
      await db.product.deleteMany({ where: { id: productA.id } });
      await db.user.deleteMany({ where: { id: user.id } });
    }
  });
});
