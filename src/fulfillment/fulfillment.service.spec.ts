import { PrismaService } from '../database/prisma.service';
import { FulfillmentService } from './fulfillment.service';
describe('FulfillmentService PostgreSQL integration', () => {
  const db = new PrismaService();
  const service = new FulfillmentService(db);
  afterAll(() => db.$disconnect());
  it('loads staff and persisted tasks', async () => {
    const profile = await service.profile('staff-rider-001');
    expect(profile.role).toBe('fulltime-rider');
    expect((await service.tasks(profile.id)).length).toBeGreaterThan(0);
  });
});
