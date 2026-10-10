import { PrismaService } from '../database/prisma.service';
import { AdminController } from './admin.controller';
import {
  AdminService,
  ORDER_ITEM_COST_FIELDS,
  PRODUCT_COST_FIELDS,
  trimOrderCost,
  trimProductCost,
  trimReportCost,
} from './admin.service';
import { RbacService, type RbacContext } from './rbac/rbac.service';
import { legacyRbacCtx } from './rbac/spec-fixtures';
import { BusinessService } from '../business/business.service';
import type { AuthRequest } from '../auth/jwt-auth.guard';

/**
 * IKKRMY：成本 capability 服务端裁剪（2026-10-10）。
 *
 * 裁剪矩阵（acceptance：无成本权限账号无法从商品、订单、报表或导出获得或
 * 反推出成本）：
 * - 超管：全量（capability 通配）；
 * - 持 cost.read（任一毛利口径端点 ANY-of）：全量；
 * - 无 cost.read：商品行成本字段缺席、订单行内成本快照缺席、报表毛利口径
 *   字段缺席——字段 delete 而非置 null（null=「未填成本」，缺席=「不可见」）；
 * - C 端零成本字段：productView/stripCostSnapshot 现状钉死（含骑手端任务
 *   视图 items 仅 name/quantity/image 的投影口径）；
 * - 改价不重算历史毛利：支付后 unitGrossCost/costSource 快照落地，商品
 *   批发价/本地进货价/采购来源再改不回写历史单（IKFOPQ 回归钉死）。
 *
 * CSV 导出（admin 前端）按同一响应列生成——服务端裁剪即导出同口径。
 */
