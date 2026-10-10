import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AdminService } from './admin.service';
import { ORDER_STATUS_TEXT, buildOrderTimeline } from '../common/order-state';
import { campusStaffDelivery } from '../common/organization';

/**
 * IKKRMV 后台员工配送（组织 B）vs 骑手小程序配送（组织 A）双模式 spec：
 *
 * - staff_delivery 组织：订单出库后不进骑手链路——任务列表/抢单池恒空、
 *   出库不派单通知（notifyRidersOnFirstMile 静默跳过）、骑手池外直调动作
 *   拒绝；配送与送达由后台动作 outbound → staff-deliver → staff-complete
 *   沿同一 12 态状态机推进至 delivered（两种模式共用订单状态语义，不新增
 *   状态；组织 B 无楼长交接，waiting-handover/last-mile 微状态不经过），
 *   每次动作审计留痕，不产生骑手提成；
 * - rider_delivery 组织（显式登记组织+默认值，即组织 A 同口径）：任务池/
 *   抢单池/派单通知链路一字不变，员工配送动作对骑手模式校区拒绝。
 */
describe('staff delivery mode (IKKRMV)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const admin = new AdminService(db, business);
  const fulfillment = new FulfillmentService(db);
  const push = new NotificationsService(db);
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

  const ts = `${Date.now()}`;
  const ORG_STAFF = `org-sdstaff-${ts}`;
  const ORG_RIDER = `org-sdrider-${ts}`;
  const CAMPUS_STAFF = `campus-sdstaff-${ts}`;
  const CAMPUS_RIDER = `campus-sdrider-${ts}`;
  const OPERATOR = `spec-sd-${ts}`;
  const ADDRESS = {
    buildingName: '东区 1 栋',
    buildingId: 'bld-sd-1',
    floor: 1,
    room: '101',
    contactName: '员工配送测试',
    phone: '13800001234',
  };

  let userStaff = '';
  let userRider = '';
  let riderStaff = '';
  let riderRider = '';
  /** 后台全链测试主单（paid 起步：outbound→staff-deliver→staff-complete） */
  let orderFlow = '';
  /** staff_delivery 校区已出库单：钉「不入骑手池」 */
  let orderPoolStaff = '';
  /** rider_delivery 校区已出库单：钉「照常入池」（回归锚点） */
  let orderPoolRider = '';
  /** staff_delivery 校区未出库单：钉状态机边界（尚未出库拒绝） */
  let orderPaidStaff = '';

  const seedOrder = (orderNo: string, status: string, campusId: string) =>
    db.order.create({
      data: {
        orderNo,
        userId: campusId === CAMPUS_STAFF ? userStaff : userRider,
        campusId,
        status,
        statusText: status,
        address: json(ADDRESS),
        deliveryMode: 'instant',
        items: json([]),
        productAmount: 500,
        totalQuantity: 1,
        deliveryThreshold: 0,
        deliveryFee: 0,
        discount: 0,
        payableAmount: 500,
        estimatedArrival: '',
        paidAt: new Date(),
        timeline: json(buildOrderTimeline('东区 1 栋 101 室')),
      } as never,
    });

  beforeAll(async () => {
    await db.organization.create({
      data: {
        id: ORG_STAFF,
        name: `员工配送测试组织${ts}`,
        shortName: '员工配',
        deliveryMode: 'staff_delivery',
      },
    });
    // 显式登记组织但保持默认 deliveryMode——组织 A 存量同口径（默认值回归）
    await db.organization.create({
      data: {
        id: ORG_RIDER,
        name: `骑手配送测试组织${ts}`,
        shortName: '骑手配',
      },
    });
    for (const [id, orgId, name] of [
      [CAMPUS_STAFF, ORG_STAFF, '员工配送测试大学'],
      [CAMPUS_RIDER, ORG_RIDER, '骑手配送测试大学'],
    ] as const) {
      await db.campus.create({
        data: {
          id,
          name,
          shortName: name.slice(0, 4),
          warehouseName: `${name}仓`,
          organizationId: orgId,
        },
      });
    }
    userStaff = (
      await db.user.create({
        data: {
          campusId: CAMPUS_STAFF,
          nickname: '员工配送用户',
          phone: '13811112222',
          role: 'user',
          openid: `sd-staff-user-${ts}`,
        },
      })
    ).id;
    userRider = (
      await db.user.create({
        data: {
          campusId: CAMPUS_RIDER,
          nickname: '骑手配送用户',
          phone: '13833334444',
          role: 'user',
          openid: `sd-rider-user-${ts}`,
        },
      })
    ).id;
    for (const [campusId, name, no] of [
      [CAMPUS_STAFF, '员工配送校区骑手', `sd-staff-rider-${ts}`],
      [CAMPUS_RIDER, '骑手配送校区骑手', `sd-rider-rider-${ts}`],
    ] as const) {
      const row = await db.staff.create({
        data: {
          campusId,
          name,
          role: 'fulltime-rider',
          roleText: '全职配送员',
          staffNo: no,
          building: '东区 1 栋',
          onTimeRate: 100,
          income: 0,
          openid: `${no}-openid`,
        },
      });
      if (campusId === CAMPUS_STAFF) riderStaff = row.id;
      else riderRider = row.id;
    }
    orderFlow = (await seedOrder(`BCQSDFLOW${ts}`, 'paid', CAMPUS_STAFF)).id;
    orderPoolStaff = (
      await seedOrder(`BCQSDPOOLA${ts}`, 'waiting-first-mile', CAMPUS_STAFF)
    ).id;
    orderPoolRider = (
      await seedOrder(`BCQSDPOOLB${ts}`, 'waiting-first-mile', CAMPUS_RIDER)
    ).id;
    orderPaidStaff = (await seedOrder(`BCQSDPAID${ts}`, 'paid', CAMPUS_STAFF))
      .id;
  });

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { operator: OPERATOR } });
    await db.notification.deleteMany({
      where: { userId: { in: [userStaff, userRider] } },
    });
    await db.commission.deleteMany({
      where: { orderId: { in: [orderFlow, orderPoolStaff, orderPoolRider] } },
    });
    await db.order.deleteMany({
      where: {
        id: { in: [orderFlow, orderPoolStaff, orderPoolRider, orderPaidStaff] },
      },
    });
    await db.staff.deleteMany({
      where: { id: { in: [riderStaff, riderRider] } },
    });
    await db.user.deleteMany({ where: { id: { in: [userStaff, userRider] } } });
    await db.campus.deleteMany({
      where: { id: { in: [CAMPUS_STAFF, CAMPUS_RIDER] } },
    });
    await db.organization.deleteMany({
      where: { id: { in: [ORG_STAFF, ORG_RIDER] } },
    });
    await db.$disconnect();
  });

  /* ==================== 模式判定 ==================== */

  it('campusStaffDelivery：仅 staff_delivery 组织校区为 true（默认值/无归属=骑手模式）', async () => {
    expect(await campusStaffDelivery(db, CAMPUS_STAFF)).toBe(true);
    expect(await campusStaffDelivery(db, CAMPUS_RIDER)).toBe(false); // 组织默认值
    expect(await campusStaffDelivery(db, 'campus-hbut')).toBe(false); // org-a 存量默认
    expect(await campusStaffDelivery(db, null)).toBe(false);
    expect(await campusStaffDelivery(db, `campus-none-${ts}`)).toBe(false);
  });

  /* ==================== staff_delivery：不入骑手池/不通知/池外拒 ==================== */

  it('staff_delivery 校区订单不入骑手任务池（tasks/available 恒空）', async () => {
    // 同校区有已出库待接单订单（orderPoolStaff）且存在带 openid 的骑手，池仍恒空
    expect(await fulfillment.tasks(riderStaff)).toEqual([]);
    expect(await fulfillment.availableTasks(riderStaff)).toEqual([]);
  });

  it('staff_delivery 校区骑手池外直调动作被拒（防绕过任务池）', async () => {
    await expect(
      fulfillment.updateTask(
        riderStaff,
        `task-fulltime-rider-${orderPoolStaff}`,
        'accept',
      ),
    ).rejects.toThrow('后台员工配送模式');
  });

  it('出库派单通知：staff_delivery 校区静默跳过，rider_delivery 校区照发', async () => {
    const sends = jest
      .spyOn(
        push as unknown as {
          sendStaffSubscribe: (
            staffId: string,
            openid: string,
            data: Record<string, { value: string }>,
          ) => Promise<'ok' | 'no-quota' | 'fail'>;
        },
        'sendStaffSubscribe',
      )
      .mockResolvedValue('ok');
    try {
      await push.notifyRidersOnFirstMile({
        id: orderPoolStaff,
        orderNo: `BCQSDPOOLA${ts}`,
        campusId: CAMPUS_STAFF,
        payableAmount: 500,
        deliveryMode: 'instant',
        address: json(ADDRESS),
      });
      expect(sends).not.toHaveBeenCalled();
      await push.notifyRidersOnFirstMile({
        id: orderPoolRider,
        orderNo: `BCQSDPOOLB${ts}`,
        campusId: CAMPUS_RIDER,
        payableAmount: 500,
        deliveryMode: 'instant',
        address: json(ADDRESS),
      });
      expect(sends).toHaveBeenCalledTimes(1);
      expect(sends.mock.calls[0][0]).toBe(riderRider);
    } finally {
      sends.mockRestore();
    }
  });

  /* ==================== staff_delivery：后台动作全链 + 审计 ==================== */

  it('后台动作全链：outbound→staff-deliver→staff-complete 至 delivered，共用状态语义+审计留痕+零提成', async () => {
    // 出库（两模式共享步骤）：paid → waiting-first-mile
    const afterOutbound = (await admin.orderAction(
      orderFlow,
      'outbound',
      OPERATOR,
      CAMPUS_STAFF,
    )) as { status: string };
    expect(afterOutbound.status).toBe('waiting-first-mile');

    // 员工取货出发：waiting-first-mile → first-mile（同骑手 depart 语义）
    const afterDeliver = (await admin.orderAction(
      orderFlow,
      'staff-deliver',
      OPERATOR,
      CAMPUS_STAFF,
    )) as { status: string; statusText: string };
    expect(afterDeliver.status).toBe('first-mile');
    expect(afterDeliver.statusText).toBe(ORDER_STATUS_TEXT['first-mile']);

    // 员工送达：first-mile → delivered（无楼长交接微状态；状态语义与骑手模式共用）
    const afterComplete = (await admin.orderAction(
      orderFlow,
      'staff-complete',
      OPERATOR,
      CAMPUS_STAFF,
    )) as { status: string; statusText: string; timeline: unknown };
    expect(afterComplete.status).toBe('delivered');
    expect(afterComplete.statusText).toBe(ORDER_STATUS_TEXT['delivered']);
    // timeline 沿用标准节点：出库(picking)/送往楼下(first-mile)/送到寝室(last-mile) 点亮
    const steps = afterComplete.timeline as Array<{
      key: string;
      done: boolean;
    }>;
    expect(steps.filter((s) => s.done).map((s) => s.key)).toEqual([
      'picking',
      'first-mile',
      'last-mile',
    ]);

    // 已送达单再推进 → 状态机拒绝（delivered 只能经确认收货进 completed）
    await expect(
      admin.orderAction(orderFlow, 'staff-complete', OPERATOR, CAMPUS_STAFF),
    ).rejects.toThrow('不能执行此操作');

    // 三次动作全部审计留痕（before/after 快照，现有 audit 机制）
    const logs = await db.auditLog.findMany({
      where: { entityId: orderFlow, operator: OPERATOR },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs.map((l) => l.action)).toEqual([
      'order.outbound',
      'order.staff-deliver',
      'order.staff-complete',
    ]);

    // 员工配送不进骑手提成链路（Commission 仅由骑手端 delivered 动作产生）
    expect(await db.commission.count({ where: { orderId: orderFlow } })).toBe(
      0,
    );
  });

  it('状态机边界：未出库单不能员工配送（先出库，与骑手端同口径）', async () => {
    await expect(
      admin.orderAction(
        orderPaidStaff,
        'staff-deliver',
        OPERATOR,
        CAMPUS_STAFF,
      ),
    ).rejects.toThrow('订单尚未出库');
  });

  /* ==================== rider_delivery 回归：链路一字不变 ==================== */

  it('rider_delivery 组织回归：订单照常进任务池与抢单池', async () => {
    const tasks = await fulfillment.tasks(riderRider);
    expect(tasks.some((t) => t.orderId === orderPoolRider)).toBe(true);
    const pool = await fulfillment.availableTasks(riderRider);
    expect(pool.some((t) => t.orderId === orderPoolRider)).toBe(true);
    expect(pool.find((t) => t.orderId === orderPoolRider)?.status).toBe(
      'available',
    );
  });

  it('员工配送动作对骑手配送模式校区拒绝（组织 A 链路不串道）', async () => {
    await expect(
      admin.orderAction(
        orderPoolRider,
        'staff-deliver',
        OPERATOR,
        CAMPUS_RIDER,
      ),
    ).rejects.toThrow('骑手配送模式');
    await expect(
      admin.orderAction(
        orderPoolRider,
        'staff-complete',
        OPERATOR,
        CAMPUS_RIDER,
      ),
    ).rejects.toThrow('骑手配送模式');
  });
});
