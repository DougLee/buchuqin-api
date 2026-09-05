import { PrismaService } from '../database/prisma.service';
import { BusinessService } from './business.service';

/**
 * 购物车售罄/下架商品死循环（IKDFZK）：库存校验只拦「增加」方向、
 * 下架行自动剔除。旧行为（无方向校验 + 下架整批抛错）会把存量行变成
 * 删不掉的钉子户，且连累其他商品保存失败。
 */
describe('Cart sold-out/off-sale escape hatch (IKDFZK)', () => {
  const db = new PrismaService();
  const biz = new BusinessService(db);
  const CAMPUS = 'campus-cart-spec';
  const USER = 'user-cart-spec';
  const SOLD_OUT = 'product-cart-soldout'; // stock=0
  const OFF_SALE = 'product-cart-offsale'; // status=off-sale

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '购物车测试校园',
        shortName: '购物车',
        warehouseName: '购物车仓',
      } as any,
    });
    await db.user.create({
      data: {
        id: USER,
        openid: 'openid-cart-spec',
        nickname: '购物车测试用户',
        phone: '13800000003',
        campusId: CAMPUS,
      } as any,
    });
    await db.category.create({
      data: { id: 'cat-cart-spec', name: '购物车测试分类' } as any,
    });
    await db.product.create({
      data: {
        id: SOLD_OUT,
        campusId: CAMPUS,
        categoryId: 'cat-cart-spec',
        name: '售罄可乐',
        subtitle: 'spec',
        tag: 'spec',
        price: 500,
        originalPrice: 600,
        stock: 0,
        image: '',
        weight: 0.5,
      } as any,
    });
    await db.product.create({
      data: {
        id: OFF_SALE,
        campusId: CAMPUS,
        categoryId: 'cat-cart-spec',
        name: '下架薯片',
        subtitle: 'spec',
        tag: 'spec',
        price: 800,
        originalPrice: 900,
        stock: 10,
        image: '',
        weight: 0.3,
        status: 'off-sale',
      } as any,
    });
    // 场景：售罄行已有 3 份、下架行已有 2 份（钉子户现状）
    await db.cartItem.createMany({
      data: [
        { userId: USER, productId: SOLD_OUT, quantity: 3 },
        { userId: USER, productId: OFF_SALE, quantity: 2 },
      ],
    });
  });

  afterAll(async () => {
    await db.cartItem.deleteMany({ where: { userId: USER } });
    await db.product.deleteMany({
      where: { id: { in: [SOLD_OUT, OFF_SALE] } },
    });
    await db.user.deleteMany({ where: { id: USER } });
    await db.category.deleteMany({ where: { id: 'cat-cart-spec' } });
    await db.campus.deleteMany({ where: { id: CAMPUS } });
    await db.$disconnect();
  });

  it('updateCart: 售罄行减少放行、清零删除；增加仍拒（方向性校验）', async () => {
    // 减少 3→2：旧实现 quantity(2) > stock(0) 整批报错
    const reduced = await biz.updateCart(USER, {
      items: [
        { productId: SOLD_OUT, quantity: 2 },
        { productId: OFF_SALE, quantity: 2 },
      ],
    });
    expect(
      reduced.items.find((i) => i.product.id === SOLD_OUT)?.quantity,
    ).toBe(2);

    // 增加 2→4：超库存仍拒绝（购物车不允许意向超库存）
    await expect(
      biz.updateCart(USER, {
        items: [{ productId: SOLD_OUT, quantity: 4 }],
      }),
    ).rejects.toThrow('库存不足');

    // 清零：行删除
    const cleared = await biz.updateCart(USER, {
      items: [{ productId: SOLD_OUT, quantity: 0 }],
    });
    expect(
      cleared.items.find((i) => i.product.id === SOLD_OUT),
    ).toBeUndefined();
  });

  it('updateCart: 下架行自动剔除，不再整批抛错', async () => {
    // 旧实现对含下架行的全量 PUT 直接抛「商品不存在或已下架」
    const after = await biz.updateCart(USER, {
      items: [{ productId: OFF_SALE, quantity: 2 }],
    });
    expect(after.items.find((i) => i.product.id === OFF_SALE)).toBeUndefined();
  });

  it('setCartItem: 售罄行减少放行、增加拒绝（同 updateCart 口径）', async () => {
    await db.cartItem.create({
      data: { userId: USER, productId: SOLD_OUT, quantity: 3 },
    });
    const reduced = await biz.setCartItem(USER, SOLD_OUT, 1);
    expect(
      reduced.items.find((i) => i.product.id === SOLD_OUT)?.quantity,
    ).toBe(1);
    await expect(biz.setCartItem(USER, SOLD_OUT, 5)).rejects.toThrow(
      '库存不足',
    );
    // 清零删除
    const cleared = await biz.setCartItem(USER, SOLD_OUT, 0);
    expect(cleared.items.length).toBe(0);
  });

  it('updateCart([]): 空 items 一次清空购物车（清空按钮通道）', async () => {
    await db.cartItem.createMany({
      data: [
        { userId: USER, productId: SOLD_OUT, quantity: 1 },
        { userId: USER, productId: OFF_SALE, quantity: 1 },
      ],
    });
    const after = await biz.updateCart(USER, { items: [] });
    expect(after.items.length).toBe(0);
    expect(await db.cartItem.count({ where: { userId: USER } })).toBe(0);
  });
});
