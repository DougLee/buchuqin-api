import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { AdminService } from './admin.service';
import { buildOrderTimeline } from '../common/order-state';

/**
 * 抢单池与楼长调配（IK8W5U / IK8W5Y）：
 * available 只含本校园 waiting-first-mile 且无 riderId 的单；grab 互斥；
 * admin 调配邀请创建校验（目标在职楼长、非该楼绑定楼长）与取消流转。
 */
describe('grab pool & dispatch invitations (IK8W5U/IK8W5Y)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const fulfillment = new FulfillmentService(db);
  const admin = new AdminService(db, business);
  const CAMPUS = 'campus-hbut';
  const RIDER_1 = 'staff-rider-001';
  const RIDER_2 = 'staff-rider-002';
  let userId = '';
  let west5BuildingId = '';
  const orderIds: string[] = [];
  const createdInvitationIds: string[] = [];
  let tempManagerId = '';
  let tempBuildingId = '';
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

  const makeOrder = async (
    status: string,
    riderId?: string,
    campusId = CAMPUS,
  ) => {
    const order = await db.order.create({
      data: {
        orderNo: `BCQPOOL${Date.now()}${Math.random()
          .toString(36)
          .slice(2, 6)
          .toUpperCase()}`,
        userId,
        campusId,
        riderId: riderId ?? null,
        status,
        statusText: '测试',
        address: json({
          buildingId: west5BuildingId,
          buildingName: '西区 5 栋',
          floor: 6,
          room: '612',
        }),
        deliveryMode: 'instant',
        items: json([]),
        productAmount: 12,
        totalQuantity: 1,
        deliveryThreshold: 10,
        deliveryFee: 2,
        discount: 0,
        payableAmount: 14,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json(buildOrderTimeline('西区 5 栋 612')),
      },
    });
    orderIds.push(order.id);
    return order;
  };

  beforeAll(async () => {
    const user = await db.user.create({
      data: {
        campusId: CAMPUS,
        nickname: '抢单池测试用户',
        phone: '13900000006',
        role: 'user',
      },
    });
    userId = user.id;
    const west5 = await db.building.findFirstOrThrow({
      where: { campusId: CAMPUS, name: '西区 5 栋' },
    });
    west5BuildingId = west5.id;
  });

  afterAll(async () => {
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.dispatchInvitation.deleteMany({
      where: { id: { in: createdInvitationIds } },
    });
    if (tempManagerId)
      await db.staff.deleteMany({ where: { id: tempManagerId } });
    if (tempBuildingId)
      await db.building.deleteMany({ where: { id: tempBuildingId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it('available pool lists only unclaimed waiting-first-mile orders of the campus', async () => {
    const claimable = await makeOrder('waiting-first-mile');
    const claimed = await makeOrder('waiting-first-mile', RIDER_1); // 已被接走
    await makeOrder('paid'); // 仓库还没拣完，不可抢
    await makeOrder('first-mile', RIDER_1); // 已出发
    const pool = await fulfillment.availableTasks(RIDER_2);
    const ids = pool.map((x) => x.orderId);
    // 池是全校园视图（含 seed 样本单），断言包含/排除而非全等：
    // 无归属待接单在池中，已被接走/未拣完/已出发的单不在池中。
    expect(ids).toContain(claimable.id);
    expect(ids).not.toContain(claimed.id);
    expect(
      pool.every(
        (x) =>
          x.status === 'available' && x.availableActions.includes('accept'),
      ),
    ).toBe(true);
    const claimableView = pool.find((x) => x.orderId === claimable.id)!;
    expect(claimableView.availableActions).toEqual(['accept']);
  });

  it('grab claims exclusively and removes the order from the pool', async () => {
    const target = orderIds[0];
    const task = await fulfillment.updateTask(
      RIDER_2,
      `task-parttime-rider-${target}`,
      'grab',
    );
    expect(task.statusText).toBe('已接单，待取货');
    // 抢走后不再出现在他人抢单池
    const pool = await fulfillment.availableTasks(RIDER_1);
    expect(pool.map((x) => x.orderId)).not.toContain(target);
    // 后到的骑手 grab 被条件更新拦下
    await expect(
      fulfillment.updateTask(RIDER_1, `task-fulltime-rider-${target}`, 'grab'),
    ).rejects.toThrow('任务已被其他配送员接取');
  });

  it('leave-requests listing carries the manager and building info', async () => {
    const list = await admin.leaveRequests(CAMPUS);
    const seed = list.find((x) => x.id === 'leave-001');
    expect(seed).toBeTruthy();
    expect(seed!.staff.name).toBe('陈晨');
    expect(seed!.staff.role).toBe('building-manager');
    expect(seed!.staff.building).toBe('西区 5 栋');
  });

  it('dispatch invitation creation validates target and building', async () => {
    const west5 = west5BuildingId;
    // 目标不是楼长 → 拒绝
    await expect(
      admin.createDispatchInvitation(
        {
          targetStaffId: RIDER_1,
          buildingId: west5,
          startAt: '2026-08-20T08:00:00+08:00',
          endAt: '2026-08-20T22:30:00+08:00',
        },
        'admin-001',
        CAMPUS,
      ),
    ).rejects.toThrow('调配目标必须是楼长');
    // 目标楼长已是该楼绑定楼长 → 拒绝
    await expect(
      admin.createDispatchInvitation(
        {
          targetStaffId: 'staff-bm-001',
          buildingId: west5,
          startAt: '2026-08-20T08:00:00+08:00',
          endAt: '2026-08-20T22:30:00+08:00',
        },
        'admin-001',
        CAMPUS,
      ),
    ).rejects.toThrow('目标楼长已是该楼绑定楼长');
    // 楼栋不存在（跨校园 id） → 拒绝
    await expect(
      admin.createDispatchInvitation(
        {
          targetStaffId: 'staff-bm-001',
          buildingId: 'no-such-building',
          startAt: '2026-08-20T08:00:00+08:00',
          endAt: '2026-08-20T22:30:00+08:00',
        },
        'admin-001',
        CAMPUS,
      ),
    ).rejects.toThrow('楼栋不存在');
    // 时间倒挂 → 拒绝
    const temp = await db.building.create({
      data: { campusId: CAMPUS, name: `调配测试楼${Date.now()}`, floors: 6 },
    });
    tempBuildingId = temp.id;
    const manager = await db.staff.create({
      data: {
        campusId: CAMPUS,
        name: '调配测试楼长',
        role: 'building-manager',
        roleText: '调配测试楼楼长',
        staffNo: `BM-DISP-${Date.now()}`,
        buildingId: temp.id,
        building: temp.name,
        onTimeRate: 100,
        income: 0,
      },
    });
    tempManagerId = manager.id;
    await expect(
      admin.createDispatchInvitation(
        {
          targetStaffId: manager.id,
          buildingId: west5,
          startAt: '2026-08-20T22:30:00+08:00',
          endAt: '2026-08-20T08:00:00+08:00',
        },
        'admin-001',
        CAMPUS,
      ),
    ).rejects.toThrow('结束时间必须晚于开始时间');
    // 合法：邀请其他楼长代管西区 5 栋
    const invitation = await admin.createDispatchInvitation(
      {
        targetStaffId: manager.id,
        buildingId: west5,
        startAt: '2026-08-20T08:00:00+08:00',
        endAt: '2026-08-20T22:30:00+08:00',
        reward: 30,
      },
      'admin-001',
      CAMPUS,
    );
    createdInvitationIds.push(invitation.id);
    expect(invitation.status).toBe('invited');
    expect(invitation.building).toBe('西区 5 栋');
    expect(invitation.buildingId).toBe(west5);
    // 取消：invited → cancelled，重复取消被拦
    expect(
      (await admin.cancelDispatchInvitation(invitation.id, 'admin-001', CAMPUS))
        .status,
    ).toBe('cancelled');
    await expect(
      admin.cancelDispatchInvitation(invitation.id, 'admin-001', CAMPUS),
    ).rejects.toThrow('邀请已处理，无法取消');
    // 列表含目标楼长信息
    const list = await admin.dispatchInvitations(CAMPUS);
    expect(list.find((x) => x.id === invitation.id)?.staff.name).toBe(
      '调配测试楼长',
    );
  });
});
