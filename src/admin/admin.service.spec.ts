import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

describe('AdminService PostgreSQL integration', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new AdminService(db, business);
  const controller = new AdminController(service);
  const adminUser = {
    user: { id: 'admin-001', campusId: 'campus-hbut', role: 'admin' as const },
  } as unknown as Parameters<typeof controller.products>[0];
  afterAll(() => db.$disconnect());
  it('aggregates persisted operational data', async () => {
    expect((await service.dashboard('campus-hbut')).campus.name).toBe(
      '湖北工业大学',
    );
    expect((await service.products('campus-hbut')).length).toBeGreaterThan(10);
    expect((await service.staff('campus-hbut')).length).toBe(3);
  });

  it('wraps list endpoints in the unified pagination envelope (IK8W5X)', async () => {
    const products = (await controller.products(adminUser, '2', '5')).data;
    expect(products.page).toBe(2);
    expect(products.pageSize).toBe(5);
    expect(products.items).toHaveLength(5);
    expect(products.total).toBe((await service.products('campus-hbut')).length);
    // 默认参数：page=1 pageSize=20
    const orders = (await controller.orders(adminUser)).data;
    expect(orders.page).toBe(1);
    expect(orders.pageSize).toBe(20);
    expect(Array.isArray(orders.items)).toBe(true);
  });

  // 资料可编辑（IKAHAT）：名称/副标题/分类可改，空白名与跨校园分类被拒
  it('updateProduct edits profile fields and rejects invalid ones', async () => {
    const target = await db.product.findFirstOrThrow({
      where: { campusId: 'campus-hbut', name: { not: '' } },
    });
    const category = await db.category.findFirstOrThrow();
    const updated = await service.updateProduct(
      target.id,
      {
        name: `${target.name}（测试改名）`,
        subtitle: 'IKAHAT 副标题测试',
        categoryId: category.id,
        originalPrice: target.originalPrice,
        tag: 'IKAHAT',
      },
      'admin-001',
      'campus-hbut',
    );
    expect(updated.name).toBe(`${target.name}（测试改名）`);
    expect(updated.subtitle).toBe('IKAHAT 副标题测试');
    expect(updated.categoryId).toBe(category.id);
    // 还原，避免污染种子数据
    await service.updateProduct(
      target.id,
      { name: target.name, subtitle: target.subtitle, tag: target.tag },
      'admin-001',
      'campus-hbut',
    );
    // 空白名拒绝
    await expect(
      service.updateProduct(
        target.id,
        { name: '   ' },
        'admin-001',
        'campus-hbut',
      ),
    ).rejects.toThrow('商品名称不能为空');
    // 跨校园/不存在分类拒绝
    await expect(
      service.updateProduct(
        target.id,
        { categoryId: 'category-not-exist' },
        'admin-001',
        'campus-hbut',
      ),
    ).rejects.toThrow('分类不存在');
  });

  // 商品介绍（IKAHAU）：可写可清，详情带、列表不带
  it('product description round-trips, detail-only in user views', async () => {
    const target = await db.product.findFirstOrThrow({
      where: { campusId: 'campus-hbut', status: 'on-sale' },
    });
    const updated = await service.updateProduct(
      target.id,
      { description: '第一行介绍\n第二行保留换行' },
      'admin-001',
      'campus-hbut',
    );
    expect(updated.description).toBe('第一行介绍\n第二行保留换行');
    // 用户端详情带介绍
    const detail = await business.product(target.id, 'campus-hbut');
    expect(detail.description).toBe('第一行介绍\n第二行保留换行');
    // 用户端列表不带（payload 不膨胀）
    const list = await business.listProducts('campus-hbut');
    expect(list.every((p) => p.description === undefined)).toBe(true);
    // 空串清空
    const cleared = await service.updateProduct(
      target.id,
      { description: '' },
      'admin-001',
      'campus-hbut',
    );
    expect(cleared.description).toBe('');
  });
});
