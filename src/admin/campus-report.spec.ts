import { PrismaService } from '../database/prisma.service';
import { AdminService } from './admin.service';
import { BusinessService } from '../business/business.service';

/**
 * 校区经营日报（IKFOPS，2026-09-16 道哥拍板口径）：
 * - paidAt 支付时间落日 + 只计 completed（paid/refunded 单天然剔除）
 * - 销售额=payableAmount 实付；成本=IKFOPQ 行级 unitWholesaleCost 快照×数量
 *   （行缺快照按 0 计，快照上线前历史单毛利虚高）
 * - hq 跨校区筛选；校区角色锁本校区；楼栋筛选用 address.buildingId
 * 独立 fixture，afterAll 全清理（items 是 Json 快照，无需建 Product）。
 */
describe('campus daily report (IKFOPS)', () => {
  const db = new PrismaService();
  const admin = new AdminService(db, new BusinessService(db));
  const tag = `crp-${Date.now()}`;
  const CAMPUS_1 = `crp-campus1-${tag}`;
  const CAMPUS_2 = `crp-campus2-${tag}`;
  const B1 = `crp-b1-${tag}`;

  // 北京时区日期（与 controller 缺省口径一致）
  const day = (offset: number) =>
    new Date(Date.now() + 8 * 3600 * 1000 - offset * 86400 * 1000)
      .toISOString()
      .slice(0, 10);
  const YD = day(1);
  const DBY = day(2);

  let userId = '';
  let orderIds: string[] = [];

  const json = (v: unknown) => v as any;

  const mkOrder = async (o: {
    campusId: string;
    paidDay: string;
    hour: number;
    status: string;
    payable: number;
    items: unknown[];
    buildingId?: string;
  }) => {
    const row = await db.order.create({
      data: {
        orderNo: `BCQCR${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        userId,
        campusId: o.campusId,
        status: o.status,
        statusText: o.status,
        address: json({
          buildingId: o.buildingId,
          buildingName: '测试一栋',
          room: '101',
        }),
        deliveryMode: 'instant',
        items: json(o.items),
        productAmount: o.payable,
        totalQuantity: 1,
        deliveryThreshold: 0,
        deliveryFee: 0,
        discount: 0,
        payableAmount: o.payable,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json([]),
        paidAt: new Date(`${o.paidDay}T${String(o.hour).padStart(2, '0')}:00:00+08:00`),
      },
    });
    orderIds.push(row.id);
  };

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS_1,
        name: `日报测试校区一${tag}`,
        shortName: '报一',
        warehouseName: '报一仓',
        status: 'active',
      } as any,
    });
    await db.campus.create({
      data: {
        id: CAMPUS_2,
        name: `日报测试校区二${tag}`,
        shortName: '报二',
        warehouseName: '报二仓',
        status: 'active',
      } as any,
    });
    const user = await db.user.create({
      data: {
        campusId: CAMPUS_1,
        nickname: '日报测试用户',
        phone: `139${Date.now()}`.slice(0, 11),
        role: 'user',
      },
    });
    userId = user.id;

    // O1：昨日 C1，completed——两行（一行带快照 20 分/单位×3，一行历史单无快照按 0）
    await mkOrder({
      campusId: CAMPUS_1,
      paidDay: YD,
      hour: 10,
      status: 'completed',
      payable: 2400,
      buildingId: B1,
      items: [
        { quantity: 3, product: { id: 'p1', name: 'A', price: 800, unitWholesaleCost: 20 } },
        { quantity: 1, product: { id: 'p2', name: 'B', price: 0 } },
      ],
    });
    // O2：昨日 C2，completed——配送费/优惠并入 payable 的实付口径
    await mkOrder({
      campusId: CAMPUS_2,
      paidDay: YD,
      hour: 11,
      status: 'completed',
      payable: 1100,
      items: [
        { quantity: 2, product: { id: 'p3', name: 'C', price: 550, unitWholesaleCost: 20 } },
      ],
    });
    // O3：昨日但未完成（paid）——剔除
    await mkOrder({
      campusId: CAMPUS_1,
      paidDay: YD,
      hour: 12,
      status: 'paid',
      payable: 999,
      items: [],
    });
    // O4：前日 completed——昨日窗不含，前日窗命中
    await mkOrder({
      campusId: CAMPUS_1,
      paidDay: DBY,
      hour: 15,
      status: 'completed',
      payable: 500,
      buildingId: B1,
      items: [
        { quantity: 1, product: { id: 'p4', name: 'D', price: 500, unitWholesaleCost: 20 } },
      ],
    });
    // O5：昨日但已退款（refunded）——剔除
    await mkOrder({
      campusId: CAMPUS_1,
      paidDay: YD,
      hour: 13,
      status: 'refunded',
      payable: 888,
      items: [],
    });
  });

  afterAll(async () => {
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.campus.deleteMany({ where: { id: { in: [CAMPUS_1, CAMPUS_2] } } });
    await db.$disconnect();
  });

  it('hq 全部校区：昨日只计 completed，快照成本+无快照按 0', async () => {
    const r = await admin.campusDailyReport(YD, YD, {
      hqScope: true,
    });
    // 昨日 completed 只有 O1(2400)+O2(1100)；O3 未完成、O5 退款剔除
    expect(r.totals.orders).toBe(2);
    expect(r.totals.salesTotal).toBe(3500);
    // O1 成本=3×20+0（无快照行），O2=2×20
    expect(r.totals.costTotal).toBe(100);
    expect(r.totals.gross).toBe(3400);
    expect(r.totals.marginRate).toBe(9714);
    // 行=日期×校区，两行
    expect(r.rows.length).toBe(2);
    const c1 = r.rows.find((x) => x.campusId === CAMPUS_1)!;
    expect(c1.orders).toBe(1);
    expect(c1.salesTotal).toBe(2400);
    expect(c1.costTotal).toBe(60);
    expect(c1.gross).toBe(2340);
    expect(c1.marginRate).toBe(9750);
    const c2 = r.rows.find((x) => x.campusId === CAMPUS_2)!;
    expect(c2.salesTotal).toBe(1100);
    expect(c2.marginRate).toBe(9636);
  });

  it('hq 按校区筛选：只看该校区', async () => {
    const r = await admin.campusDailyReport(YD, YD, {
      hqScope: true,
      campusId: CAMPUS_1,
    });
    expect(r.totals.orders).toBe(1);
    expect(r.totals.salesTotal).toBe(2400);
    expect(r.rows.length).toBe(1);
  });

  it('楼栋筛选：按 address.buildingId，缺楼栋的订单剔除', async () => {
    const r = await admin.campusDailyReport(YD, YD, {
      hqScope: true,
      buildingId: B1,
    });
    // 昨日 B1 楼只有 O1（O2 无 buildingId）
    expect(r.totals.orders).toBe(1);
    expect(r.totals.salesTotal).toBe(2400);
  });

  it('校区角色：锁本校区，campusId 参数不生效', async () => {
    const r = await admin.campusDailyReport(YD, YD, {
      hqScope: false,
      userCampusId: CAMPUS_1,
      campusId: CAMPUS_2, // 越权参数应被忽略
    });
    expect(r.totals.orders).toBe(1);
    expect(r.totals.salesTotal).toBe(2400);
    expect(r.rows.every((x) => x.campusId === CAMPUS_1)).toBe(true);
  });

  it('日期窗：前日日报只含前日 completed 订单', async () => {
    const r = await admin.campusDailyReport(DBY, DBY, { hqScope: true });
    expect(r.totals.orders).toBe(1);
    expect(r.totals.salesTotal).toBe(500);
    expect(r.totals.costTotal).toBe(20);
    expect(r.totals.gross).toBe(480);
    expect(r.totals.marginRate).toBe(9600);
  });

  it('日期范围不合法时拦截', async () => {
    await expect(
      admin.campusDailyReport(YD, DBY, { hqScope: true }),
    ).rejects.toThrow('日期范围不合法');
  });
});
