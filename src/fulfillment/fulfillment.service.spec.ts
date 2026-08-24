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
  // IKAJT4：顶部校区信息接口化——归属校区名/仓名随档案下发
  it('profile 带归属校区名与仓名（去硬编码）', async () => {
    const profile = await service.profile('staff-rider-001');
    expect(profile.campusName).toBe('湖北工业大学');
    expect(profile.campusWarehouseName).toBe('湖工大校园仓');
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
  // IKAJT4：任务池/抢单池按归属校区过滤——他校订单互不可见
  it('任务列表仅含本校区订单（tasks/availableTasks 跨校区隔离）', async () => {
    const tag = `ikajt4-${Date.now()}`;
    const json = (value: unknown) =>
      JSON.parse(JSON.stringify(value)) as never;
    const campusB = await db.campus.create({
      data: {
        name: '配送隔离测试大学',
        shortName: '配送隔离',
        warehouseName: '配送隔离仓',
      },
    });
    const userB = await db.user.create({
      data: {
        campusId: campusB.id,
        nickname: '配送隔离用户',
        phone: '',
        role: 'user',
        openid: `${tag}-openid`,
      },
    });
    const riderB = await db.staff.create({
      data: {
        campusId: campusB.id,
        name: '配送隔离骑手',
        role: 'fulltime-rider',
        roleText: '全职配送员',
        staffNo: `${tag}-rider`,
        building: '东区 1 栋',
        onTimeRate: 100,
        income: 0,
      },
    });
    const orderB = await db.order.create({
      data: {
        orderNo: `BCQJT4${Date.now()}`,
        userId: userB.id,
        campusId: campusB.id,
        status: 'waiting-first-mile',
        statusText: '待一级配送',
        address: json({ buildingName: '东区 1 栋', room: '101' }),
        deliveryMode: 'instant',
        items: json([]),
        productAmount: 500,
        totalQuantity: 1,
        deliveryThreshold: 0,
        deliveryFee: 0,
        discount: 0,
        payableAmount: 500,
        estimatedArrival: '',
        timeline: json([]),
      } as never,
    });
    try {
      const mineB = await service.tasks(riderB.id);
      expect(mineB.some((t) => t.orderId === orderB.id)).toBe(true);
      const mineA = await service.tasks('staff-rider-001');
      expect(mineA.every((t) => t.orderId !== orderB.id)).toBe(true);
      const poolB = await service.availableTasks(riderB.id);
      expect(poolB.some((t) => t.orderId === orderB.id)).toBe(true);
      const poolA = await service.availableTasks('staff-rider-001');
      expect(poolA.every((t) => t.orderId !== orderB.id)).toBe(true);
    } finally {
      await db.order.deleteMany({ where: { id: orderB.id } });
      await db.staff.deleteMany({ where: { id: riderB.id } });
      await db.user.deleteMany({ where: { id: userB.id } });
      await db.campus.deleteMany({ where: { id: campusB.id } });
    }
  });
});
