import { PrismaService } from '../database/prisma.service';
import { AdminService } from './admin.service';
import { BusinessService } from '../business/business.service';

/**
 * 总部仓=特殊校区（IKFOPY，2026-09-15 道哥拍板）：
 * - campus-hq 由 migration 预置（type=hq，status=active，不可停用）
 * - 用户端 campusOptions/switchUserCampus 屏蔽 type=hq
 * - 库存/流水按 campusId 过滤，平台视角聚焦 campus-hq 复用仓储页
 * 独立 fixture，afterAll 清理（campus-hq 本身不删）。
 */
describe('hq warehouse campus (IKFOPY)', () => {
  const db = new PrismaService();
  const admin = new AdminService(db, new BusinessService(db));
  const business = new BusinessService(db);
  const tag = `hq-${Date.now()}`;
  const HQ_CAMPUS = 'campus-hq';
  const PRODUCT = `hq-product-${tag}`;

  afterAll(async () => {
    await db.product.deleteMany({ where: { id: PRODUCT } });
    await db.$disconnect();
  });

  it('campusOptions 不含总部仓（用户端选不到 type=hq）', async () => {
    const options = await business.campusOptions();
    expect(options.some((c) => c.id === HQ_CAMPUS)).toBe(false);
  });

  it('switchUserCampus 拒绝切换到总部仓', async () => {
    await expect(business.switchUserCampus(`user-${tag}`, HQ_CAMPUS)).rejects.toThrow();
  });

  it('总部仓库存可经 campusId 聚焦（仓储页复用）', async () => {
    const cat = await db.category.create({
      data: { id: `hq-cat-${tag}`, name: `总部仓测试分类${tag}` } as any,
    });
    await db.product.create({
      data: {
        id: PRODUCT,
        campusId: HQ_CAMPUS,
        categoryId: cat.id,
        name: '总部仓测试商品',
        subtitle: '',
        price: 100,
        originalPrice: 100,
        stock: 7,
        tag: '',
        image: '',
        weight: 0,
      } as any,
    });
    const items = await admin.inventory(HQ_CAMPUS);
    expect(items.some((p: { id: string }) => p.id === PRODUCT)).toBe(true);
    await db.category.delete({ where: { id: cat.id } }).catch(() => {});
  });

  it('总部仓不可停用（中转链路依赖）', async () => {
    await expect(
      admin.updateCampus(HQ_CAMPUS, { status: 'inactive' } as any, 'spec'),
    ).rejects.toThrow('总部仓不可停用');
  });
});
