import { PrismaService } from '../database/prisma.service';
import { AdminService } from '../admin/admin.service';
import { BusinessService } from './business.service';

/**
 * 订单行双成本快照（IKFOPQ，2026-09-15 道哥定版）：
 * - 支付事务写入 unitWholesaleCost/unitPurchaseCost/unitsPerCase（每零售单位，分，floor）
 * - 商品批发价后续改动不影响已支付订单快照
 * - C 端出口（order/orderView）剥离快照，进货价绝不进 C 端响应
 * 独立 fixture，afterAll 清理。
 */
describe('order line cost snapshot (IKFOPQ)', () => {
  const db = new PrismaService();
  const service = new BusinessService(db);
  const tag = `cost-${Date.now()}`;
  const CAMPUS = `campus-${tag}`;
  const USER = `user-${tag}`;
  const ADDRESS = `addr-${tag}`;
  const CAT = `cat-${tag}`;
  // 60 元/件（6000 分）24 听/件 → 250 分/听；进货 48 元/件 → 200 分/听
  const CASED = `product-cased-${tag}`;
  const LOOSE = `product-loose-${tag}`; // 无件概念：含量 1，快照=单价本身
  const BLDB = `bld-${tag}`;

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '快照测试校园',
        shortName: '快照',
        warehouseName: '快照仓',
      } as any,
    });
    await db.user.create({
      data: {
        id: USER,
        openid: `openid-${tag}`,
        nickname: '快照测试用户',
        phone: `138${String(Date.now()).slice(-8)}`,
        campusId: CAMPUS,
      } as any,
    });
    await db.category.create({ data: { id: CAT, name: '快照测试分类' } as any });
    await db.product.create({
      data: {
        id: CASED,
        campusId: CAMPUS,
        categoryId: CAT,
        name: '快照测试整箱可乐',
        subtitle: '',
        price: 350,
        originalPrice: 400,
        wholesalePrice: 6000,
        costPrice: 4800,
        unitsPerCase: 24,
        retailUnit: '听',
        stock: 50,
        tag: '',
        image: '',
        weight: 0.5,
      } as any,
    });
    await db.product.create({
      data: {
        id: LOOSE,
        campusId: CAMPUS,
        categoryId: CAT,
        name: '快照测试散装糖',
        subtitle: '',
        price: 200,
        originalPrice: 250,
        wholesalePrice: 150,
        costPrice: 100,
        unitsPerCase: 1,
        stock: 50,
        tag: '',
        image: '',
        weight: 0.1,
      } as any,
    });
    await db.address.create({
      data: {
        id: ADDRESS,
        userId: USER,
        campusId: CAMPUS,
        campusName: '快照测试校园',
        buildingId: BLDB,
        buildingName: '测试楼',
        floor: 1,
        room: '101',
        contactName: 'spec',
        phone: `139${String(Date.now()).slice(-8)}`,
        isDefault: true,
      } as any,
    });
  });

  afterAll(async () => {
    // 支付副作用（IKA0BI 赠券/通知）先于 user 清理，否则外键拦删
    await db.notification.deleteMany({ where: { userId: USER } });
    await db.order.deleteMany({ where: { userId: USER } });
    await db.cartItem.deleteMany({ where: { userId: USER } });
    await db.address.deleteMany({ where: { id: ADDRESS } });
    await db.product.deleteMany({ where: { id: { in: [CASED, LOOSE] } } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.category.deleteMany({ where: { id: CAT } });
    await db.campus.deleteMany({ where: { id: CAMPUS } });
    await db.$disconnect();
  });

  async function placeAndPay(productIds: string[]) {
    await db.cartItem.createMany({
      data: productIds.map((productId) => ({ userId: USER, productId, quantity: 2 })),
    });
    const order = await service.createOrder(USER, CAMPUS, {
      addressId: ADDRESS,
      deliveryMode: 'instant',
      deliverySlot: '',
      remark: '',
    } as any);
    return service.pay(USER, order.id);
  }

  it('支付后行快照：6000÷24=250 分/听批发、4800÷24=200 进货；含量1恒等', async () => {
    await placeAndPay([CASED, LOOSE]);
    const raw = (await db.order.findFirst({
      where: { userId: USER },
    }))!;
    const lines = (raw!.items as any[]).sort((a, b) =>
      a.product.id < b.product.id ? -1 : 1,
    );
    const cased = lines.find((l) => l.product.id === CASED)!;
    expect(cased.product.unitWholesaleCost).toBe(250);
    expect(cased.product.unitPurchaseCost).toBe(200);
    expect(cased.product.unitsPerCase).toBe(24);
    // 行内毛利（校区账）：售价 350 − 批发快照 250 = 100 分
    expect(cased.product.price - cased.product.unitWholesaleCost).toBe(100);
    const loose = lines.find((l) => l.product.id === LOOSE)!;
    expect(loose.product.unitWholesaleCost).toBe(150);
    expect(loose.product.unitPurchaseCost).toBe(100);
    expect(loose.product.unitsPerCase).toBe(1);
  });

  it('C 端出口剥离：order 视图行无快照字段', async () => {
    const view = await service.order(USER, (await db.order.findFirst({ where: { userId: USER } }))!.id);
    for (const line of view.items as any[]) {
      expect('unitWholesaleCost' in line.product).toBe(false);
      expect('unitPurchaseCost' in line.product).toBe(false);
      expect('unitsPerCase' in line.product).toBe(false);
    }
  });

  it('快照生效：支付后改批发价，历史订单毛利不变', async () => {
    await db.product.update({
      where: { id: CASED },
      data: { wholesalePrice: 9600 },
    });
    const raw = (await db.order.findFirst({ where: { userId: USER } }))!;
    const line = (raw!.items as any[]).find((l) => l.product.id === CASED)!;
    expect(line.product.unitWholesaleCost).toBe(250); // 仍为支付时的 250
  });

  it('历史单估算（IKFTK7）：无快照行补 currentUnitWholesaleCost，有快照行不受影响', async () => {
    const admin = new AdminService(db, service);
    await db.product.update({
      where: { id: CASED },
      data: { wholesalePrice: 9600 }, // 现价 9600÷24=400 分/听
    });
    // 抹掉 cased 行快照模拟历史单，loose 行保留快照（同单混合两面）
    const raw = (await db.order.findFirst({ where: { userId: USER } }))!;
    const stripped = (raw!.items as any[]).map((l) => {
      if (l.product.id !== CASED) return l;
      const rest = { ...l.product };
      delete rest.unitWholesaleCost;
      return { ...l, product: rest };
    });
    await db.order.update({
      where: { id: raw!.id },
      data: { items: stripped as any },
    });

    const rows = await admin.orders(undefined, CAMPUS);
    const row = rows.find((r) => r.id === raw!.id)!;
    const lines = (row.items as any[]).sort((a, b) =>
      a.product.id < b.product.id ? -1 : 1,
    );
    const cased = lines.find((l) => l.product.id === CASED)!;
    expect(cased.product.unitWholesaleCost).toBeUndefined();
    expect(cased.product.currentUnitWholesaleCost).toBe(400);
    const loose = lines.find((l) => l.product.id === LOOSE)!;
    expect(loose.product.unitWholesaleCost).toBe(150); // 快照原值不被覆盖
    expect('currentUnitWholesaleCost' in loose.product).toBe(false);
    // C 端出口同样不出现估算字段（内部数据）
    const view = await service.order(USER, raw!.id);
    for (const line of view.items as any[]) {
      expect('currentUnitWholesaleCost' in line.product).toBe(false);
    }
  });

  it('估算兜底不补 0：批发价未维护的历史单不产生估算字段（IKFTK7）', async () => {
    const admin = new AdminService(db, service);
    await db.product.update({ where: { id: LOOSE }, data: { wholesalePrice: 0 } });
    const raw = (await db.order.findFirst({ where: { userId: USER } }))!;
    const stripped = (raw!.items as any[]).map((l) => {
      if (l.product.id !== LOOSE) return l;
      const rest = { ...l.product };
      delete rest.unitWholesaleCost;
      return { ...l, product: rest };
    });
    await db.order.update({
      where: { id: raw!.id },
      data: { items: stripped as any },
    });

    const rows = await admin.orders(undefined, CAMPUS);
    const row = rows.find((r) => r.id === raw!.id)!;
    const line = (row.items as any[]).find((l) => l.product.id === LOOSE)!;
    expect(line.product.currentUnitWholesaleCost).toBeUndefined();
  });
});
