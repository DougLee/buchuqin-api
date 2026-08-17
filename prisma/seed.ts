import { Prisma, PrismaClient } from '@prisma/client';
import { MockStore } from '../src/mock/mock.store';
import { bestMatch, dimsOfOrder } from '../src/commission/commission.service';

const prisma = new PrismaClient();
const source = new MockStore();
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function main() {
  // 守卫：库里已有校园数据时拒绝重灌（防止生产误配 SEED_ON_BOOT 每次重启清库）
  const existing = await prisma.campus.findFirst();
  if (existing) {
    console.log(
      `[seed] 数据库已有数据（campus: ${existing.id}），跳过重灌。如需强制重置请用 prisma migrate reset。`,
    );
    return;
  }
  await prisma.auditLog.deleteMany();
  await prisma.bmBill.deleteMany();
  await prisma.commission.deleteMany();
  await prisma.commissionRule.deleteMany();
  await prisma.room.deleteMany();
  await prisma.building.deleteMany();
  await prisma.dispatchInvitation.deleteMany();
  await prisma.leaveRequest.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.afterSale.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.order.deleteMany();
  await prisma.cartItem.deleteMany();
  await prisma.address.deleteMany();
  await prisma.staff.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.deliverySlot.deleteMany();
  await prisma.coupon.deleteMany();
  await prisma.banner.deleteMany();
  await prisma.user.deleteMany();
  await prisma.campus.deleteMany();

  await prisma.campus.create({
    data: {
      ...source.campus,
      address: '湖北省武汉市洪山区南李路 28 号',
      status: 'active',
    },
  });
  await prisma.user.create({
    data: {
      id: 'user-001',
      campusId: source.campus.id,
      nickname: '湖工大小橙',
      phone: '13800132026',
      role: 'user',
    },
  });
  await prisma.category.createMany({
    data: source.categories.map((item, sort) => ({ ...item, sort })),
  });
  for (const product of source.products)
    await prisma.product.create({
      data: {
        ...product,
        campusId: source.campus.id,
        lockedStock: 0,
        status: 'on-sale',
      },
    });
  await prisma.banner.createMany({
    data: source.banners.map((item, sort) => ({
      ...item,
      campusId: source.campus.id,
      sort,
    })),
  });
  for (const address of source.addresses)
    await prisma.address.create({ data: address });
  // A3 seed 迁移：把现有 Address.buildingName 归并成 Building/Room 记录。
  const buildingIdByName = new Map<string, string>();
  for (const name of [
    ...new Set(source.addresses.map((item) => item.buildingName)),
  ]) {
    const floors = Math.max(
      ...source.addresses
        .filter((item) => item.buildingName === name)
        .map((item) => item.floor),
    );
    const building = await prisma.building.create({
      data: {
        campusId: source.campus.id,
        name,
        floors,
        hasElevator: true,
        gender: 'mixed',
      },
    });
    buildingIdByName.set(name, building.id);
  }
  for (const address of source.addresses) {
    const buildingId = buildingIdByName.get(address.buildingName)!;
    await prisma.address.update({
      where: { id: address.id },
      data: { buildingId },
    });
    await prisma.room.create({
      data: {
        buildingId,
        floor: address.floor,
        roomNo: address.room,
        qrToken: `qr-seed-${address.id}`,
      },
    });
  }
  for (const [userId, items] of Object.entries(source.carts))
    for (const [productId, quantity] of Object.entries(items))
      await prisma.cartItem.create({ data: { userId, productId, quantity } });
  await prisma.coupon.createMany({
    data: source.coupons.map((item, index) => ({
      ...item,
      campusId: source.campus.id,
      status: 'active',
      total: 800 + index * 180,
      expiresAt: new Date(item.expiresAt),
      issued: 500 + index * 180,
      claimed: 286 + index * 92,
      used: 128 + index * 47,
    })),
  });
  await prisma.deliverySlot.createMany({
    data: source.deliverySlots.map((item) => ({
      ...item,
      campusId: source.campus.id,
      capacity: item.available ? 100 : 0,
    })),
  });
  for (const [index, order] of source.orders.entries())
    await prisma.order.create({
      data: {
        ...order,
        orderNo: `BCQ20260812${String(index + 1).padStart(4, '0')}`,
        createdAt: new Date(order.createdAt),
        paidAt: order.paidAt ? new Date(order.paidAt) : null,
        address: json(order.address),
        items: json(order.items),
        timeline: json(order.timeline),
        package: order.package ? json(order.package) : undefined,
      },
    });
  await prisma.notification.createMany({
    data: source.notifications.map((item) => ({
      ...item,
      createdAt: new Date(item.createdAt),
    })),
  });
  for (const item of source.afterSales)
    await prisma.afterSale.create({
      data: {
        ...item,
        images: item.images,
        createdAt: new Date(item.createdAt),
      },
    });
  await prisma.refund.createMany({
    data: source.refunds.map((item) => ({
      ...item,
      createdAt: new Date(item.createdAt),
    })),
  });
  await prisma.staff.createMany({
    data: [
      {
        id: 'staff-bm-001',
        campusId: source.campus.id,
        name: '陈晨',
        role: 'building-manager',
        roleText: '西区 5 栋楼长',
        staffNo: 'BM-HBUT-005',
        building: '西区 5 栋',
        status: 'online',
        completedToday: 18,
        onTimeRate: 96,
        proofRate: 99,
        income: 42.6,
      },
      {
        id: 'staff-rider-001',
        campusId: source.campus.id,
        name: '周航',
        role: 'fulltime-rider',
        roleText: '全职配送员',
        staffNo: 'RD-HBUT-012',
        building: '湖北工业大学',
        status: 'online',
        completedToday: 12,
        onTimeRate: 97,
        income: 36.8,
      },
      {
        id: 'staff-rider-002',
        campusId: source.campus.id,
        name: '林可',
        role: 'parttime-rider',
        roleText: '兼职配送员',
        staffNo: 'PT-HBUT-028',
        building: '湖北工业大学',
        status: 'offline',
        completedToday: 8,
        onTimeRate: 92,
        income: 28.6,
      },
    ],
  });
  // A3 seed 迁移：员工按楼栋名称回填 buildingId。
  for (const [name, buildingId] of buildingIdByName) {
    await prisma.staff.updateMany({
      where: { building: name },
      data: { buildingId },
    });
  }
  // IK8W5L 提成规则 seed：四维组合（楼栋/楼层/重量档/模式）→ 单价，版本号递增。
  const west5Id = buildingIdByName.get('西区 5 栋') ?? null;
  const commissionRules: Array<{
    buildingId: string | null;
    floor: number | null;
    weightFrom: number | null;
    weightTo: number | null;
    mode: string | null;
    price: number;
  }> = [
    // 兜底通配规则（specificity 0）
    { buildingId: null, floor: null, weightFrom: null, weightTo: null, mode: null, price: 3 },
    // 西区 5 栋专属单价
    { buildingId: west5Id, floor: null, weightFrom: null, weightTo: null, mode: null, price: 3.5 },
    // 西区 5 栋高层加价
    { buildingId: west5Id, floor: 6, weightFrom: null, weightTo: null, mode: null, price: 4.2 },
    // 重货档（≥2kg）
    { buildingId: null, floor: null, weightFrom: 2, weightTo: null, mode: null, price: 3.8 },
  ];
  const createdRules = [];
  for (const [index, rule] of commissionRules.entries())
    createdRules.push(
      await prisma.commissionRule.create({
        data: { ...rule, campusId: source.campus.id, version: index + 1 },
      }),
    );
  // 历史 delivered/completed 单回填提成（与 delivered 钩子同一择优口径）。
  const staffList = await prisma.staff.findMany();
  const historical = await prisma.order.findMany({
    where: { status: { in: ['delivered', 'completed'] } },
  });
  for (const order of historical) {
    const dims = dimsOfOrder(order as unknown as Record<string, any>);
    const rule = bestMatch(createdRules, dims);
    const amount = rule ? Number(rule.price) : 3;
    const manager = staffList.find(
      (s) =>
        s.role === 'building-manager' &&
        ((dims.buildingId && s.buildingId === dims.buildingId) ||
          s.building === dims.buildingName),
    );
    for (const staffId of [order.riderId, manager?.id].filter(Boolean) as string[])
      await prisma.commission.create({
        data: {
          staffId,
          orderId: order.id,
          campusId: order.campusId,
          ruleId: rule?.id ?? null,
          ruleVersion: rule?.version ?? null,
          amount,
          status: 'pending',
          fallback: !rule,
          period: order.createdAt.toISOString().slice(0, 7),
          remark: '历史订单提成回填',
        },
      });
  }
  await prisma.leaveRequest.create({
    data: {
      id: 'leave-001',
      staffId: 'staff-bm-001',
      startAt: new Date('2026-08-16T08:00:00+08:00'),
      endAt: new Date('2026-08-16T22:30:00+08:00'),
      reason: '参加学院活动',
      status: 'approved',
      statusText: '已批准',
    },
  });
  await prisma.dispatchInvitation.create({
    data: {
      id: 'dispatch-001',
      staffId: 'staff-bm-001',
      building: '西区 7 栋',
      startAt: new Date('2026-08-14T18:00:00+08:00'),
      endAt: new Date('2026-08-14T22:30:00+08:00'),
      reward: 28,
      status: 'invited',
      statusText: '待接受调配',
    },
  });
  await prisma.auditLog.create({
    data: {
      campusId: source.campus.id,
      operator: 'admin-001',
      action: 'database.seed',
      entityType: 'system',
      entityId: 'initial-test-data',
    },
  });
  console.log(
    `Seeded ${source.products.length} products and ${source.orders.length} orders into PostgreSQL.`,
  );
}
main().finally(() => prisma.$disconnect());
