import { PrismaService } from '../database/prisma.service';
import { BusinessService } from './business.service';

/**
 * 限时特价引擎集成测试（ADR-0006 / IKAHFE）：
 * 窗口内外回落、生效价单一事实（cart/列表/详情/下单快照）、券叠加、
 * 多活动确定性（endsAt 最近优先）。独立 fixture，afterAll 清理。
 */
describe('Promotion engine (ADR-0006)', () => {
  const db = new PrismaService();
  const service = new BusinessService(db);
  const CAMPUS = 'campus-promo-spec';
  const USER = 'user-promo-spec';
  const PRODUCT = 'product-promo-spec';
  const PROMO_ACTIVE = 'promo-spec-active';
  const PROMO_OVERLAP = 'promo-spec-overlap';
  const COUPON = 'coupon-promo-spec';
  const USER_COUPON = 'uc-promo-spec';
  const ADDRESS = 'addr-promo-spec';

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '促销测试校园',
        shortName: '促销',
        warehouseName: '促销仓',
      } as any,
    });
    await db.user.create({
      data: {
        id: USER,
        openid: 'openid-promo-spec',
        nickname: '促销测试用户',
        phone: '13800000001',
        campusId: CAMPUS,
      } as any,
    });
    await db.category.create({
      data: { id: 'cat-promo-spec', name: '促销测试分类' } as any,
    });
    await db.product.create({
      data: {
        id: PRODUCT,
        campusId: CAMPUS,
        categoryId: 'cat-promo-spec',
        name: '促销测试可乐',
        subtitle: 'spec',
        price: 500,
        originalPrice: 600,
        stock: 50,
        tag: 'spec',
        image: '',
        weight: 0.5,
      } as any,
    });
    await db.address.create({
      data: {
        id: ADDRESS,
        userId: USER,
        campusId: CAMPUS,
        campusName: '促销测试校园',
        buildingId: 'building-promo-spec',
        buildingName: '测试楼',
        floor: 1,
        room: '101',
        contactName: 'spec',
        phone: '13800000000',
        isDefault: true,
      } as any,
    });
  });

  afterAll(async () => {
    await db.promotion.deleteMany({ where: { id: { in: [PROMO_ACTIVE, PROMO_OVERLAP] } } });
    await db.order.deleteMany({ where: { userId: USER } });
    await db.userCoupon.deleteMany({
      where: { id: { in: [USER_COUPON, 'uc-promo-huge', 'uc-promo-exact'] } },
    });
    await db.coupon.deleteMany({
      where: { id: { in: [COUPON, 'coupon-promo-huge', 'coupon-promo-exact'] } },
    });
    await db.cartItem.deleteMany({ where: { userId: USER } });
    await db.address.deleteMany({ where: { id: ADDRESS } });
    await db.product.deleteMany({ where: { id: PRODUCT } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.category.deleteMany({ where: { id: 'cat-promo-spec' } });
    await db.campus.deleteMany({ where: { id: CAMPUS } });
    await db.$disconnect();
  });

  it('falls back to base price before the window opens and after it ends', async () => {
    const past = await db.promotion.create({
      data: {
        id: 'promo-spec-past',
        productId: PRODUCT,
        type: 'seckill',
        price: 300,
        startsAt: new Date(Date.now() - 2 * 3600_000),
        endsAt: new Date(Date.now() - 3600_000),
      },
    });
    const detail = await service.product(PRODUCT, CAMPUS);
    expect(detail.price).toBe(500);
    expect((detail as any).promotion).toBeUndefined();
    await db.promotion.delete({ where: { id: past.id } });
  });

  it('uses promo price everywhere once active (list/detail/cart) with base price as strikethrough', async () => {
    await db.promotion.create({
      data: {
        id: PROMO_ACTIVE,
        productId: PRODUCT,
        type: 'seckill',
        price: 350,
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 3600_000),
      },
    });
    const [list, detail] = await Promise.all([
      service.listProducts(CAMPUS),
      service.product(PRODUCT, CAMPUS),
    ]);
    for (const view of [list.find((p: any) => p.id === PRODUCT), detail]) {
      expect(view.price).toBe(350);
      expect(view.originalPrice).toBe(500);
      expect((view as any).promotion.type).toBe('seckill');
      expect((view as any).promotion.price).toBe(350);
    }
    await db.cartItem.create({
      data: { userId: USER, productId: PRODUCT, quantity: 2 },
    });
    const cart = await service.cart(USER);
    expect(cart.productAmount).toBe(700); // 350 × 2
    expect(cart.items[0].product.price).toBe(350);
  });

  it('picks the soonest-ending promotion deterministically when windows overlap', async () => {
    await db.promotion.create({
      data: {
        id: PROMO_OVERLAP,
        productId: PRODUCT,
        type: 'clearance',
        price: 200,
        startsAt: new Date(Date.now() - 30_000),
        endsAt: new Date(Date.now() + 1800_000), // 比 active 更早结束
      },
    });
    const detail = await service.product(PRODUCT, CAMPUS);
    expect(detail.price).toBe(200); // endsAt 最近者胜（清仓优先）
    expect((detail as any).promotion.type).toBe('clearance');
    await db.promotion.delete({ where: { id: PROMO_OVERLAP } });
    const back = await service.product(PRODUCT, CAMPUS);
    expect(back.price).toBe(350);
  });

  it('stacks coupon on promo-priced amount and snapshots the deal at order time', async () => {
    // 数量提到 3：促销后 1050 需过 ¥10 起送门槛（促销后金额照常判门槛，ADR-0006）
    await db.cartItem.update({
      where: { userId_productId: { userId: USER, productId: PRODUCT } },
      data: { quantity: 3 },
    });
    // 满 600 减 100（分）券：促销后 1050 过门槛，payable = 1050 + 400 运费 - 100
    await db.coupon.create({
      data: {
        id: COUPON,
        campusId: CAMPUS,
        name: '促销叠加券',
        amount: 100,
        threshold: 600,
        total: 10,
        status: 'active',
        expiresAt: new Date(Date.now() + 86400_000),
      } as any,
    });
    await db.userCoupon.create({
      data: {
        id: USER_COUPON,
        userId: USER,
        couponId: COUPON,
        status: 'claimed',
        claimedAt: new Date(),
      },
    });
    const quote = await service.checkout(USER, CAMPUS, {
      addressId: ADDRESS,
      deliveryMode: 'instant',
      deliverySlot: '',
      couponId: USER_COUPON,
    } as any);
    expect(quote.productAmount).toBe(1050);
    expect(quote.discount).toBe(100);
    expect(quote.deliveryFee).toBe(400);
    expect(quote.payableAmount).toBe(1350);

    const order = await service.createOrder(USER, CAMPUS, {
      addressId: ADDRESS,
      deliveryMode: 'instant',
      deliverySlot: '',
      couponId: USER_COUPON,
      remark: '',
    } as any);
    // 下单锁价：快照行带促销价与 promotionId（ADR-0006）
    const line = (order.items as any[]).find(
      (i) => i.product.id === PRODUCT,
    );
    expect(line.product.price).toBe(350);
    expect(line.product.promotion.id).toBe(PROMO_ACTIVE);

    // 活动停用（读时回落）不影响已下单据金额
    await db.promotion.update({
      where: { id: PROMO_ACTIVE },
      data: { status: 'disabled' },
    });
    const cartAfter = await service.cart(USER);
    expect(cartAfter.items[0].product.price).toBe(500);
    expect(cartAfter.productAmount).toBe(1500);
    const orderRe = await db.order.findUnique({ where: { id: order.id } });
    expect(orderRe!.payableAmount).toBe(order.payableAmount);
  });

  // IKB3K1：无门槛大额券负数单——拦截 + 下限 0 + 券列表标注
  it('blocks coupons that would drive the order negative and floors payable at 0', async () => {
    // 上一用例已停用促销：购物车 3 × 500 = 1500，即时时运费 400，订单金额 1900
    const mk = async (couponId: string, ucId: string, amount: number) => {
      await db.coupon.create({
        data: {
          id: couponId,
          campusId: CAMPUS,
          name: `无门槛券${amount}`,
          amount,
          threshold: 0,
          total: 10,
          status: 'active',
          expiresAt: new Date(Date.now() + 86400_000),
        } as any,
      });
      await db.userCoupon.create({
        data: {
          id: ucId,
          userId: USER,
          couponId,
          status: 'claimed',
          claimedAt: new Date(),
        },
      });
    };
    await mk('coupon-promo-huge', 'uc-promo-huge', 2000); // 抵扣 > 1900
    await mk('coupon-promo-exact', 'uc-promo-exact', 1900); // 恰好抵到 0
    const dto = {
      addressId: ADDRESS,
      deliveryMode: 'instant',
      deliverySlot: '',
    } as any;

    await expect(
      service.checkout(USER, CAMPUS, { ...dto, couponId: 'uc-promo-huge' }),
    ).rejects.toThrow('该单无法使用此优惠券');

    const quote = await service.checkout(USER, CAMPUS, {
      ...dto,
      couponId: 'uc-promo-exact',
    });
    expect(quote.payableAmount).toBe(0);
    expect(quote.discount).toBe(1900);

    const list = await service.availableCoupons(USER, CAMPUS, dto);
    const huge = list.find((x: any) => x.id === 'uc-promo-huge')!;
    const exact = list.find((x: any) => x.id === 'uc-promo-exact')!;
    expect(huge.available).toBe(false);
    expect(huge.unavailableReason).toBe('该单无法使用此优惠券');
    expect(exact.available).toBe(true);
  });
});
