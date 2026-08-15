import { PrismaService } from '../database/prisma.service';
import { BusinessService } from './business.service';
describe('BusinessService PostgreSQL integration', () => {
  const db = new PrismaService();
  const service = new BusinessService(db);
  afterAll(() => db.$disconnect());
  it('reads seeded home and cart data', async () => {
    const home = await service.home('user-001', 'campus-hbut');
    expect(home.hotProducts.length).toBeGreaterThan(10);
    const cart = await service.cart('user-001');
    expect(cart.totalQuantity).toBeGreaterThan(0);
  });
  it('keeps user and campus address isolation', async () => {
    const list = await service.addresses('user-001', 'campus-hbut');
    expect(
      list.every(
        (x) => x.userId === 'user-001' && x.campusId === 'campus-hbut',
      ),
    ).toBe(true);
  });
});
