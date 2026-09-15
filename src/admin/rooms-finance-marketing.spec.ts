import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';

/**
 * 寝室底座 + 财务两件 + 定向营销集成测试（IKD6FH/FI/FJ）：
 * 寝室 xlsx 批量导入（含重复跳过/坏文件拒绝）、盘点校准口径（实际数量→自动差额）、
 * 采购申请-审核制（重复申请拒、通过即入库、重复审核拒、拒绝不动库存）、
 * 营销地图聚合（已支付订单按寝室归位 + 未下单寝室补零）、
 * 定向发券（楼栋/楼层条件与手机号解析，幂等发过不重发）。
 * 独立 fixture（自建校区/楼栋/用户/商品），afterAll 清理。
 */
describe('Rooms / stocktake / purchase / marketing map (IKD6FH/FI/FJ)', () => {
  const db = new PrismaService();
  const biz = new BusinessService(db);
  const service = new AdminService(db, biz);
  const CAMPUS = 'campus-rim-spec';
  const BUILDING = 'building-rim-spec';
  const USER_A = 'user-rim-a';
  const USER_B = 'user-rim-b';
  const PRODUCT = 'product-rim-spec';
  const OPERATOR = 'admin-rim-spec';
  const ORDER = 'order-rim-spec';

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '底座测试校园',
        shortName: '底座',
        warehouseName: '底座仓',
      } as any,
    });
    await db.category.create({
      data: { id: 'cat-rim-spec', name: '底座测试分类' } as any,
    });
    await db.product.create({
      data: {
        id: PRODUCT,
        campusId: CAMPUS,
        categoryId: 'cat-rim-spec',
        name: '底座测试薯片',
        subtitle: 'spec',
        price: 800,
        originalPrice: 1000,
        stock: 100,
        tag: 'spec',
        image: '',
        weight: 0.3,
      } as any,
    });
    await db.building.create({
      data: {
        id: BUILDING,
        campusId: CAMPUS,
        name: '底座测试楼',
        floors: 6,
      } as any,
    });
    for (const [id, phone] of [
      [USER_A, '13900000001'],
      [USER_B, '13900000002'],
    ] as const) {
      await db.user.create({
        data: {
          id,
          openid: `openid-${id}`,
          nickname: `用户${id.slice(-1)}`,
          phone,
          campusId: CAMPUS,
        } as any,
      });
    }
    // A 住底座测试楼 2 层 201；B 住别栋（定向条件应只圈中 A）
    await db.address.create({
      data: {
        id: 'addr-rim-a',
        userId: USER_A,
        campusId: CAMPUS,
        campusName: '底座测试校园',
        buildingId: BUILDING,
        buildingName: '底座测试楼',
        floor: 2,
        room: '201',
        contactName: 'A',
        phone: '13900000001',
      } as any,
    });
    await db.address.create({
      data: {
        id: 'addr-rim-b',
        userId: USER_B,
        campusId: CAMPUS,
        campusName: '底座测试校园',
        buildingId: 'building-elsewhere',
        buildingName: '别的楼',
        floor: 1,
        room: '101',
        contactName: 'B',
        phone: '13900000002',
      } as any,
    });
  });

  afterAll(async () => {
    await db.order.deleteMany({ where: { id: ORDER } });
    await db.userCoupon.deleteMany({
      where: { user: { campusId: CAMPUS } },
    });
    await db.coupon.deleteMany({ where: { campusId: CAMPUS } });
    await db.purchaseRequest.deleteMany({ where: { campusId: CAMPUS } });
    await db.inventoryTxn.deleteMany({ where: { productId: PRODUCT } });
    await db.address.deleteMany({ where: { campusId: CAMPUS } });
    await db.user.deleteMany({ where: { campusId: CAMPUS } });
    await db.room.deleteMany({ where: { buildingId: BUILDING } });
    await db.building.deleteMany({ where: { id: BUILDING } });
    await db.product.deleteMany({ where: { id: PRODUCT } });
    await db.category.deleteMany({ where: { id: 'cat-rim-spec' } });
    await db.campus.deleteMany({ where: { id: CAMPUS } });
    await db.$disconnect();
  });

  /** 生成三行寝室数据的模板 xlsx Buffer */
  async function roomsXlsx(rows: Array<[number, string]>) {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('寝室导入');
    sheet.addRow(['楼层', '寝室号']);
    for (const [floor, roomNo] of rows) sheet.addRow([floor, roomNo]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('imports rooms from xlsx, skips duplicates on re-import, rejects bad files', async () => {
    const file = await roomsXlsx([
      [1, '101'],
      [1, '102'],
      [2, '201'],
    ]);
    const first = await service.importRooms(BUILDING, CAMPUS, file, OPERATOR);
    expect(first.total).toBe(3);
    expect(first.imported).toBe(3);
    expect(first.skipped).toBe(0);

    // 重复导入：全部跳过（buildingId+floor+roomNo 唯一）
    const again = await service.importRooms(BUILDING, CAMPUS, file, OPERATOR);
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(3);

    // 非 xlsx 内容直接拒绝
    await expect(
      service.importRooms(BUILDING, CAMPUS, Buffer.from('not-excel'), OPERATOR),
    ).rejects.toThrow('文件解析失败');
  });

  it('stocktake calibrates to counted qty (actual-number semantics)', async () => {
    // 盘点口径：报实际数量 95，系统自动算 delta=-5 落账
    const result = await service.stocktake(
      { productId: PRODUCT, countedQty: 95, reason: '月末盘点' },
      OPERATOR,
      CAMPUS,
    );
    expect(result.delta).toBe(-5);
    expect(result.applied).toBe(true);
    expect(await db.product.findUniqueOrThrow({ where: { id: PRODUCT } }))
      .toMatchObject({ stock: 95 });
    const txn = await db.inventoryTxn.findFirst({
      where: { productId: PRODUCT, reason: { contains: '盘点校准' } },
    });
    expect(txn?.delta).toBe(-5);

    // 账实相符：不落流水
    const noop = await service.stocktake(
      { productId: PRODUCT, countedQty: 95 },
      OPERATOR,
      CAMPUS,
    );
    expect(noop.applied).toBe(false);
    expect(noop.delta).toBe(0);

    // 恢复 100 给后续用例
    await service.stocktake({ productId: PRODUCT, countedQty: 100 }, OPERATOR, CAMPUS);
  });

  // 采购申请链路已退役（IKFOQ1 grilling #1，2026-09-15）：补货统一走
  // 订货批次→采购单→验收，原 apply→audit→stock-in 用例随接口一并删除。

  it('aggregates marketing map with zero-fill for ordered and idle rooms', async () => {
    await db.order.create({
      data: {
        id: ORDER,
        orderNo: 'no-rim-spec-001',
        userId: USER_A,
        campusId: CAMPUS,
        status: 'delivered',
        statusText: '已送达',
        address: {
          buildingId: BUILDING,
          buildingName: '底座测试楼',
          floor: 2,
          room: '201',
        },
        deliveryMode: 'instant',
        items: [],
        productAmount: 1500,
        totalQuantity: 2,
        deliveryThreshold: 0,
        deliveryFee: 0,
        discount: 0,
        payableAmount: 1500,
        estimatedArrival: '30 分钟',
        timeline: [],
        paidAt: new Date(),
      } as any,
    });
    const map = await service.marketingMap(BUILDING, CAMPUS, 30);
    expect(map.building.name).toBe('底座测试楼');
    expect(map.totals.orders).toBe(1);
    expect(map.totals.amount).toBe(1500);
    const floor2 = map.floors.find((f) => f.floor === 2);
    expect(floor2?.rooms.find((r) => r.room === '201')).toMatchObject({
      orders: 1,
      amount: 1500,
      users: 1,
    });
    // 未下单寝室补零（1 层来自导入用例）
    const floor1 = map.floors.find((f) => f.floor === 1);
    expect(floor1?.rooms).toHaveLength(2);
    expect(floor1?.rooms.every((r) => r.orders === 0)).toBe(true);
  });

  it('targets coupons by building/floor and by phone, idempotent per user', async () => {
    const coupon = await db.coupon.create({
      data: {
        campusId: CAMPUS,
        name: '定向测试券',
        amount: 500,
        threshold: 0,
        total: 10,
        status: 'active',
      } as any,
    });
    // 楼栋+楼层圈人：只命中 A（B 的地址在别栋）
    const byBuilding = await service.issueCoupon(
      coupon.id,
      { buildingId: BUILDING, floor: 2 },
      OPERATOR,
      CAMPUS,
    );
    expect(byBuilding.issued).toBe(1);
    expect(byBuilding.targets).toEqual([USER_A]);

    // 手机号圈人：命中 B
    const byPhone = await service.issueCoupon(
      coupon.id,
      { phones: ['13900000002'] },
      OPERATOR,
      CAMPUS,
    );
    expect(byPhone.issued).toBe(1);
    expect(byPhone.targets).toEqual([USER_B]);

    // 再按楼栋发：A 已持有 → 幂等报错
    await expect(
      service.issueCoupon(
        coupon.id,
        { buildingId: BUILDING },
        OPERATOR,
        CAMPUS,
      ),
    ).rejects.toThrow('均持有');

    // 条件没圈到人：明确报错而不是「请选择发放对象」
    await expect(
      service.issueCoupon(
        coupon.id,
        { buildingId: BUILDING, floor: 6, roomNos: ['601'] },
        OPERATOR,
        CAMPUS,
      ),
    ).rejects.toThrow('未匹配到任何用户');
  });
});
