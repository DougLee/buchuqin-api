import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';

/**
 * 促销活动管理集成测试（ADR-0006 / IKAHFF）：
 * 创建校验（重叠窗口/促销价高于现价）、停用即时回落、已结束不可改。
 */
describe('Admin promotions CRUD (IKAHFF)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new AdminService(db, business);
  const CAMPUS = 'campus-promo-admin';
  const PRODUCT = 'product-promo-admin';
  const OPERATOR = 'admin-promo-spec';
  const HOUR = 3600_000;

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '促销后台校园',
        shortName: '促销后台',
        warehouseName: '促销后台仓',
      } as any,
    });
    await db.category.create({
      data: { id: 'cat-promo-admin', name: '促销后台分类' } as any,
    });
    await db.product.create({
      data: {
        id: PRODUCT,
        campusId: CAMPUS,
        categoryId: 'cat-promo-admin',
        name: '促销后台薯片',
        subtitle: 'spec',
        price: 800,
        originalPrice: 1000,
        stock: 20,
        tag: 'spec',
        image: '',
        weight: 0.3,
      } as any,
    });
  });

  afterAll(async () => {
    await db.promotion.deleteMany({ where: { productId: PRODUCT } });
    await db.product.deleteMany({ where: { id: PRODUCT } });
    await db.category.deleteMany({ where: { id: 'cat-promo-admin' } });
    await db.campus.deleteMany({ where: { id: CAMPUS } });
    await db.$disconnect();
  });

  it('creates a promotion that the C-end sees as the effective price', async () => {
    const promo = await service.createPromotion(
      {
        productId: PRODUCT,
        type: 'seckill',
        price: 500,
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + HOUR).toISOString(),
      },
      OPERATOR,
      CAMPUS,
    );
    expect(promo.status).toBe('active');
    const detail = await business.product(PRODUCT, CAMPUS);
    expect(detail.price).toBe(500);
    expect((detail as any).promotion.id).toBe(promo.id);
  });

  it('rejects overlapping windows and above-base prices', async () => {
    await expect(
      service.createPromotion(
        {
          productId: PRODUCT,
          type: 'clearance',
          price: 300,
          startsAt: new Date(Date.now() + 1800_000).toISOString(),
          endsAt: new Date(Date.now() + 2 * HOUR).toISOString(),
        },
        OPERATOR,
        CAMPUS,
      ),
    ).rejects.toThrow('时间窗重叠');
    await expect(
      service.createPromotion(
        {
          productId: PRODUCT,
          type: 'seckill',
          price: 900, // 高于现价 800
          startsAt: new Date(Date.now() + 2 * HOUR).toISOString(),
          endsAt: new Date(Date.now() + 3 * HOUR).toISOString(),
        },
        OPERATOR,
        CAMPUS,
      ),
    ).rejects.toThrow('低于商品现价');
  });

  it('disables instantly (read-time fallback) and locks ended promotions', async () => {
    const [promo] = await db.promotion.findMany({
      where: { productId: PRODUCT },
    });
    await service.updatePromotion(
      promo.id,
      { status: 'disabled' },
      OPERATOR,
      CAMPUS,
    );
    const detail = await business.product(PRODUCT, CAMPUS);
    expect(detail.price).toBe(800);
    expect((detail as any).promotion).toBeUndefined();

    // 已结束活动不可改
    const past = await db.promotion.create({
      data: {
        productId: PRODUCT,
        type: 'clearance',
        price: 100,
        startsAt: new Date(Date.now() - 3 * HOUR),
        endsAt: new Date(Date.now() - HOUR),
      },
    });
    await expect(
      service.updatePromotion(past.id, { price: 200 }, OPERATOR, CAMPUS),
    ).rejects.toThrow('已结束');
  });
});