describe('IKKRMY：成本 capability 裁剪矩阵', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new AdminService(db, business);
  const rbac = new RbacService(db);
  const controller = new AdminController(service, rbac);

  const tag = `costcap-${Date.now()}`;
  const CAMPUS = `campus-${tag}`;
  const USER = `user-${tag}`;
  const ADDRESS = `addr-${tag}`;
  const CAT = `cat-${tag}`;
  const BLDB = `bld-${tag}`;
  /** HQ 供货：批发价 500 分/零售单位（已是零售单位口径，快照=500） */
  const HQ_PRODUCT = `product-hq-${tag}`;
  /** 自主采购：本地进货价 120 分/零售单位（快照=120） */
  const LOCAL_PRODUCT = `product-local-${tag}`;

  /** 最小上下文夹具：只持给定 URL 模式（校区级、无平台授权） */
  function ctxWith(patterns: string[], campusId = CAMPUS): RbacContext {
    return {
      accountId: `spec-${tag}`,
      username: 'costcap',
      nickname: 'costcap',
      campusId,
      platform: false,
      super: false,
      campuses: [campusId],
      patterns: new Set(patterns),
      platformPatterns: new Set<string>(),
      menuCodes: new Set<string>(),
    };
  }
  function reqOf(ctx: RbacContext): AuthRequest {
    return {
      user: { id: ctx.accountId, campusId: ctx.campusId, role: 'operations' as never },
      rbac: ctx,
    } as unknown as AuthRequest;
  }

  /** 超管请求（通配全量）；无成本权限=只持商品/订单读（无任何毛利口径端点） */
  const superReq = reqOf(legacyRbacCtx('admin'));
  const costReadReq = reqOf(
    ctxWith([
      'GET /admin/products',
      'GET /admin/orders',
      'GET /admin/dashboard',
    ]),
  );
  const noCostReq = reqOf(
    ctxWith([
      'GET /admin/products',
      'GET /admin/orders',
      'GET /admin/orders/status-counts',
    ]),
  );
  const today = () =>
    new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

  let orderId = '';

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '成本权限测试校园',
        shortName: '成本权限',
        warehouseName: '成本权限仓',
      } as any,
    });
    await db.user.create({
      data: {
        id: USER,
        openid: `openid-${tag}`,
        nickname: '成本权限测试用户',
        phone: `137${String(Date.now()).slice(-8)}`,
        campusId: CAMPUS,
      } as any,
    });
    await db.category.create({
      data: { campusId: CAMPUS, id: CAT, name: '成本权限测试分类' } as any,
    });
    await db.product.create({
      data: {
        id: HQ_PRODUCT,
        campusId: CAMPUS,
        categoryId: CAT,
        name: '成本权限总部供货商品',
        subtitle: '',
        price: 600,
        originalPrice: 650,
        wholesalePrice: 500,
        costPrice: 300,
        procurementMode: 'HQ',
        unitsPerCase: 24,
        retailUnit: '听',
        stock: 50,
        tag: '',
        image: '',
        weight: 0.5,
      } as any,
    });
    await db.product.create({
      data: {
        id: LOCAL_PRODUCT,
        campusId: CAMPUS,
        categoryId: CAT,
        name: '成本权限自主采购商品',
        subtitle: '',
        price: 200,
        originalPrice: 250,
        wholesalePrice: 0,
        costPrice: 0,
        localPurchasePrice: 120,
        procurementMode: 'LOCAL',
        unitsPerCase: 1,
        stock: 50,
        tag: '',
        image: '',
        weight: 0.1,
      } as any,
    });
    await db.address.create({
      data: {
        id: ADDRESS,
        userId: USER,
        campusId: CAMPUS,
        campusName: '成本权限测试校园',
        buildingId: BLDB,
        buildingName: '测试楼',
        floor: 1,
        room: '101',
        contactName: 'spec',
        phone: `136${String(Date.now()).slice(-8)}`,
        isDefault: true,
      } as any,
    });

    // 下单+支付：行内写入 unitGrossCost/costSource 快照
    await db.cartItem.createMany({
      data: [
        { userId: USER, productId: HQ_PRODUCT, quantity: 1 },
        { userId: USER, productId: LOCAL_PRODUCT, quantity: 2 },
      ],
    });
    const order = await business.createOrder(USER, CAMPUS, {
      addressId: ADDRESS,
      deliveryMode: 'instant',
      deliverySlot: '',
      remark: '',
    } as any);
    await business.pay(USER, order.id);
    orderId = order.id;
    // 日报口径只计 completed（走全状态机过重，spec 直改终态）
    await db.order.update({
      where: { id: orderId },
      data: { status: 'completed' },
    });
  });

  afterAll(async () => {
    await db.notification.deleteMany({ where: { userId: USER } });
    await db.order.deleteMany({ where: { userId: USER } });
    await db.cartItem.deleteMany({ where: { userId: USER } });
    await db.address.deleteMany({ where: { id: ADDRESS } });
    await db.product.deleteMany({
      where: { id: { in: [HQ_PRODUCT, LOCAL_PRODUCT] } },
    });
    await db.user.deleteMany({ where: { id: USER } });
    await db.category.deleteMany({ where: { id: CAT } });
    await db.campus.deleteMany({ where: { id: CAMPUS } });
    await db.$disconnect();
  });

  /* ---------- 判权语义（矩阵的开关侧） ---------- */
  it('cost.read 判权：超管通配 / 毛利口径端点 ANY-of / 纯商品订单读=无', () => {
    expect(rbac.allowCapability(legacyRbacCtx('admin'), 'cost.read')).toBe(true);
    // 持任一毛利口径端点即视为可读（IKKRMR 字典 ANY-of 语义）
    expect(
      rbac.allowCapability(
        ctxWith(['GET /admin/dashboard'], 'campus-x'),
        'cost.read',
      ),
    ).toBe(true);
    expect(
      rbac.allowCapability(
        ctxWith(['GET /admin/reports/campus-daily'], 'campus-x'),
        'cost.read',
      ),
    ).toBe(true);
    // 只持商品/订单读（无毛利口径端点）→ 无成本读取
    expect(
      rbac.allowCapability(
        ctxWith(['GET /admin/products', 'GET /admin/orders'], 'campus-x'),
        'cost.read',
      ),
    ).toBe(false);
  });

  /* ---------- 商品行 ---------- */
  it('商品列表：超管/持 cost.read 全量；无 cost.read 成本字段缺席', async () => {
    // 超管为平台视角：显式 view=campus+campus 定位到本校区行
    const full = (
      (await controller.products(
        superReq,
        '1',
        '100',
        undefined,
        'all',
        'campus',
        undefined,
        CAMPUS,
      )) as any
    ).data.items as Record<string, any>[];
    const hqRow = full.find((x) => x.id === HQ_PRODUCT)!;
    expect(hqRow.costPrice).toBe(300);
    expect(hqRow.wholesalePrice).toBe(500);
    expect(hqRow.procurementMode).toBe('HQ');
    const localRow = full.find((x) => x.id === LOCAL_PRODUCT)!;
    expect(localRow.localPurchasePrice).toBe(120);

    const costReadRow = (
      ((await controller.products(costReadReq, '1', '100')) as any).data
        .items as Record<string, any>[]
    ).find((x) => x.id === HQ_PRODUCT)!;
    expect(costReadRow.costPrice).toBe(300);

    const trimmed = (
      (await controller.products(noCostReq, '1', '100')) as any
    ).data.items as Record<string, any>[];
    const noCostRows = trimmed.filter((x) =>
      [HQ_PRODUCT, LOCAL_PRODUCT].includes(x.id),
    );
    expect(noCostRows).toHaveLength(2);
    for (const row of noCostRows) {
      for (const key of PRODUCT_COST_FIELDS)
        expect(key in row).toBe(false); // 缺席=不可见（非 null=未填）
      expect(row.price).toBeGreaterThan(0); // 售价不受影响（不过度裁剪）
      expect(row.name).toBeTruthy();
    }
  });

  /* ---------- 订单列表/详情 ---------- */
  it('订单列表+详情：无 cost.read 行内成本快照/估算字段缺席', async () => {
    const superList = (
      (await controller.orders(superReq, 'all')) as any
    ).data.items as any[];
    const superRow = superList.find((x) => x.id === orderId)!;
    const hqLine = superRow.items.find(
      (l: any) => l.product?.id === HQ_PRODUCT,
    );
    expect(hqLine.product.unitGrossCost).toBe(500);
    expect(hqLine.product.costSource).toBe('HQ');
    const localLine = superRow.items.find(
      (l: any) => l.product?.id === LOCAL_PRODUCT,
    );
    expect(localLine.product.unitGrossCost).toBe(120);
    expect(localLine.product.costSource).toBe('LOCAL');

    const costReadRow = (
      ((await controller.orders(costReadReq, 'all')) as any).data
        .items as any[]
    ).find((x) => x.id === orderId)!;
    expect(
      costReadRow.items.find((l: any) => l.product?.id === HQ_PRODUCT).product
        .unitGrossCost,
    ).toBe(500);

    for (const req of [noCostReq]) {
      const list = ((await controller.orders(req, 'all')) as any).data
        .items as any[];
      const row = list.find((x) => x.id === orderId)!;
      for (const line of row.items)
        for (const key of ORDER_ITEM_COST_FIELDS)
          expect(`${key}:${key in line.product}`).toBe(`${key}:false`);
      const detail = ((await controller.order(req, orderId)) as any).data as any;
      for (const line of detail.items as any[])
        for (const key of ORDER_ITEM_COST_FIELDS)
          expect(`${key}:${key in line.product}`).toBe(`${key}:false`);
      // 毛利不可从剩余字段反推：数量/售价/实付保留（对账必需），成本口径全无
      expect(detail.payableAmount).toBeGreaterThan(0);
      expect(detail.items[0].quantity).toBeGreaterThan(0);
    }
  });

  /* ---------- 报表/看板 ---------- */
  it('校区日报：无 cost.read 成本/毛利口径字段缺席（销量/销售额保留）', async () => {
    const day = today();
    const report = (
      (await controller.campusDailyReport(noCostReq, day, day)) as any
    ).data as any;
    for (const key of [
      'costTotal',
      'marginTotal',
      'gross',
      'marginRate',
      'marginRawRate',
    ]) {
      expect(`${key}:${key in report.totals}`).toBe(`${key}:false`);
      for (const row of report.rows)
        expect(`${key}:${key in row}`).toBe(`${key}:false`);
    }
    expect(report.totals.salesTotal).toBeGreaterThan(0);
    expect(report.totals.orders).toBeGreaterThan(0);

    const full = (
      (await controller.campusDailyReport(costReadReq, day, day)) as any
    ).data as any;
    expect(full.totals.costTotal).toBe(500 * 1 + 120 * 2);
    expect(full.totals.marginTotal).toBeGreaterThan(0);
  });

  it('总部看板汇总：costRead=false 时校区行/汇总剔除 margin/profit', async () => {
    const full = (await service.dashboard('', true)) as any;
    const fullRow = full.campusRows.find((c: any) => c.campusId === CAMPUS)!;
    expect('margin' in fullRow).toBe(true);
    expect('profit' in fullRow).toBe(true);
    expect('margin' in full.kpis).toBe(true);

    const trimmed = (await service.dashboard('', false)) as any;
    const row = trimmed.campusRows.find((c: any) => c.campusId === CAMPUS)!;
    expect('margin' in row).toBe(false);
    expect('profit' in row).toBe(false);
    expect('margin' in trimmed.kpis).toBe(false);
    expect('profit' in trimmed.kpis).toBe(false);
    expect('margin' in trimmed.caliber).toBe(false);
    // 营收/订单量等非成本口径保留
    expect('revenue' in row).toBe(true);
    expect('orders' in row).toBe(true);
  });

  /* ---------- C 端零成本字段（现状钉死） ---------- */
  it('C 端订单视图零成本字段：快照/成本/采购来源一律不出现', async () => {
    const view = await business.order(USER, orderId);
    for (const line of view.items as any[]) {
      for (const key of [
        ...ORDER_ITEM_COST_FIELDS,
        ...PRODUCT_COST_FIELDS,
      ].filter((k) => k !== 'currentUnitPurchaseCost'))
        expect(`${key}:${key in line.product}`).toBe(`${key}:false`);
    }
    // 骑手端任务视图同口径：items 投影仅 name/quantity/image（fulfillment.toTask）
  });

  /* ---------- 快照钉死：改价不重算历史毛利 ---------- */
  it('改价不重算历史毛利：支付后改批发价/本地进货价/采购来源，快照不变', async () => {
    await db.product.update({
      where: { id: HQ_PRODUCT },
      data: { wholesalePrice: 9999, procurementMode: 'LOCAL' },
    });
    await db.product.update({
      where: { id: LOCAL_PRODUCT },
      data: { localPurchasePrice: 8888, procurementMode: 'HQ' },
    });
    const list = ((await controller.orders(superReq, 'all')) as any).data
      .items as any[];
    const row = list.find((x) => x.id === orderId)!;
    const hqLine = row.items.find((l: any) => l.product?.id === HQ_PRODUCT);
    // 毛利仍按支付时快照：unitGrossCost=500、来源=HQ（改价/改来源不回写）
    expect(hqLine.product.unitGrossCost).toBe(500);
    expect(hqLine.product.costSource).toBe('HQ');
    const localLine = row.items.find(
      (l: any) => l.product?.id === LOCAL_PRODUCT,
    );
    expect(localLine.product.unitGrossCost).toBe(120);
    expect(localLine.product.costSource).toBe('LOCAL');
  });

  /* ---------- 裁剪原语（纯函数） ---------- */
  it('trimProductCost/trimOrderCost/trimReportCost：浅拷贝不 mutate，黑名单外字段保留', () => {
    const product = {
      id: 'p1',
      name: 'x',
      price: 100,
      costPrice: 50,
      wholesalePrice: 60,
      localPurchasePrice: null,
      procurementMode: 'HQ',
      supplyMode: 'platform',
    };
    const trimmedProduct = trimProductCost(product);
    for (const key of PRODUCT_COST_FIELDS)
      expect(key in trimmedProduct).toBe(false);
    expect(product.costPrice).toBe(50); // 原对象不被改
    expect(trimmedProduct.price).toBe(100);

    const orderRow = {
      id: 'o1',
      payableAmount: 100,
      items: [
        {
          quantity: 2,
          product: {
            name: 'x',
            unitGrossCost: 30,
            costSource: 'HQ',
            currentUnitPurchaseCost: 10,
          },
        },
      ],
    };
    const trimmedOrder = trimOrderCost(orderRow);
    for (const key of ORDER_ITEM_COST_FIELDS)
      expect(key in trimmedOrder.items[0].product).toBe(false);
    expect(trimmedOrder.items[0].quantity).toBe(2);
    expect(orderRow.items[0].product.unitGrossCost).toBe(30); // 不 mutate

    const report = {
      totals: { salesTotal: 100, costTotal: 40, gross: 60, marginRate: 6000 },
      rows: [{ date: '2026-10-10', salesTotal: 100, costTotal: 40 }],
      kpis: { revenue: 100, margin: 60, profit: 55 },
      campusRows: [{ campusId: 'c1', margin: 1, profit: 2 }],
      caliber: { revenue: 'x', margin: '毛利说明', profit: '综合毛利说明' },
    };
    const trimmedReport = trimReportCost(report);
    expect('costTotal' in trimmedReport.totals).toBe(false);
    expect('gross' in trimmedReport.totals).toBe(false);
    expect('marginRate' in trimmedReport.totals).toBe(false);
    expect(trimmedReport.totals.salesTotal).toBe(100);
    expect('costTotal' in trimmedReport.rows[0]).toBe(false);
    expect('margin' in trimmedReport.kpis).toBe(false);
    expect('profit' in trimmedReport.campusRows[0]).toBe(false);
    expect('margin' in trimmedReport.caliber).toBe(false);
  });
});
