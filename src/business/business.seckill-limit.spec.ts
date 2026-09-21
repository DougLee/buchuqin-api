import type { Prisma } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { buildOrderTimeline } from '../common/order-state';
import { BusinessService } from './business.service';

/**
 * 秒杀限购集成测试（IKG8FF/IKHL6Y）：同一用户同一秒杀商品每活动限 1 件——
 * IKHL6Y 秒杀双渠道后，限购与秒杀价只作用于「秒杀身份行」（秒杀专区入口）；
 * 正常渠道（目录/搜索/详情/原价行）恢复原价、不限购、买过秒杀照常买。
 * 独立 fixture，afterAll 清理。
 */
describe('seckill per-user limit (IKG8FF)', () => {
  const db = new PrismaService();
  const service = new BusinessService(db);
  const CAMPUS = 'campus-seckill-spec';
  const USER = 'user-seckill-spec';
  const CAT = 'cat-seckill-spec';
  const SKU = 'sku-seckill-spec';
  const SKU_CL = 'sku-seckill-clearance';
  // IKGNMV（一单一秒杀）：第二个秒杀 SKU
  const SKU2 = 'sku-seckill-spec-b';
  const PROMO = 'promo-seckill-spec';
  const PROMO_CL = 'promo-clearance-spec';
  const PROMO2 = 'promo-seckill-spec-b';
  const PROMO_PAST = 'promo-seckill-spec-past';
  const ADDR = 'addr-seckill-spec';
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

  /** 活动窗：过去 1 小时 ~ 未来 1 天（判定边界内）。 */
  const startsAt = new Date(Date.now() - 3600_000);
  const endsAt = new Date(Date.now() + 86_400_000);

  const orderNo = () =>
    `BCQSK${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  /** 造已支付订单：items 快照带 promotion 锁价块（判定依据 IKG8FF）。 */
  const makePaidOrder = async (
    productId: string,
    promoId: string,
    status = 'completed',
    paidAt = new Date(),
  ) => {
    const p = await db.product.findUniqueOrThrow({ where: { id: productId } });
    return db.order.create({
      data: {
        orderNo: orderNo(),
        userId: USER,
        campusId: CAMPUS,
        status,
        statusText: '测试',
        address: json({ buildingName: '测试楼', room: '101' }),
        deliveryMode: 'instant',
        items: json([
          {
            product: {
              id: p.id,
              name: p.name,
              price: 1500,
              originalPrice: Number(p.price),
              categoryId: p.categoryId,
              promotion: { id: promoId, type: 'seckill', price: 1500, endsAt },
            },
            quantity: 1,
          },
        ]),
        productAmount: 1500,
        totalQuantity: 1,
        deliveryThreshold: 10,
        deliveryFee: 4,
        discount: 0,
        payableAmount: 1504,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json(buildOrderTimeline('测试楼 101')),
        paidAt,
      },
    });
  };

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '秒杀限购测试校园',
        shortName: '限购',
        warehouseName: '限购仓',
      } as any,
    });
    await db.user.create({
      data: {
        id: USER,
        openid: 'openid-seckill-spec',
        nickname: '限购测试用户',
        phone: '13800000011',
        campusId: CAMPUS,
      } as any,
    });
    await db.category.create({
      data: { id: CAT, name: '秒杀限购测试分类' } as any,
    });
    await db.product.create({
      data: {
        id: SKU,
        campusId: CAMPUS,
        categoryId: CAT,
        name: '限购测试可乐',
        subtitle: 'spec',
        price: 2000,
        originalPrice: 2500,
        stock: 50,
        tag: 'spec',
        image: '',
        weight: 0.5,
      } as any,
    });
    await db.product.create({
      data: {
        id: SKU_CL,
        campusId: CAMPUS,
        categoryId: CAT,
        name: '临期特惠测试面',
        subtitle: 'spec',
        price: 2000,
        originalPrice: 2500,
        stock: 50,
        tag: 'spec',
        image: '',
        weight: 0.5,
      } as any,
    });
    await db.product.create({
      data: {
        id: SKU2,
        campusId: CAMPUS,
        categoryId: CAT,
        name: '限购测试辣条B',
        subtitle: 'spec',
        price: 2000,
        originalPrice: 2500,
        stock: 50,
        tag: 'spec',
        image: '',
        weight: 0.5,
      } as any,
    });
    await db.promotion.create({
      data: {
        id: PROMO,
        productId: SKU,
        type: 'seckill',
        price: 1500,
        startsAt,
        endsAt,
      } as any,
    });
    await db.promotion.create({
      data: {
        id: PROMO_CL,
        productId: SKU_CL,
        type: 'clearance',
        price: 1500,
        startsAt,
        endsAt,
      } as any,
    });
    await db.promotion.create({
      data: {
        id: PROMO2,
        productId: SKU2,
        type: 'seckill',
        price: 1600,
        startsAt,
        endsAt,
      } as any,
    });
    await db.address.create({
      data: {
        id: ADDR,
        userId: USER,
        campusId: CAMPUS,
        campusName: '秒杀限购测试校园',
        buildingId: 'building-seckill-spec',
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
    await db.order.deleteMany({ where: { userId: USER } });
    await db.cartItem.deleteMany({ where: { userId: USER } });
    await db.promotion.deleteMany({
      where: { id: { in: [PROMO, PROMO_CL, PROMO2, PROMO_PAST] } },
    });
    await db.product.deleteMany({ where: { id: { in: [SKU, SKU_CL, SKU2] } } });
    await db.address.deleteMany({ where: { id: ADDR } });
    await db.category.deleteMany({ where: { id: CAT } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.campus.deleteMany({ where: { id: CAMPUS } });
  });

  it('IKHL6Y：正常渠道原价且无秒杀痕迹；秒杀专区秒杀价+限购', async () => {
    // 详情（正常渠道）：原价、不挂秒杀价/限购；clearance 特惠保留
    const detail = (await service.product(SKU, CAMPUS, USER)) as any;
    expect(detail.price).toBe(2000);
    expect(detail.promotion).toBeUndefined();
    expect(detail.seckillLimit).toBeUndefined();
    const clearance = (await service.product(SKU_CL, CAMPUS, USER)) as any;
    expect(clearance.price).toBe(1500);
    expect(clearance.seckillLimit).toBeUndefined();
    // 正常目录：秒杀商品原价露出
    const list = (await service.listProducts(CAMPUS)) as any[];
    const inList = list.find((p) => p.id === SKU);
    expect(inList.price).toBe(2000);
    expect(inList.promotion).toBeUndefined();
    // 秒杀专区：秒杀价 + 限购资格挂载
    const secs = (await service.listSeckill(CAMPUS, USER)) as any[];
    const inSecs = secs.find((p) => p.id === SKU);
    expect(inSecs.price).toBe(1500);
    expect(inSecs.seckillLimit).toEqual({ limit: 1, purchased: false });
  });

  it('秒杀行加购数量上限 1 件；原价行不限购（IKHL6Y）', async () => {
    await expect(
      service.setCartItem(USER, SKU, 2, true),
    ).rejects.toThrow(BadRequestException);
    // 双渠道核心：同一秒杀商品按原价行可买 2 件
    await expect(service.setCartItem(USER, SKU, 2)).resolves.toBeTruthy();
    const cart = (await service.cart(USER)) as any;
    expect(cart.items[0].product.price).toBe(2000); // 原价
    expect(cart.items[0].asSeckill).toBe(false);
    await service.setCartItem(USER, SKU, 0);
  });

  it('临期特惠商品不限购：2 件可加购', async () => {
    await expect(service.setCartItem(USER, SKU_CL, 2)).resolves.toBeTruthy();
    await service.setCartItem(USER, SKU_CL, 0); // 清行，不影响后续用例
  });

  it('IKHL6Y：同一商品购物车单一身份——跨身份再加拒绝', async () => {
    await service.setCartItem(USER, SKU, 1, true); // 秒杀行入车
    // 已有秒杀行，原价入口再加 → 拒
    await expect(service.setCartItem(USER, SKU, 1)).rejects.toThrow(
      '已按秒杀价加购',
    );
    await service.setCartItem(USER, SKU, 0);
    // 已有原价行，秒杀入口再加 → 拒
    await service.setCartItem(USER, SKU, 1);
    await expect(service.setCartItem(USER, SKU, 1, true)).rejects.toThrow(
      '原价购买',
    );
    await service.setCartItem(USER, SKU, 0);
  });

  it('已购（已支付订单）后：秒杀行拒绝 + 正常渠道照常原价购买', async () => {
    await service.setCartItem(USER, SKU, 1, true); // 秒杀行入车（此时未购，合法）
    const order = await makePaidOrder(SKU, PROMO); // 另一单已支付
    await expect(
      service.setCartItem(USER, SKU, 1, true),
    ).rejects.toThrow('您已抢购过该商品');
    const detail = (await service.product(SKU, CAMPUS, USER)) as any;
    expect(detail.seckillLimit).toBeUndefined(); // 正常渠道无秒杀痕迹
    // 同商品已有秒杀行：原价入口撞身份冲突（先移除）
    await expect(service.setCartItem(USER, SKU, 1)).rejects.toThrow(
      '已按秒杀价加购',
    );
    // 车里还是秒杀行：结算兜底拦（名额被上面订单占掉）
    await expect(
      service.checkout(USER, CAMPUS, {
        addressId: ADDR,
        deliveryMode: 'instant',
      } as any),
    ).rejects.toThrow('每人限购 1 件');
    await service.setCartItem(USER, SKU, 0);
    // 移除秒杀行后：已购状态下原价通道畅通（买过秒杀也能按原价买，双渠道）
    await expect(service.setCartItem(USER, SKU, 1)).resolves.toBeTruthy();
    const cart = await service.cart(USER);
    const line = cart.items.find((i) => i.product.id === SKU) as any;
    expect(line.asSeckill).toBe(false);
    expect(line.product.seckillLimit).toBeUndefined();
    await expect(
      service.checkout(USER, CAMPUS, {
        addressId: ADDR,
        deliveryMode: 'instant',
      } as any),
    ).resolves.toBeTruthy();
    await db.order.delete({ where: { id: order.id } });
    await service.setCartItem(USER, SKU, 0);
  });

  it('updateCart 全量替换同样拦截：秒杀行数量 >1 拒绝', async () => {
    await expect(
      service.updateCart(USER, {
        items: [{ productId: SKU, quantity: 2, asSeckill: true }],
      } as any),
    ).rejects.toThrow('每人限购 1 件');
  });

  it('窗外订单不占名额：paidAt 早于活动开始可正常加购', async () => {
    const order = await makePaidOrder(
      SKU,
      PROMO,
      'completed',
      new Date(startsAt.getTime() - 86_400_000),
    );
    await expect(service.setCartItem(USER, SKU, 1, true)).resolves.toBeTruthy();
    await db.order.delete({ where: { id: order.id } });
    await service.setCartItem(USER, SKU, 0);
  });

  it('取消订单不占名额', async () => {
    const order = await makePaidOrder(SKU, PROMO, 'cancelled');
    await expect(service.setCartItem(USER, SKU, 1, true)).resolves.toBeTruthy();
    await db.order.delete({ where: { id: order.id } });
    await service.setCartItem(USER, SKU, 0);
  });

  it('退款释放名额：refunded 后可重新加购 + purchased:false', async () => {
    const order = await makePaidOrder(SKU, PROMO);
    await expect(
      service.setCartItem(USER, SKU, 1, true),
    ).rejects.toThrow('您已抢购过该商品');
    await db.order.update({
      where: { id: order.id },
      data: { status: 'refunded', statusText: '已退款' },
    });
    await expect(service.setCartItem(USER, SKU, 1, true)).resolves.toBeTruthy();
    const secs = (await service.listSeckill(CAMPUS, USER)) as any[];
    expect(secs.find((p) => p.id === SKU).seckillLimit.purchased).toBe(false);
    await db.order.delete({ where: { id: order.id } });
    await service.setCartItem(USER, SKU, 0);
  });

  // ---------- IKGNMV（一单一秒杀）：订单级秒杀 SKU 品种 ≤1 ----------

  it('IKGNMV：购物车已有秒杀 A 时加秒杀 B 拒绝', async () => {
    await service.setCartItem(USER, SKU, 1, true);
    await expect(service.setCartItem(USER, SKU2, 1, true)).rejects.toThrow(
      '购物车已有秒杀商品，一个订单限一个',
    );
    // 同秒杀品自身超量加购走 IKG8FF 上限文案，不误报一单一秒杀
    await expect(service.setCartItem(USER, SKU, 2, true)).rejects.toThrow(
      '秒杀商品每人限购 1 件',
    );
    await service.setCartItem(USER, SKU, 0);
  });

  it('IKGNMV：cart 出口挂 seckillIdInCart；clearance 与普通商品不受影响', async () => {
    await service.setCartItem(USER, SKU, 1, true);
    const cart = (await service.cart(USER)) as any;
    expect(cart.seckillIdInCart).toBe(SKU);
    await expect(
      service.setCartItem(USER, SKU_CL, 2),
    ).resolves.toBeTruthy(); // clearance 不受限
    await service.setCartItem(USER, SKU_CL, 0);
    await service.setCartItem(USER, SKU, 0);
    const empty = (await service.cart(USER)) as any;
    expect(empty.seckillIdInCart).toBeUndefined();
  });

  it('IKGNMV：删除秒杀 A 后秒杀 B 可正常加购', async () => {
    await service.setCartItem(USER, SKU, 1, true);
    await service.setCartItem(USER, SKU, 0);
    await expect(service.setCartItem(USER, SKU2, 1, true)).resolves.toBeTruthy();
    const cart = (await service.cart(USER)) as any;
    expect(cart.seckillIdInCart).toBe(SKU2);
    await service.setCartItem(USER, SKU2, 0);
  });

  it('IKGNMV：updateCart 全量替换含两个秒杀 SKU 整批拒绝', async () => {
    await service.setCartItem(USER, SKU, 1, true);
    await expect(
      service.updateCart(USER, {
        items: [
          { productId: SKU, quantity: 1, asSeckill: true },
          { productId: SKU2, quantity: 1, asSeckill: true },
        ],
      }),
    ).rejects.toThrow('一个订单限一个秒杀商品');
    // 替换后只留一个秒杀 + 原价行：放行
    await expect(
      service.updateCart(USER, {
        items: [
          { productId: SKU, quantity: 1, asSeckill: true },
          { productId: SKU_CL, quantity: 2 },
        ],
      }),
    ).resolves.toBeTruthy();
    await service.setCartItem(USER, SKU, 0);
  });

  it('IKGNMV：结算兜底——脏数据（直插两秒杀行）checkout 拒绝', async () => {
    await db.cartItem.createMany({
      data: [
        { userId: USER, productId: SKU, quantity: 1, asSeckill: true },
        { userId: USER, productId: SKU2, quantity: 1, asSeckill: true },
      ],
    });
    await expect(
      service.checkout(USER, CAMPUS, {
        addressId: ADDR,
        deliveryMode: 'instant',
      } as any),
    ).rejects.toThrow('一个订单只能包含一个秒杀商品');
    await db.cartItem.deleteMany({ where: { userId: USER } });
  });

  it('IKGNMV：秒杀 B 已购过时优先报已购（文案优先级在品种拦截之前）', async () => {
    await service.setCartItem(USER, SKU, 1, true);
    const order = await makePaidOrder(SKU2, PROMO2);
    await expect(service.setCartItem(USER, SKU2, 1, true)).rejects.toThrow(
      '您已抢购过该商品',
    );
    await db.order.delete({ where: { id: order.id } });
    await service.setCartItem(USER, SKU, 0);
  });

  it('IKHL6Y：秒杀行跟活动窗走——窗外回落原价（展示=结算一致）', async () => {
    await service.setCartItem(USER, SKU, 1, true); // 窗内：秒杀价
    const before = (await service.cart(USER)) as any;
    expect(before.items[0].product.price).toBe(1500);
    expect(before.productAmount).toBe(1500);
    // 活动结束（把窗拨到过去）：同一行自动回落原价
    await db.promotion.update({
      where: { id: PROMO },
      data: { endsAt: new Date(Date.now() - 60_000) },
    });
    const after = (await service.cart(USER)) as any;
    expect(after.items[0].product.price).toBe(2000);
    expect(after.items[0].product.seckillLimit).toBeUndefined();
    expect(after.productAmount).toBe(2000);
    expect(after.seckillIdInCart).toBeUndefined();
    // 恢复活动窗（afterAll 清理前其他断言不受影响）
    await db.promotion.update({ where: { id: PROMO }, data: { endsAt } });
    await service.setCartItem(USER, SKU, 0);
  });

  it('IKHL6Y：秒杀身份加购必须存在进行中活动（防伪造）', async () => {
    await db.promotion.update({
      where: { id: PROMO },
      data: { endsAt: new Date(Date.now() - 60_000) },
    });
    await expect(
      service.setCartItem(USER, SKU, 1, true),
    ).rejects.toThrow('秒杀活动未开始或已结束');
    await db.promotion.update({ where: { id: PROMO }, data: { endsAt } });
  });
});
