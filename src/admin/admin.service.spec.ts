import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

describe('AdminService PostgreSQL integration', () => {
  const db = new PrismaService();
  const service = new AdminService(db, new BusinessService(db));
  const controller = new AdminController(service);
  const adminUser = {
    user: { id: 'admin-001', campusId: 'campus-hbut', role: 'admin' as const },
  };
  afterAll(() => db.$disconnect());
  it('aggregates persisted operational data', async () => {
    expect((await service.dashboard()).campus.name).toBe('湖北工业大学');
    expect((await service.products()).length).toBeGreaterThan(10);
    expect((await service.staff()).length).toBe(3);
  });

  it('wraps list endpoints in the unified pagination envelope (IK8W5X)', async () => {
    const products = (
      await controller.products(adminUser, '2', '5')
    ).data;
    expect(products.page).toBe(2);
    expect(products.pageSize).toBe(5);
    expect(products.items).toHaveLength(5);
    expect(products.total).toBe((await service.products()).length);
    // 默认参数：page=1 pageSize=20
    const orders = (await controller.orders(adminUser)).data;
    expect(orders.page).toBe(1);
    expect(orders.pageSize).toBe(20);
    expect(Array.isArray(orders.items)).toBe(true);
  });
});
