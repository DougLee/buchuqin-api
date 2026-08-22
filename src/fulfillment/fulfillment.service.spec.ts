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
  // IKAFP4：楼长楼栋口径——列表读路径只含本楼
  it('楼长任务列表只含本楼订单，骑手仍全校园', async () => {
    const mine = await service.tasks('staff-bm-001');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((t) => t.building === '西区 5 栋')).toBe(true);
    const rider = await service.tasks('staff-rider-001');
    expect(rider.length).toBeGreaterThan(mine.length);
    // 跨楼单（西区 6 栋：picking/firstmile/completed）骑手可见、楼长不可见
    expect(rider.some((t) => t.building === '西区 6 栋')).toBe(true);
  });
  // IKAFP4：楼长写路径——他楼订单直调动作被 403 拒绝
  it('楼长对他楼订单动作被拒', async () => {
    await expect(
      service.updateTask(
        'staff-bm-001',
        'task-building-manager-order-mock-picking',
        'receive',
      ),
    ).rejects.toThrow('非本楼订单');
  });
  // IKAFP5：楼长派生状态与楼长五 tab 一一对应
  it('楼长派生状态映射（waiting/delivering/incoming/exception/completed）', async () => {
    const byOrder: Record<string, string> = {};
    for (const t of await service.tasks('staff-bm-001'))
      byOrder[t.orderId] = t.status;
    expect(byOrder['order-mock-waitingho']).toBe('waiting'); // 待接货
    expect(byOrder['order-mock-lastmile']).toBe('delivering'); // 待送到寝室
    expect(byOrder['order-mock-paid']).toBe('incoming'); // 待到楼
    expect(byOrder['order-mock-exception']).toBe('exception');
    expect(byOrder['order-mock-delivered']).toBe('completed');
  });
});
