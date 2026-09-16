import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AdminService } from './admin.service';
import { BusinessService } from '../business/business.service';

/**
 * 营销作战地图（IKFOQ3，2026-09-17 道哥拍板口径）：
 * - 🟢 paidAt 非空即算已下单（pending-payment 不算）；🟡 有注册用户无订单；⚪ 未开发
 * - 归属匹配 buildingId+roomNo 二元；一人多地址同寝室去重
 * - 高频=近 30 天已支付 ≥3 单（累计与近期分离断言）
 * - 防串校区：楼栋不属于当前运营校区 → 404
 * 独立 fixture，afterAll 全清理。
 */
describe('battle map (IKFOQ3)', () => {
  const db = new PrismaService();
  const admin = new AdminService(db, new BusinessService(db));
  const tag = `bmap-${Date.now()}`;
  const CAMPUS_1 = `bmap-campus1-${tag}`;
  const CAMPUS_2 = `bmap-campus2-${tag}`;
  const B1 = `bmap-b1-${tag}`;
  const B2 = `bmap-b2-${tag}`;
  const ROOM_101 = `bmap-r101-${tag}`;
  const ROOM_102 = `bmap-r102-${tag}`;
  const ROOM_103 = `bmap-r103-${tag}`;
  const ROOM_201 = `bmap-r201-${tag}`;
  const ROOM_202 = `bmap-r202-${tag}`;

  let userIds: string[] = [];
  let orderIds: string[] = [];
  let addrIds: string[] = [];

  const day = 86400 * 1000;

  const mkUser = async (nickname: string, phone: string) => {
    const u = await db.user.create({
      data: { campusId: CAMPUS_1, nickname, phone, role: 'user' },
    });
    userIds.push(u.id);
    return u;
  };
  const mkAddr = async (
    userId: string,
    room: string,
    floor: number,
  ) => {
    const a = await db.address.create({
      data: {
        userId,
        campusId: CAMPUS_1,
        campusName: '作战测试校区',
        buildingId: B1,
        buildingName: '作战一栋',
        floor,
        room,
        contactName: '收货人',
        phone: '13800000000',
      },
    });
    addrIds.push(a.id);
  };
  const mkOrder = async (o: {
    userId: string;
    room: string;
    paid: boolean;
    paidDaysAgo?: number;
    payable?: number;
  }) => {
    const row = await db.order.create({
      data: {
        orderNo: `BCQBM${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        userId: o.userId,
        campusId: CAMPUS_1,
        status: o.paid ? 'completed' : 'pending-payment',
        statusText: o.paid ? '已完成' : '等待支付',
        address: {
          buildingId: B1,
          buildingName: '作战一栋',
          floor: 1,
          room: o.room,
        } as any,
        deliveryMode: 'instant',
        items: [] as any,
        productAmount: o.payable ?? 1000,
        totalQuantity: 1,
        deliveryThreshold: 0,
        deliveryFee: 0,
        discount: 0,
        payableAmount: o.payable ?? 1000,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: [] as any,
        paidAt: o.paid
          ? new Date(Date.now() - (o.paidDaysAgo ?? 1) * day)
          : null,
      },
    });
    orderIds.push(row.id);
  };

  beforeAll(async () => {
    for (const id of [CAMPUS_1, CAMPUS_2])
      await db.campus.create({
        data: {
          id,
          name: `作战测试校区${id === CAMPUS_1 ? '一' : '二'}${tag}`,
          shortName: '作战',
          warehouseName: '作战仓',
          status: 'active',
        } as any,
      });
    await db.building.create({
      data: { id: B1, campusId: CAMPUS_1, name: `作战一栋${tag}` },
    });
    await db.building.create({
      data: { id: B2, campusId: CAMPUS_2, name: `别栋二栋${tag}` },
    });
    // 1 楼：101🟢 102🟡 103⚪；2 楼：201🟢 202⚪
    for (const [id, floor, roomNo] of [
      [ROOM_101, 1, '101'],
      [ROOM_102, 1, '102'],
      [ROOM_103, 1, '103'],
      [ROOM_201, 2, '201'],
      [ROOM_202, 2, '202'],
    ] as const)
      await db.room.create({
        data: { id, buildingId: B1, floor, roomNo, qrToken: `${tag}-${roomNo}` },
      });

    const u1 = await mkUser('作战用户一', '13811110001');
    const u2 = await mkUser('作战用户二', '13811110002');
    const u3 = await mkUser('作战用户三', '13811110003');
    await mkAddr(u1.id, '101', 1);
    await mkAddr(u2.id, '102', 1);
    // U3 两条地址都指向 201——归属去重后 userCount 仍 = 1
    await mkAddr(u3.id, '201', 2);
    await mkAddr(u3.id, '201', 2);

    // 101：1 笔已支付（近期）→ 🟢
    await mkOrder({ userId: u1.id, room: '101', paid: true, payable: 1000 });
    // 102：只有未支付单 → 🟡（pending-payment 不算已下单）
    await mkOrder({ userId: u2.id, room: '102', paid: false });
    // 201：30 天内 3 笔 + 40 天前 1 笔 → 🟢 且高频
    for (const payable of [500, 600, 700])
      await mkOrder({ userId: u3.id, room: '201', paid: true, payable });
    await mkOrder({
      userId: u3.id,
      room: '201',
      paid: true,
      paidDaysAgo: 40,
      payable: 900,
    });
    // 不存在房号 999 的订单 → 不影响任何格子
    await mkOrder({ userId: u1.id, room: '999', paid: true });
  });

  afterAll(async () => {
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.address.deleteMany({ where: { id: { in: addrIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.room.deleteMany({ where: { buildingId: { in: [B1, B2] } } });
    await db.building.deleteMany({ where: { id: { in: [B1, B2] } } });
    await db.campus.deleteMany({ where: { id: { in: [CAMPUS_1, CAMPUS_2] } } });
    await db.$disconnect();
  });

  it('整栋地图：三色判定+楼层汇总+覆盖率', async () => {
    const r = await admin.battleMapBuilding(CAMPUS_1, B1);
    expect(r.building.id).toBe(B1);
    const f1 = r.floors.find((f) => f.floor === 1)!;
    expect(f1.total).toBe(3);
    expect(f1.ordered).toBe(1);
    expect(f1.registered).toBe(1);
    expect(f1.fresh).toBe(1);
    // 覆盖率=已下单/总格子=1/3 万分比
    expect(f1.coverageRate).toBe(3333);
    const byRoom = Object.fromEntries(f1.rooms.map((x) => [x.roomNo, x]));
    expect(byRoom['101'].status).toBe('ordered');
    expect(byRoom['101'].orderCount).toBe(1);
    expect(byRoom['102'].status).toBe('registered');
    expect(byRoom['102'].orderCount).toBe(0);
    expect(byRoom['103'].status).toBe('fresh');
    const f2 = r.floors.find((f) => f.floor === 2)!;
    expect(f2.ordered).toBe(1);
    expect(f2.coverageRate).toBe(5000);
    const r201 = f2.rooms.find((x) => x.roomNo === '201')!;
    // U3 两条地址同寝室 → 归属去重 userCount=1；4 笔已支付
    expect(r201.userCount).toBe(1);
    expect(r201.orderCount).toBe(4);
    expect(r201.status).toBe('ordered');
  });

  it('防串校区：楼栋不属于当前校区 → 404', async () => {
    await expect(admin.battleMapBuilding(CAMPUS_1, B2)).rejects.toThrow(
      NotFoundException,
    );
    await expect(admin.battleMapBuilding(CAMPUS_2, B1)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('寝室详情：用户统计+高频标签（近 30 天 ≥3）+手机号脱敏', async () => {
    const r = await admin.battleMapRoom(CAMPUS_1, ROOM_201);
    expect(r.orderCount).toBe(4);
    expect(r.users.length).toBe(1);
    const u3 = r.users[0];
    expect(u3.orderCount).toBe(4);
    // 累计=500+600+700+900=2700；近 30 天=3 → 高频
    expect(u3.totalAmount).toBe(2700);
    expect(u3.recentCount).toBe(3);
    expect(u3.highFrequency).toBe(true);
    expect(u3.phone).toBe('138****0003');

    const fresh = await admin.battleMapRoom(CAMPUS_1, ROOM_202);
    expect(fresh.users).toEqual([]);
    expect(fresh.orderCount).toBe(0);

    // 🟡 格子：用户只有未支付单 → orderCount=0、不高频
    const yellow = await admin.battleMapRoom(CAMPUS_1, ROOM_102);
    expect(yellow.users.length).toBe(1);
    expect(yellow.users[0].orderCount).toBe(0);
    expect(yellow.users[0].highFrequency).toBe(false);
  });

  it('格子不存在 → 404', async () => {
    await expect(
      admin.battleMapRoom(CAMPUS_1, `bmap-none-${tag}`),
    ).rejects.toThrow(NotFoundException);
  });
});
