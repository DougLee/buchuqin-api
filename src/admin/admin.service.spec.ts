import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';
describe('AdminService PostgreSQL integration', () => {
  const db = new PrismaService();
  const service = new AdminService(db, new BusinessService(db));
  afterAll(() => db.$disconnect());
  it('aggregates persisted operational data', async () => {
    expect((await service.dashboard()).campus.name).toBe('湖北工业大学');
    expect((await service.products()).length).toBeGreaterThan(10);
    expect((await service.staff()).length).toBe(3);
  });
});
