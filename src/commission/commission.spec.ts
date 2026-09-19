import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from '../admin/admin.service';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { COMMISSION_PER_ORDER, CommissionService } from './commission.service';

/**
 * 财务结算集成测试（IK8W5L）：
 * 规则快照生成（四维择优 + 兜底）、退款跨期负向调整、BmBill 月账单状态流转。
 */
describe('commission & settlement (IK8W5L)', () => {
  const db = new PrismaService();
  const commissions = new CommissionService(db);
  const fulfillment = new FulfillmentService(db);
  const admin = new AdminService(db, new BusinessService(db), commissions);
  const CAMPUS = 'campus-comm-test';
  const RIDER = 'staff-comm-rider';
  const MANAGER = 'staff-comm-manager';
  // IKAFP4：楼 Y 配本楼楼长——楼栋口径收紧后，他楼楼长不能再代送 Y 楼订单
  const MANAGER_Y = 'staff-comm-manager-y';
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  let buildingX = '';
  let buildingY = '';
  let userId = '';
  const orderIds: string[] = [];
  const billIds: string[] = [];

  const makeOrder = async (
    buildingId: string,
    buildingName: string,
    floor: number,
  ) => {
    const product = await db.product.findFirstOrThrow({
      where: { campusId: 'campus-hbut' },
    });
    const order = await db.order.create({
      data: {
        orderNo: `BCQCOMM${Date.now()}${Math.random()
          .toString(36)
          .slice(2, 6)
          .toUpperCase()}`,
        userId,
        campusId: CAMPUS,
        riderId: RIDER,
        status: 'last-mile',
        statusText: '楼长送往寝室',
        address: json({
          buildingId,
          buildingName,
          floor,
          room: '601',
        }),
        deliveryMode: 'instant',
        items: json([
          {
            product: { ...product, price: Number(product.price) },
            quantity: 1,
          },
        ]),
        productAmount: Number(product.price),
        totalQuantity: 1,
        deliveryThreshold: 1000,
        deliveryFee: 400,
        discount: 0,
        payableAmount: Number(product.price) + 400,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json([
          {
            key: 'paid',
            title: '支付成功',
            done: true,
            time: new Date().toISOString(),
          },
          {
            key: 'picking',
            title: '仓库拣货',
            done: true,
            time: new Date().toISOString(),
          },
          {
            key: 'first-mile',
            title: '送往楼下',
            done: true,
            time: new Date().toISOString(),
          },
          {
            key: 'waiting-handover',
            title: '楼下待交接',
            done: true,
            time: new Date().toISOString(),
          },
          {
            key: 'last-mile',
            title: '送到寝室',
            done: true,
            time: new Date().toISOString(),
          },
        ]),
        paidAt: new Date(),
        package: json({ id: `PKG-COMM-${Date.now()}`, status: 'picked' }),
      },
    });
    orderIds.push(order.id);
    return order;
  };

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '提成测试大学',
        shortName: '提成测试',
        warehouseName: '提成测试校园仓',
        // IKDOIU：楼长底薪改校区维度配置（分），本 spec 显式配 50000 覆盖底薪入账单口径
        buildingManagerBaseSalary: 50000,
      },
    });
    const x = await db.building.create({
      data: {
        campusId: CAMPUS,
        name: '提成楼 X',
        floors: 6,
        hasElevator: true,
      },
    });
    buildingX = x.id;
    const y = await db.building.create({
      data: {
        campusId: CAMPUS,
        name: '提成楼 Y',
        floors: 6,
        hasElevator: false,
      },
    });
    buildingY = y.id;
    const user = await db.user.create({
      data: {
        campusId: CAMPUS,
        nickname: '提成测试用户',
        phone: '13900000004',
        role: 'user',
      },
    });
    userId = user.id;
    await db.staff.createMany({
      data: [
        {
          id: RIDER,
          campusId: CAMPUS,
          name: '提成骑手',
          role: 'fulltime-rider',
          roleText: '全职配送员',
          staffNo: 'RD-COMM-001',
          building: '提成测试大学',
          onTimeRate: 100,
          income: 0,
        },
        {
          id: MANAGER,
          campusId: CAMPUS,
          name: '提成楼长',
          role: 'building-manager',
          roleText: '提成楼 X 楼长',
          staffNo: 'BM-COMM-001',
          buildingId: buildingX,
          building: '提成楼 X',
          onTimeRate: 100,
          income: 0,
        },
        {
          id: MANAGER_Y,
          campusId: CAMPUS,
          name: '提成楼 Y 楼长',
          role: 'building-manager',
          roleText: '提成楼 Y 楼长',
          staffNo: 'BM-COMM-002',
          buildingId: buildingY,
          building: '提成楼 Y',
          onTimeRate: 100,
          income: 0,
        },
      ],
    });
    // 规则（金额单位:分）：楼栋 350、楼栋+6 层 460（楼 Y 无规则 → 走兜底常量）。
    await db.commissionRule.create({
      data: { campusId: CAMPUS, buildingId: buildingX, price: 350, version: 1 },
    });
    await db.commissionRule.create({
      data: {
        campusId: CAMPUS,
        buildingId: buildingX,
        floor: 6,
        price: 460,
        version: 2,
      },
    });
  });

  afterAll(async () => {
    await db.commission.deleteMany({ where: { campusId: CAMPUS } });
    await db.bmBill.deleteMany({ where: { campusId: CAMPUS } });
    await db.refund.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.staff.deleteMany({ where: { campusId: CAMPUS } });
    await db.commissionRule.deleteMany({ where: { campusId: CAMPUS } });
    await db.user.deleteMany({ where: { campusId: CAMPUS } });
    await db.building.deleteMany({ where: { campusId: CAMPUS } });
    await db.campus.delete({ where: { id: CAMPUS } });
    await db.$disconnect();
  });

  it('delivered generates rule-snapshot commissions for rider and manager', async () => {
    // 楼 X 6 层：命中"楼栋+楼层"规则（460 分）
    const orderA = await makeOrder(buildingX, '提成楼 X', 6);
    await fulfillment.updateTask(
      MANAGER,
      `task-building-manager-${orderA.id}`,
      'delivered',
      { images: ['https://cos.example/1.jpg'], location: '提成楼 X 601' },
    );
    const recordsA = await db.commission.findMany({
      where: { orderId: orderA.id },
    });
    expect(recordsA).toHaveLength(2); // 骑手 + 楼长
    for (const record of recordsA) {
      expect(record.amount).toBe(460);
      expect(record.status).toBe('pending');
      expect(record.fallback).toBe(false);
      expect(record.ruleVersion).toBe(2);
    }
    // 楼 Y（无规则）：兜底 COMMISSION_PER_ORDER（骑手 + 本楼楼长各一条）。
    // IKAFP4：楼栋口径收紧，X 楼长不能再代送 Y 楼订单，由 Y 楼本楼长送达。
    const orderB = await makeOrder(buildingY, '提成楼 Y', 2);
    await fulfillment.updateTask(
      MANAGER_Y,
      `task-building-manager-${orderB.id}`,
      'delivered',
      { images: ['https://cos.example/2.jpg'], location: '提成楼 Y 201' },
    );
    const recordsB = await db.commission.findMany({
      where: { orderId: orderB.id },
    });
    expect(recordsB).toHaveLength(2);
    for (const record of recordsB) {
      expect(record.amount).toBe(COMMISSION_PER_ORDER);
      expect(record.fallback).toBe(true);
      expect(record.ruleId).toBeNull();
    }
    expect(new Set(recordsB.map((x) => x.staffId))).toEqual(
      new Set([RIDER, MANAGER_Y]),
    );
    // 重复 delivered 重试（构造异常场景前的幂等基线）：同单同人唯一，不重复生成
    await db.order.update({
      where: { id: orderA.id },
      data: { status: 'last-mile', statusText: '楼长送往寝室' },
    });
    await fulfillment.updateTask(
      MANAGER,
      `task-building-manager-${orderA.id}`,
      'delivered',
      { images: ['https://cos.example/1.jpg'], location: '提成楼 X 601' },
    );
    expect(await db.commission.count({ where: { orderId: orderA.id } })).toBe(
      2,
    );
  });

  it('settlements materialize BmBill and walk pending-review → confirmed → paid', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const bills = await admin.settlements(CAMPUS, month);
    // 骑手 + 两位楼长三张账单（IKAFP4：Y 楼长本楼送达也生成提成）
    expect(bills).toHaveLength(3);
    const rider = bills.find((x) => x.staffId === RIDER)!;
    const manager = bills.find((x) => x.staffId === MANAGER)!;
    const managerY = bills.find((x) => x.staffId === MANAGER_Y)!;
    billIds.push(rider.id, manager.id);
    // 骑手：460 + 300 = 760 分，无底薪；X 楼长：460 + 50000 分底薪；Y 楼长：300 + 50000
    expect(rider.baseSalary).toBe(0);
    expect(rider.commissionTotal).toBe(760);
    expect(rider.payable).toBe(760);
    expect(manager.baseSalary).toBe(50000);
    expect(manager.commissionTotal).toBe(460);
    expect(manager.payable).toBe(50460);
    expect(managerY.baseSalary).toBe(50000);
    expect(managerY.commissionTotal).toBe(300);
    expect(managerY.payable).toBe(50300);
    expect(bills.every((x) => x.status === 'pending-review')).toBe(true);
    // 未确认不可支付
    await expect(
      admin.paySettlement(rider.id, 'admin-001', CAMPUS),
    ).rejects.toThrow('账单未确认或已支付');
    // 确认：pending-review → confirmed，重复确认被条件更新拦下
    expect(
      (await admin.confirmSettlement(rider.id, 'admin-001', CAMPUS)).status,
    ).toBe('confirmed');
    await expect(
      admin.confirmSettlement(rider.id, 'admin-001', CAMPUS),
    ).rejects.toThrow('账单已确认或已支付');
    // 支付：confirmed → paid，同期 pending 提成 → settled
    expect(
      (await admin.paySettlement(rider.id, 'admin-001', CAMPUS)).status,
    ).toBe('paid');
    expect(
      await db.commission.count({
        where: { staffId: RIDER, period: month, status: 'settled' },
      }),
    ).toBe(2);
    await expect(
      admin.paySettlement(rider.id, 'admin-001', CAMPUS),
    ).rejects.toThrow('账单未确认或已支付');
    // 已支付账单金额锁定：再次物化不重算
    const again = await admin.settlements(CAMPUS, month);
    expect(again.find((x) => x.id === rider.id)?.status).toBe('paid');
  });

  it('refundAdjust books a negative adjustment in current month (mechanism kept for refund milestone)', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const orderA = orderIds[0];
    // ADR-0004：售后审核假退款路径已拆除，refundAdjust 暂无生产调用方，
    // 机制保留给后续真实退款里程碑，此处直接调佣金服验证跨期调整行为。
    // 场景：骑手提成已被 paid 账单覆盖（settled），楼长提成仍 pending
    await db.$transaction(async (tx) => {
      await commissions.refundAdjust(tx, orderA, '售后退款，提成跨期调整');
    });
    // 骑手（settled）→ 追加负向 adjusted 记录挂当前月
    const riderRecords = await db.commission.findMany({
      where: { orderId: orderA, staffId: RIDER },
    });
    expect(
      riderRecords.filter((x) => x.status === 'adjusted' && x.amount === -460),
    ).toHaveLength(1);
    // 楼长（pending）→ 原地翻负为 adjusted
    const managerRecords = await db.commission.findMany({
      where: { orderId: orderA, staffId: MANAGER },
    });
    expect(managerRecords).toHaveLength(1);
    expect(managerRecords[0].status).toBe('adjusted');
    expect(managerRecords[0].amount).toBe(-460);
    // 负向调整计入当月聚合：楼长提成合计 460 - 460 = 0
    const mine = await fulfillment.commissions(MANAGER, month);
    expect(mine.adjustment).toBe(-460);
    expect(mine.deliveryIncome).toBe(0);
  });
});
