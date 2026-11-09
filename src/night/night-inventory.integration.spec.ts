import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NightInventoryService } from './night-inventory.service';
import { NightOrderService } from './night-order.service';
import { PaymentsService } from '../payments/payments.service';
import { NightAdminService } from './night-admin.service';
import { AdminService } from '../admin/admin.service';
import { BusinessService } from '../business/business.service';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { WechatRefundOutcomeUnknownError } from '../payments/payments.service';
import { NightReportingService } from './night-reporting.service';
import { NightRiderService } from './night-rider.service';
import { NightUserService } from './night-user.service';
import { NightUserController } from './night-user.controller';
import { beijingMinutes, nightBusinessDate } from './night.helpers';

// This suite opts into a fresh isolated schema. Never run against the shared public schema.
const integration =
  process.env.NIGHT_STOCK_INTEGRATION === '1' ? describe : describe.skip;
integration('已确认的夜宵备货库存流程（独立 PostgreSQL schema）', () => {
  let db: PrismaService;
  let service: NightInventoryService;
  let staffId: string;
  let storeId: string;
  let catalogId: string;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (
      !url.pathname.endsWith('_spec') ||
      !url.searchParams.get('schema')?.startsWith('night_stock_')
    )
      throw new Error('夜宵库存集成测试只允许独立 night_stock_ 测试 schema');
    db = new PrismaService();
    await db.$connect();
    service = new NightInventoryService(db);
    const campus = await db.campus.create({
      data: {
        name: '库存验收校区',
        shortName: '库存验收',
        warehouseName: '验收仓',
      },
    });
    const building = await db.building.create({
      data: { campusId: campus.id, name: '验收楼' },
    });
    const staff = await db.staff.create({
      data: {
        campusId: campus.id,
        name: '验收楼长',
        role: 'building-manager',
        roleText: '楼长',
        staffNo: `NS-${Date.now()}`,
        building: building.name,
        onTimeRate: 100,
        income: 0,
      },
    });
    const category = await db.category.create({
      data: { campusId: campus.id, name: '验收商品' },
    });
    const warehouse = await db.product.create({
      data: {
        campusId: campus.id,
        categoryId: category.id,
        name: '验收饮料',
        subtitle: '',
        price: 600,
        originalPrice: 600,
        stock: 100,
        tag: '',
        image: '',
        weight: 0,
      },
    });
    const catalog = await db.product.create({
      data: {
        campusId: campus.id,
        categoryId: category.id,
        name: warehouse.name,
        subtitle: '',
        price: 500,
        originalPrice: 500,
        stock: 0,
        nightCatalog: true,
        warehouseProductId: warehouse.id,
        tag: '',
        image: '',
        weight: 0,
      },
    });
    const store = await db.nightStore.create({
      data: {
        campusId: campus.id,
        buildingId: building.id,
        managerStaffId: staff.id,
        deposit: 50000,
        commissionRate: 2000,
      },
    });
    staffId = staff.id;
    storeId = store.id;
    catalogId = catalog.id;
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  async function fixture(deposit = 50000, warehouseStock = 100) {
    const nowMinutes = beijingMinutes();
    const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const campus = await db.campus.create({
      data: {
        name: '库存边界验收',
        shortName: '验收',
        warehouseName: '验收仓',
        manualClosed: true,
        nightEnabled: true,
        nightStartAt: clock((nowMinutes + 1080) % 1440),
        nightEndAt: clock((nowMinutes + 360) % 1440),
        nightDeliveryFee: 0,
      },
    });
    const building = await db.building.create({
      data: { campusId: campus.id, name: '验收楼' },
    });
    const staff = await db.staff.create({
      data: {
        campusId: campus.id,
        name: '验收楼长',
        role: 'building-manager',
        roleText: '楼长',
        staffNo: randomUUID(),
        building: building.name,
        onTimeRate: 100,
        income: 0,
      },
    });
    const category = await db.category.create({
      data: { campusId: campus.id, name: '验收类目' },
    });
    const warehouse = await db.product.create({
      data: {
        campusId: campus.id,
        categoryId: category.id,
        name: '边界验收饮料',
        subtitle: '',
        price: 500,
        originalPrice: 500,
        stock: warehouseStock,
        tag: '',
        image: '',
        weight: 0,
      },
    });
    const catalog = await db.product.create({
      data: {
        campusId: campus.id,
        categoryId: category.id,
        name: warehouse.name,
        subtitle: '',
        price: 500,
        originalPrice: 500,
        stock: 0,
        nightCatalog: true,
        warehouseProductId: warehouse.id,
        tag: '',
        image: '',
        weight: 0,
      },
    });
    const store = await db.nightStore.create({
      data: {
        campusId: campus.id,
        buildingId: building.id,
        managerStaffId: staff.id,
        deposit,
        commissionRate: 2000,
      },
    });
    const request = (qty: number, requestId = randomUUID()) =>
      service.createStockOrder(staff.id, {
        requestId,
        items: [{ catalogProductId: catalog.id, quantity: qty }],
      });
    const receive = async (qty: number) => {
      const o = await request(qty);
      await service.reviewStockOrder('test-admin', o.id, true, '同意');
      await service.shipStockOrder('test-admin', o.id);
      await service.receiveStockOrder(staff.id, o.id, [
        { catalogProductId: catalog.id, quantity: qty },
      ]);
      return o;
    };
    return {
      campus,
      building,
      staff,
      catalog,
      warehouse,
      store,
      request,
      receive,
    };
  }

  it('商品库组合筛选支持条码、分类、来源和仓库库存，选项不跨校区', async () => {
    const f = await fixture();
    await db.product.update({
      where: { id: f.catalog.id },
      data: { nightBarcode: 'FILTER-69001' },
    });
    expect(
      await service.catalog(f.campus.id, '69001', {
        categoryId: f.catalog.categoryId,
        status: 'on-sale',
        source: 'manual',
        stock: 'available',
      }),
    ).toHaveLength(1);
    expect(
      await service.catalog(f.campus.id, undefined, { source: 'official' }),
    ).toHaveLength(0);
    expect(
      await service.catalog(f.campus.id, undefined, { stock: 'empty' }),
    ).toHaveLength(0);
    await db.product.update({
      where: { id: f.warehouse.id },
      data: { stock: 0 },
    });
    expect(
      await service.catalog(f.campus.id, undefined, { stock: 'empty' }),
    ).toHaveLength(1);
    expect(
      await service.catalog(f.campus.id, undefined, { stock: 'unlinked' }),
    ).toHaveLength(0);
    expect(await service.catalogCategories(f.campus.id)).toEqual([
      { id: f.catalog.categoryId, name: '验收类目' },
    ]);
    await expect(
      service.catalog(f.campus.id, undefined, { status: 'bad' }),
    ).rejects.toThrow('筛选条件无效');
  });

  it('楼栋商品筛选正确处理 false、冻结、分类，并隔离其他校区', async () => {
    const a = await fixture(),
      b = await fixture();
    await a.receive(5);
    await b.receive(2);
    const p = (await service.products(a.staff.id))[0];
    await service.createReport(a.staff.id, {
      requestId: randomUUID(),
      kind: 'loss',
      reason: '包装破损',
      items: [
        {
          nightProductId: p.id,
          quantity: 1,
          inventoryVersion: p.inventoryVersion,
        },
      ],
    });
    await db.nightProduct.update({
      where: { id: p.id },
      data: { onShelf: false, saleAllowed: false },
    });
    const rows = await service.campusProducts(a.campus.id, {
      stock: 'frozen',
      saleAllowed: 'false',
      onShelf: 'false',
      categoryId: a.catalog.categoryId,
      keyword: a.staff.name,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stock: 4,
      frozenStock: 1,
      inventoryValue: 2000,
      purchasable: false,
    });
    expect((await service.summary(a.store.id)).usedQuota).toBe(2500);
    expect(
      await service.campusProducts(a.campus.id, { storeId: b.store.id }),
    ).toHaveLength(0);
    expect(
      await service.campusProducts(a.campus.id, { saleAllowed: 'true' }),
    ).toHaveLength(0);
    await expect(
      service.campusProducts(a.campus.id, { saleAllowed: 'no' }),
    ).rejects.toThrow('筛选条件无效');
  });

  it('审批筛选按北京时间包含完整日期，支持状态、商品、楼长、类型和校区', async () => {
    const a = await fixture(),
      b = await fixture();
    const order = await a.receive(5);
    await b.request(1);
    await db.nightStockOrder.update({
      where: { id: order.id },
      data: { createdAt: new Date('2026-11-06T15:59:59.999Z') },
    });
    expect(
      await service.campusStockOrders(a.campus.id, 'received', a.store.id, {
        keyword: a.catalog.name,
        from: '2026-11-06',
        to: '2026-11-06',
      }),
    ).toHaveLength(1);
    expect(
      await service.campusStockOrders(a.campus.id, undefined, undefined, {
        from: '2026-11-07',
      }),
    ).toHaveLength(0);
    expect(
      await service.campusStockOrders(a.campus.id, undefined, b.store.id),
    ).toHaveLength(0);
    const p = (await service.products(a.staff.id))[0];
    const report = await service.createReport(a.staff.id, {
      requestId: randomUUID(),
      kind: 'loss',
      reason: '瓶身漏液待核对',
      items: [
        {
          nightProductId: p.id,
          quantity: 1,
          inventoryVersion: p.inventoryVersion,
        },
      ],
    });
    await db.nightInventoryReport.update({
      where: { id: report.id },
      data: { createdAt: new Date('2026-11-05T16:00:00.000Z') },
    });
    expect(
      await service.campusReports(a.campus.id, 'pending', undefined, {
        kind: 'loss',
        keyword: '漏液',
        from: '2026-11-06',
        to: '2026-11-06',
      }),
    ).toHaveLength(1);
    expect(
      await service.campusReports(a.campus.id, undefined, undefined, {
        kind: 'stocktake',
      }),
    ).toHaveLength(0);
    for (const filters of [
      { from: '2026-02-30' },
      { to: 'wrong' },
      { from: '2026-11-07', to: '2026-11-06' },
    ])
      await expect(
        service.campusStockOrders(a.campus.id, undefined, undefined, filters),
      ).rejects.toThrow();
    await expect(
      service.campusReports(a.campus.id, undefined, undefined, { kind: 'bad' }),
    ).rejects.toThrow('筛选条件无效');
  });

  it('同店并发申请不能拆单绕过额度；同一请求重试只占用一次', async () => {
    const f = await fixture(1500);
    const results = await Promise.allSettled([f.request(2), f.request(2)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await service.summary(f.store.id)).usedQuota).toBe(1000);
    const requestId = randomUUID();
    const first = await f.request(1, requestId);
    expect((await f.request(1, requestId)).id).toBe(first.id);
    await expect(f.request(2, requestId)).rejects.toThrow('原单不一致');
    expect((await service.summary(f.store.id)).usedQuota).toBe(1500);
  });

  it('额度不足的同备货申请补缴后可重试，预付取消不增押金且重复到账只释放一次新额度', async () => {
    const f = await fixture(500);
    const requestId = randomUUID();
    await expect(f.request(2, requestId)).rejects.toThrow('押金额度不足');
    const payments = { registerNightPaymentHandler() {}, nightPrepay: jest.fn(async () => ({ appId: 'isolated-test-app', merchantId: 'isolated-test-merchant' })) } as unknown as PaymentsService;
    const orders = new NightOrderService(db, payments, undefined, service);
    const intent = await orders.initiateDepositPay(f.store.id, f.campus.id, 'isolated-openid', 'isolated-test-app', 50000);
    expect(intent.amount).toBe(49500);
    expect((await service.summary(f.store.id)).deposit).toBe(500);
    await expect(f.request(2, requestId)).rejects.toThrow('押金额度不足');
    const retry = await orders.initiateDepositPay(f.store.id, f.campus.id, 'isolated-openid', 'isolated-test-app', 50000);
    expect(retry.outTradeNo).toBe(intent.outTradeNo);
    await orders.applyNightDepositPaid(intent.outTradeNo, 'isolated-paid');
    await orders.applyNightDepositPaid(intent.outTradeNo, 'isolated-paid');
    const stock = await f.request(2, requestId);
    expect((await f.request(2, requestId)).id).toBe(stock.id);
    expect(await service.summary(f.store.id)).toMatchObject({ deposit: 50000, reservedValue: 1000, stockValue: 0, usableQuota: 49000 });
    expect(await db.nightDepositTxn.count({ where: { storeId: f.store.id, payOrderNo: intent.outTradeNo } })).toBe(1);
  });

  it('仓库不足整单回滚；两个店并发审核不能重复预留同一库存', async () => {
    const f = await fixture(50000, 10);
    const building = await db.building.create({
      data: { campusId: f.campus.id, name: '第二验收楼' },
    });
    const staff = await db.staff.create({
      data: {
        campusId: f.campus.id,
        name: '第二楼长',
        role: 'building-manager',
        roleText: '楼长',
        staffNo: randomUUID(),
        building: building.name,
        onTimeRate: 100,
        income: 0,
      },
    });
    const peer = await db.nightStore.create({
      data: {
        campusId: f.campus.id,
        buildingId: building.id,
        managerStaffId: staff.id,
        deposit: 50000,
        commissionRate: 2000,
      },
    });
    const a = await f.request(6);
    const b = await service.createStockOrder(staff.id, {
      requestId: randomUUID(),
      items: [{ catalogProductId: f.catalog.id, quantity: 6 }],
    });
    const result = await Promise.allSettled([
      service.reviewStockOrder('test-admin', a.id, true, '同意'),
      service.reviewStockOrder('test-admin', b.id, true, '同意'),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await service.stockPool(f.staff.id))[0].warehouseAvailable).toBe(4);
    expect((await service.products(f.staff.id))[0].stock).toBe(0);
    expect((await service.summary(peer.id)).usedQuota).toBe(3000);
  });

  it('审核前楼长可撤回，审核后仅校区取消并完整释放仓库预留和额度', async () => {
    const f = await fixture();
    const a = await f.request(3);
    await service.cancelStockOrder(a.id, { staffId: f.staff.id }, '撤回');
    expect((await service.summary(f.store.id)).usedQuota).toBe(0);
    const b = await f.request(4);
    await service.reviewStockOrder('test-admin', b.id, true, '同意');
    await expect(
      service.cancelStockOrder(b.id, { staffId: f.staff.id }, '撤回'),
    ).rejects.toThrow('请联系校区');
    await service.cancelStockOrder(b.id, { operatorId: 'test-admin' }, '取消');
    await service.cancelStockOrder(b.id, { operatorId: 'test-admin' }, '重试');
    expect((await service.stockPool(f.staff.id))[0].warehouseAvailable).toBe(
      100,
    );
    expect((await service.summary(f.store.id)).usedQuota).toBe(0);
    await expect(service.shipStockOrder('test-admin', b.id)).rejects.toThrow(
      '仅已审核',
    );
  });

  it('出库不可取消，重复实收不重复入库，少收报损驳回仍占额度直至重新报审通过', async () => {
    const f = await fixture();
    const o = await f.request(5);
    await service.reviewStockOrder('test-admin', o.id, true, '同意');
    await service.shipStockOrder('test-admin', o.id);
    await expect(
      service.cancelStockOrder(o.id, { operatorId: 'test-admin' }, '取消'),
    ).rejects.toThrow('已出库');
    const received = [{ catalogProductId: f.catalog.id, quantity: 3 }];
    await service.receiveStockOrder(f.staff.id, o.id, received);
    await service.receiveStockOrder(f.staff.id, o.id, received);
    await expect(
      service.receiveStockOrder(f.staff.id, o.id, [
        { catalogProductId: f.catalog.id, quantity: 4 },
      ]),
    ).rejects.toThrow('不能修改');
    const report = (await service.reports(f.store.id))[0];
    await service.reviewReport('test-admin', report.id, false, '请补充核对');
    expect((await service.summary(f.store.id)).usedQuota).toBe(2500);
    await service.resubmitShortage(f.staff.id, report.id, '已复核，少收两件');
    await service.reviewReport('test-admin', report.id, true, '确认');
    expect((await service.summary(f.store.id)).usedQuota).toBe(1500);
    expect((await service.products(f.staff.id))[0].stock).toBe(3);
  });

  it('报损驳回恢复冻结数量和历史货值；过期盘点版本拒绝，盘盈审核才入库', async () => {
    const f = await fixture();
    await f.receive(5);
    let p = (await service.products(f.staff.id))[0];
    const r = await service.createReport(f.staff.id, {
      requestId: randomUUID(),
      kind: 'loss',
      reason: '破损待核对',
      items: [
        {
          nightProductId: p.id,
          quantity: 2,
          inventoryVersion: p.inventoryVersion,
        },
      ],
    });
    await expect(
      service.createReport(f.staff.id, {
        requestId: randomUUID(),
        kind: 'stocktake',
        reason: '重盘',
        items: [
          {
            nightProductId: p.id,
            quantity: 5,
            inventoryVersion: p.inventoryVersion,
          },
        ],
      }),
    ).rejects.toThrow('已有待审核');
    await service.reviewReport('test-admin', r.id, false, '实物完整');
    expect((await service.products(f.staff.id))[0]).toMatchObject({
      stock: 5,
      frozenStock: 0,
      inventoryValue: 2500,
    });
    await expect(
      service.createReport(f.staff.id, {
        requestId: randomUUID(),
        kind: 'stocktake',
        reason: '盘盈',
        items: [
          {
            nightProductId: p.id,
            quantity: 6,
            inventoryVersion: p.inventoryVersion,
          },
        ],
      }),
    ).rejects.toThrow('库存已变化');
    p = (await service.products(f.staff.id))[0];
    const gain = await service.createReport(f.staff.id, {
      requestId: randomUUID(),
      kind: 'stocktake',
      reason: '实物多一件',
      items: [
        {
          nightProductId: p.id,
          quantity: 6,
          inventoryVersion: p.inventoryVersion,
        },
      ],
    });
    expect((await service.products(f.staff.id))[0].stock).toBe(5);
    await service.reviewReport('test-admin', gain.id, true, '复核通过');
    expect((await service.products(f.staff.id))[0]).toMatchObject({
      stock: 6,
      inventoryValue: 3000,
    });
  });

  it('改价不会重估旧库存；新备货按申请价锁定而非收货时售价', async () => {
    const f = await fixture();
    await f.receive(3);
    const o = await f.request(2);
    await db.product.update({
      where: { id: f.catalog.id },
      data: { price: 900 },
    });
    expect((await service.summary(f.store.id)).usedQuota).toBe(2500);
    await service.reviewStockOrder('test-admin', o.id, true, '同意');
    await service.shipStockOrder('test-admin', o.id);
    await service.receiveStockOrder(f.staff.id, o.id, [
      { catalogProductId: f.catalog.id, quantity: 2 },
    ]);
    expect((await service.products(f.staff.id))[0]).toMatchObject({
      stock: 5,
      inventoryValue: 2500,
      price: 900,
    });
  });

  it('跨店不能确认收货、撤回备货或申报他店商品', async () => {
    const a = await fixture(),
      b = await fixture();
    const o = await a.request(2);
    await expect(
      service.receiveStockOrder(b.staff.id, o.id, [
        { catalogProductId: a.catalog.id, quantity: 2 },
      ]),
    ).rejects.toThrow('备货单不存在');
    await expect(
      service.cancelStockOrder(o.id, { staffId: b.staff.id }, '撤回'),
    ).rejects.toThrow('无权');
    const p = (await service.products(a.staff.id))[0];
    await expect(
      service.createReport(b.staff.id, {
        requestId: randomUUID(),
        kind: 'stocktake',
        reason: '越权盘点',
        items: [
          {
            nightProductId: p.id,
            quantity: 2,
            inventoryVersion: p.inventoryVersion,
          },
        ],
      }),
    ).rejects.toThrow('不属于本店');
  });

  it('下单到送达持续占额度，取消恢复原货值，送达释放且重试不重复处理', async () => {
    const f = await fixture();
    await f.receive(3);
    const user = await db.user.create({
      data: {
        campusId: f.campus.id,
        nickname: '库存销售验收用户',
        phone: randomUUID(),
      },
    });
    const address = await db.address.create({
      data: {
        userId: user.id,
        campusId: f.campus.id,
        campusName: f.campus.name,
        buildingId: f.building.id,
        buildingName: f.building.name,
        floor: 1,
        room: '101',
        contactName: '验收',
        phone: user.phone,
      },
    });
    await db.nightStore.update({
      where: { id: f.store.id },
      data: { status: 'open' },
    });
    const payments = {
      registerNightPaymentHandler: jest.fn(),
    } as unknown as PaymentsService;
    const orders = new NightOrderService(db, payments);
    const p = (await service.products(f.staff.id))[0];
    const a = await orders.submitOrder(user.id, {
      storeId: f.store.id,
      addressId: address.id,
      items: [{ productId: p.id, quantity: 1 }],
    });
    expect((await service.summary(f.store.id)).usedQuota).toBe(1500);
    await db.product.update({
      where: { id: f.catalog.id },
      data: { price: 900 },
    });
    await orders.closePendingPayment(a.id, '取消');
    await orders.closePendingPayment(a.id, '重试');
    expect((await service.products(f.staff.id))[0]).toMatchObject({
      stock: 3,
      inventoryValue: 1500,
    });
    const b = await orders.submitOrder(user.id, {
      storeId: f.store.id,
      addressId: address.id,
      items: [{ productId: p.id, quantity: 1 }],
    });
    await orders.applyNightOrderPaid(b.orderNo);
    await orders.acceptOrder(f.staff.id, f.store.id, b.id);
    expect((await service.summary(f.store.id)).usedQuota).toBe(1500);
    await orders.deliverOrder(f.staff.id, f.store.id, b.id, {
      images: ['https://example.com/proof.jpg'],
    });
    await orders.deliverOrder(f.staff.id, f.store.id, b.id, {
      images: ['https://example.com/proof.jpg'],
    });
    expect((await service.summary(f.store.id)).usedQuota).toBe(1000);
    expect((await service.products(f.staff.id))[0]).toMatchObject({
      stock: 2,
      inventoryValue: 1000,
    });
  });

  it('提交只预占额度，不增加楼栋库存；批准预留共享仓库库存，出库后收货才入库', async () => {
    const order = await service.createStockOrder(staffId, {
      requestId: 'first-stock-request',
      items: [{ catalogProductId: catalogId, quantity: 20 }],
    });
    expect(order.status).toBe('requested');
    expect((await service.summary(storeId)).usedQuota).toBe(10000);
    expect((await service.products(staffId))[0].stock).toBe(0);
    await service.reviewStockOrder('test-admin', order.id, true, '同意');
    expect((await service.stockPool(staffId))[0].warehouseAvailable).toBe(80);
    await service.shipStockOrder('test-admin', order.id);
    await service.receiveStockOrder(staffId, order.id, [
      { catalogProductId: catalogId, quantity: 18 },
    ]);
    expect((await service.products(staffId))[0].stock).toBe(18);
    expect((await service.summary(storeId)).usedQuota).toBe(10000);
    const reports = await service.reports(storeId);
    expect(reports[0].kind).toBe('receipt-shortage');
    await service.reviewReport(
      'test-admin',
      reports[0].id,
      true,
      '确认少收两件',
    );
    expect((await service.summary(storeId)).usedQuota).toBe(9000);
    expect((await service.products(staffId))[0].stock).toBe(18);
  });

  it('未送达退款不回库会转报损继续占额度；回库退款恢复原货值且不能重复回库', async () => {
    const f = await fixture();
    await f.receive(3);
    const user = await db.user.create({
      data: {
        campusId: f.campus.id,
        nickname: '退款库存验收',
        phone: randomUUID(),
      },
    });
    const address = await db.address.create({
      data: {
        userId: user.id,
        campusId: f.campus.id,
        campusName: f.campus.name,
        buildingId: f.building.id,
        buildingName: f.building.name,
        floor: 1,
        room: '101',
        contactName: '验收',
        phone: user.phone,
      },
    });
    await db.nightStore.update({
      where: { id: f.store.id },
      data: { status: 'open' },
    });
    const payments = {
      registerNightPaymentHandler: jest.fn(),
      applyWechatRefund: jest
        .fn()
        .mockResolvedValue({ refundId: 'test-refund', status: 'SUCCESS' }),
    } as unknown as PaymentsService;
    const orders = new NightOrderService(db, payments);
    const p = (await service.products(f.staff.id))[0];
    const a = await orders.submitOrder(user.id, {
      storeId: f.store.id,
      addressId: address.id,
      items: [{ productId: p.id, quantity: 1 }],
    });
    await orders.applyNightOrderPaid(a.orderNo);
    await orders.adminRefund('test-admin', a.id, {
      restock: false,
      refundDeliveryFee: true,
      reason: '未送达货物损坏',
    });
    expect((await service.summary(f.store.id)).usedQuota).toBe(1500);
    const report = (await service.reports(f.store.id))[0];
    expect(report.kind).toBe('order-loss');
    await service.reviewReport('test-admin', report.id, true, '确认损耗');
    expect((await service.summary(f.store.id)).usedQuota).toBe(1000);
    const b = await orders.submitOrder(user.id, {
      storeId: f.store.id,
      addressId: address.id,
      items: [{ productId: p.id, quantity: 1 }],
    });
    await orders.applyNightOrderPaid(b.orderNo);
    await orders.adminRefund('test-admin', b.id, {
      restock: true,
      refundDeliveryFee: true,
      reason: '完整退货',
    });
    expect((await orders.adminRefund('test-admin', b.id, { restock: true, refundDeliveryFee: true, reason: '重试' })).refundStatus).toBe('succeeded');
    expect(payments.applyWechatRefund).toHaveBeenCalledTimes(2);
    expect((await service.products(f.staff.id))[0]).toMatchObject({
      stock: 2,
      inventoryValue: 1000,
    });
    expect((await service.summary(f.store.id)).usedQuota).toBe(1000);
  });

  async function refundFixture(deposit = 50000) {
    const f = await fixture(deposit);
    await f.receive(3);
    await db.campus.update({ where: { id: f.campus.id }, data: { nightDeliveryFee: 200 } });
    const user = await db.user.create({ data: { campusId: f.campus.id, nickname: '退款状态验收', phone: randomUUID() } });
    const address = await db.address.create({ data: { userId: user.id, campusId: f.campus.id, campusName: f.campus.name, buildingId: f.building.id, buildingName: f.building.name, floor: 1, room: '101', contactName: '验收', phone: user.phone } });
    await db.nightStore.update({ where: { id: f.store.id }, data: { status: 'open' } });
    const apply = jest.fn().mockResolvedValue({ refundId: 'isolated-refund', status: 'SUCCESS' });
    const query = jest.fn().mockResolvedValue({ refundId: 'isolated-refund', status: 'SUCCESS' });
    const orders = new NightOrderService(db, { registerNightPaymentHandler: jest.fn(), applyWechatRefund: apply, queryWechatRefund: query } as unknown as PaymentsService);
    const p = (await service.products(f.staff.id))[0];
    const coupon = await db.coupon.create({ data: { campusId: f.campus.id, businessType: 'night', name: '退款验收券', amount: 100, threshold: 0, status: 'active', perUserLimit: 0 } });
    const held = await db.userCoupon.create({ data: { userId: user.id, couponId: coupon.id } });
    const order = await orders.submitOrder(user.id, { storeId: f.store.id, addressId: address.id, couponId: held.id, items: [{ productId: p.id, quantity: 1 }] });
    await orders.applyNightOrderPaid(order.orderNo);
    const resources = async () => ({ product: await db.nightProduct.findUniqueOrThrow({ where: { id: p.id } }), coupon: await db.userCoupon.findUniqueOrThrow({ where: { id: held.id } }), quota: await service.summary(f.store.id), commission: await db.nightCommissionTxn.aggregate({ where: { orderId: order.id }, _sum: { amount: true } }) });
    return { ...f, user, address, product: p, coupon, held, order, orders, apply, query, resources };
  }

  it('收入汇总独立于分页，超过100条不漏记，历史月份/状态和日期图表按同一口径', async () => {
    const f = await refundFixture();
    const month = nightBusinessDate(new Date(), '00:00', '23:59').slice(0, 7);
    const reporting = new NightReportingService(db);
    await db.nightCommissionTxn.createMany({ data: Array.from({ length: 120 }, (_, index) => ({ orderId: f.order.id, storeId: f.store.id, managerStaffId: f.staff.id, type: 'commission', amount: 1, status: index < 110 ? 'pending' : index < 115 ? 'settled' : 'estimated', createdAt: new Date(month + '-01T12:00:00+08:00') })) });
    const a = await reporting.income(f.staff.id, { nightStartAt: '00:00', nightEndAt: '23:59' }, { month, pageSize: '20' });
    expect(a).toMatchObject({ total: 122, page: 1, pageSize: 20, summary: { commission: { estimated: 85, pending: 110, settled: 5 }, deliveryFee: { estimated: 200, pending: 0, settled: 0 } } });
    expect(a.items).toHaveLength(20);
    expect(a.days.reduce((sum, day) => sum + day.commission + day.deliveryFee, 0)).toBe(115);
    const pending = await reporting.income(f.staff.id, { nightStartAt: '00:00', nightEndAt: '23:59' }, { month, status: 'pending', page: '6', pageSize: '20' });
    expect(pending.total).toBe(110); expect(pending.items).toHaveLength(10); expect(pending.summary).toEqual(a.summary);
    const empty = await reporting.income(f.staff.id, { nightStartAt: '00:00', nightEndAt: '23:59' }, { month: '2020-01' });
    expect(empty.total).toBe(0); expect(empty.days).toEqual([]);
    await expect(reporting.income(f.staff.id, { nightStartAt: '00:00', nightEndAt: '23:59' }, { month: '2026-13' })).rejects.toThrow('月份');
  });

  it('首页销售额排除配送费并扣已成功商品退款，真实收入只计待结算和已结算', async () => {
    const f = await refundFixture();
    const rider = new NightRiderService(db, f.orders);
    let dash = await rider.dashboard(f.staff.id);
    expect(dash).toMatchObject({ todaySales: 400, monthSales: 400, todayIncome: 0, monthIncome: 0 });
    await f.orders.acceptOrder(f.staff.id, f.store.id, f.order.id);
    await f.orders.deliverOrder(f.staff.id, f.store.id, f.order.id, { images: ['http://localhost:3150/api/v1/uploads/local-proof.jpg'] });
    dash = await rider.dashboard(f.staff.id);
    expect(dash).toMatchObject({ todayIncome: 280, monthIncome: 280 });
    await f.orders.adminRefund('isolated-admin', f.order.id, { restock: true, refundDeliveryFee: false, reason: '商品退回保留配送费' });
    dash = await rider.dashboard(f.staff.id);
    expect(dash).toMatchObject({ todaySales: 0, monthSales: 0, todayIncome: 200, monthIncome: 200 });
    const detail = await rider.storeOrderDetail(f.staff.id, f.order.id);
    expect(detail.refund?.status).toBe('succeeded');
    expect(await rider.orderEarning(f.staff.id, f.order.id)).toMatchObject({ commissionBase: 0, commission: 0, deliveryFee: 200, total: 200 });
    const admin = new NightAdminService(db, {} as PaymentsService, f.orders);
    expect((await admin.stores(f.campus.id))[0]).toMatchObject({ todaySales: 0 });
  });

  it('楼长开店或恢复不能用旧快照覆盖后台并发停业，经营动作写完整审计', async () => {
    for (const action of ['open', 'resume'] as const) {
      const f = await fixture();
      await f.receive(1);
      if (action === 'resume') await db.nightStore.update({ where: { id: f.store.id }, data: { status: 'paused' } });
      const orders = new NightOrderService(db, { registerNightPaymentHandler: jest.fn() } as unknown as PaymentsService);
      const inventory = new NightInventoryService(db);
      const lock = inventory.lockStore.bind(inventory);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      jest.spyOn(inventory, 'lockStore').mockImplementationOnce(async (tx, id, owner) => { entered(); await gate; return lock(tx, id, owner); });
      const rider = new NightRiderService(db, orders, inventory);
      const changing = action === 'open' ? rider.openStore(f.staff.id) : rider.resumeStore(f.staff.id);
      await started;
      try { await new NightAdminService(db, {} as PaymentsService, orders).updateStore('isolated-admin', f.store.id, { status: 'suspended' }); }
      finally { release(); }
      await expect(changing).rejects.toThrow('平台停业');
      expect((await db.nightStore.findUniqueOrThrow({ where: { id: f.store.id } })).status).toBe('suspended');
      await db.nightStore.update({ where: { id: f.store.id }, data: { status: 'closed' } });
      await rider.openStore(f.staff.id); await rider.pauseStore(f.staff.id); await rider.resumeStore(f.staff.id); await rider.closeStore(f.staff.id); await rider.closeStore(f.staff.id);
      expect((await db.auditLog.findMany({ where: { entityId: f.store.id, action: { startsWith: 'night.store.' }, operator: f.staff.id }, orderBy: { createdAt: 'asc' } })).map(row => row.action)).toEqual(['night.store.open', 'night.store.pause', 'night.store.resume', 'night.store.close']);
    }
  }, 60000);

  it('备货和申报超过500条、库存流水超过200条仍可分页；状态筛选先于分页且记录按楼长隔离', async () => {
    const f = await fixture();
    await f.receive(1);
    const product = (await service.products(f.staff.id))[0];
    const lines = [{ catalogProductId: f.catalog.id, warehouseProductId: f.warehouse.id, name: f.catalog.name, price: 500, quantity: 1 }];
    await db.nightStockOrder.createMany({ data: Array.from({ length: 510 }, (_, index) => ({ storeId: f.store.id, managerStaffId: f.staff.id, requestId: `page-stock-${index}`, status: 'cancelled', items: lines, totalValue: 500, heldValue: 0 })) });
    const stock = await service.stockOrdersPage(f.store.id, f.staff.id, 'cancelled', '11', '50');
    expect(stock).toMatchObject({ total: 510, page: 11 }); expect(stock.items).toHaveLength(10);
    expect(await service.stockOrdersPage(f.store.id, 'other-staff', 'cancelled', '1', '50')).toMatchObject({ total: 0 });
    await db.nightInventoryReport.createMany({ data: Array.from({ length: 510 }, (_, index) => ({ storeId: f.store.id, managerStaffId: f.staff.id, requestId: `page-report-${index}`, kind: 'loss', status: 'rejected', heldValue: 0, reason: '已驳回历史记录分页容量夹具', items: [{ nightProductId: product.id, name: product.name, quantity: 1, delta: -1, value: 500, unitValue: 500, bookQuantity: 1 }] })) });
    const reports = await service.reportsPage(f.store.id, f.staff.id, '11', '50');
    expect(reports.total).toBe(510); expect(reports.items).toHaveLength(10);
    expect(await service.reportsPage(f.store.id, 'other-staff', '1', '50')).toMatchObject({ total: 0 });
    expect(await service.campusStockOrders(f.campus.id, 'cancelled')).toHaveLength(510);
    expect(await service.campusReports(f.campus.id, 'rejected')).toHaveLength(510);
    const before = await db.nightStockTxn.count({ where: { storeId: f.store.id } });
    await db.nightStockTxn.createMany({ data: Array.from({ length: 220 }, (_, index) => ({ storeId: f.store.id, nightProductId: product.id, type: 'adjust', delta: index % 2 ? -1 : 1, afterStock: index % 2 ? 1 : 2, remark: '历史库存流水容量夹具：成对增减净额0' })) });
    const txns = await service.transactionsPage(f.store.id, product.id, '3', '100');
    expect(txns.total).toBe(before + 220); expect(txns.items).toHaveLength(before + 20);
    expect(await service.transactionsPage('other-store', product.id, '1', '100')).toMatchObject({ total: 0 });
    expect(await service.summary(f.store.id)).toMatchObject({ stockValue: 500, reservedValue: 0 });
  }, 40000);

  it('结算批次超过1000条仍完整聚合，冲减不丢失；并发重复标记打款只留一份记录', async () => {
    const f = await refundFixture();
    const batch = `BATCH-PAGING-${randomUUID()}`;
    await db.nightCommissionTxn.createMany({ data: Array.from({ length: 1205 }, (_, index) => ({ orderId: f.order.id, storeId: f.store.id, managerStaffId: f.staff.id, type: index < 1200 ? 'commission' : 'deliveryFee', amount: index === 0 ? -1 : index < 1200 ? 1 : 20, status: 'settled', settleBatch: batch, remark: '长备注'.repeat(166) })) });
    expect((await f.orders.settlements(f.campus.id)).find(row => row.batch === batch)).toMatchObject({ txnCount: 1205, commissionTotal: 1198, deliveryFeeTotal: 100, markedPaid: false });
    const attempts = await Promise.allSettled([f.orders.markBatchPaid(batch, 'isolated-admin', '已核实本机模拟人工回单'), f.orders.markBatchPaid(batch, 'isolated-admin', '重复点击'), f.orders.markBatchPaid(batch, 'isolated-admin', '网络重试')]);
    const results = attempts.map(attempt => { if (attempt.status === 'rejected') throw attempt.reason; return attempt.value; });
    expect(results.filter(row => !row.alreadyPaid)).toHaveLength(1);
    const records = await db.nightCommissionTxn.findMany({ where: { settleBatch: batch }, select: { remark: true } });
    expect(records.every(row => row.remark.length <= 500 && row.remark.split(' | 已打款 ').length === 2)).toBe(true);
    expect(await db.auditLog.count({ where: { entityId: batch, action: 'night.settlement.markPaid' } })).toBe(1);
    expect((await f.orders.settlements(f.campus.id)).find(row => row.batch === batch)).toMatchObject({ txnCount: 1205, commissionTotal: 1198, deliveryFeeTotal: 100, markedPaid: true });
    expect(await f.orders.settlements('foreign-campus')).toEqual([]);
  }, 40000);

  it('用户订单和后台订单数据库分页越过100条，筛选不泄露他人订单且保留订单校区客服', async () => {
    const f = await refundFixture();
    const original = await db.nightOrder.findUniqueOrThrow({ where: { id: f.order.id } });
    await db.campus.update({ where: { id: f.campus.id }, data: { servicePhone: '4000000001', showDeliveryContacts: false } });
    // 列表容量夹具：已关闭且已释放资源，不产生库存或资金流水。
    await db.nightOrder.createMany({ data: Array.from({ length: 120 }, (_, index) => ({ ...original, couponSnapshot: Prisma.DbNull, items: original.items as Prisma.InputJsonValue, address: original.address as Prisma.InputJsonValue, timeline: original.timeline as Prisma.InputJsonValue, id: randomUUID(), orderNo: `PAGE-${randomUUID()}`, requestId: null, requestHash: null, couponId: null, status: 'cancelled', statusText: '已取消', paidAt: null, quotaHeld: 0, inventoryRestocked: true, createdAt: new Date(Date.now() - index * 1000) })) });
    const a = await f.orders.myOrdersPage(f.user.id, 'all', '1', '20');
    const b = await f.orders.myOrdersPage(f.user.id, 'all', '6', '20');
    const c = await f.orders.myOrdersPage(f.user.id, 'all', '7', '20');
    expect(a.total).toBe(121); expect(b.items).toHaveLength(20); expect(c.items).toHaveLength(1);
    expect(new Set([...a.items, ...b.items, ...c.items].map(row => row.id)).size).toBe(41);
    expect(await f.orders.myOrdersPage(f.user.id, 'pending-accept', '1', '20')).toMatchObject({ total: 1 });
    expect(await f.orders.myOrdersPage('foreign-user', 'all', '1', '20')).toMatchObject({ total: 0 });
    expect(await f.orders.adminOrdersPage(f.campus.id, { status: 'cancelled' }, '6', '20')).toMatchObject({ total: 120, items: expect.arrayContaining([expect.objectContaining({ status: 'cancelled' })]) });
    const own = await f.orders.myOrder(f.user.id, f.order.id);
    expect(own.support?.phone).toBe('4000000001');
    expect(own.deliveryContact).toBeNull();
  }, 40000);

  it('押金账本超过100笔仍可分页查询，类型筛选和楼长归属一致', async () => {
    const f = await fixture(13000);
    await db.nightDepositTxn.createMany({ data: Array.from({ length: 130 }, () => ({ storeId: f.store.id, type: 'deposit', amount: 100, payOrderNo: randomUUID() })) });
    const page = await service.depositTransactions(f.store.id, '7', '20', 'deposit');
    expect(page).toMatchObject({ total: 130, page: 7, pageSize: 20 }); expect(page.items).toHaveLength(10);
    expect(await service.depositTransactions(f.store.id, '1', '20', 'refund')).toMatchObject({ total: 0 });
    expect(await new NightRiderService(db, {} as NightOrderService).depositDetail(f.staff.id, '7', '20')).toMatchObject({ staffId: f.staff.id, storeId: f.store.id, total: 130, txns: page.items.map(row => expect.objectContaining({ id: row.id })) });
  });

  it('下单请求并发重试只建一单扣一次库存，复用标识改内容拒绝，金额变化要求重确认', async () => {
    const f = await refundFixture();
    const dto = { requestId: randomUUID(), storeId: f.store.id, addressId: f.address.id, expectedProductAmount: 500, expectedDeliveryFee: 200, items: [{ productId: f.product.id, quantity: 1 }] };
    const results = await Promise.all([f.orders.submitOrder(f.user.id, dto), f.orders.submitOrder(f.user.id, dto), f.orders.submitOrder(f.user.id, dto)]);
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    expect((await f.resources()).product.stock).toBe(1);
    await expect(f.orders.submitOrder(f.user.id, { ...dto, items: [{ productId: f.product.id, quantity: 2 }] })).rejects.toThrow('请求标识');
    await expect(f.orders.submitOrder(f.user.id, { ...dto, requestId: randomUUID(), expectedProductAmount: 499 })).rejects.toThrow('价格或配送费已变化');
    expect(await db.nightOrder.count({ where: { storeId: f.store.id } })).toBe(2);
  });

  it('夜宵券只抵适用商品且不抵配送费；范围不可跨校区，发放后不可缩改', async () => {
    const f = await refundFixture();
    const admin = new AdminService(db, new BusinessService(db));
    const foreign = await fixture();
    await expect(admin.createCoupon({ name: '非法范围', businessType: 'night', amount: 100, threshold: 0, nightProductIds: [foreign.catalog.id] }, 'isolated-admin', f.campus.id)).rejects.toThrow('本校区夜宵商品库');
    const coupon = await admin.createCoupon({ name: '适用商品券', businessType: 'night', amount: 1000, threshold: 500, nightProductIds: [f.catalog.id] }, 'isolated-admin', f.campus.id);
    const held = await f.orders.claimNightCoupon(f.user.id, coupon.id, f.campus.id);
    await expect(admin.updateCoupon(coupon.id, { nightProductIds: [] }, 'isolated-admin', f.campus.id)).rejects.toThrow('不可修改');
    // 暂停发放不撤销已经领取的资产。
    await admin.updateCoupon(coupon.id, { status: 'paused' }, 'isolated-admin', f.campus.id);
    const order = await f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, couponId: held.id, items: [{ productId: f.product.id, quantity: 1 }] });
    expect(order).toMatchObject({ productAmount: 500, couponDiscount: 500, deliveryFee: 200, payableAmount: 200 });
    const mismatch = await admin.createCoupon({ name: '不适用商品券', businessType: 'night', amount: 100, threshold: 0, nightProductIds: [foreign.catalog.id] }, 'isolated-admin', foreign.campus.id);
    const wrong = await db.userCoupon.create({ data: { userId: f.user.id, couponId: mismatch.id } });
    await expect(f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, couponId: wrong.id, items: [{ productId: f.product.id, quantity: 1 }] })).rejects.toThrow('当前校区');
  });

  it('同校区但购物车无券适用商品时不得抵扣', async () => {
    const f = await refundFixture();
    const other = await db.product.create({ data: { campusId: f.campus.id, categoryId: f.catalog.categoryId, name: '另一个夜宵商品', subtitle: '', price: 200, originalPrice: 200, stock: 0, nightCatalog: true, tag: '', image: '', weight: 0 } });
    const coupon = await db.coupon.create({ data: { campusId: f.campus.id, name: '限定另一个商品', businessType: 'night', status: 'active', amount: 100, threshold: 0, nightProductIds: [other.id] } });
    const held = await f.orders.claimNightCoupon(f.user.id, coupon.id, f.campus.id);
    await expect(f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, couponId: held.id, items: [{ productId: f.product.id, quantity: 1 }] })).rejects.toThrow('门槛');
    expect((await f.resources()).product.stock).toBe(2);
  });

  it('夜宵分类单位和售价可独立调整，拒绝跨校区分类且保留共享仓、库存货值及订单快照', async () => {
    const f = await refundFixture();
    const category = await db.category.create({ data: { campusId: f.campus.id, name: '夜宵饮品新分类' } });
    const foreign = await db.campus.create({ data: { name: '分类边界校区', shortName: '边界', warehouseName: '边界仓' } });
    const foreignCategory = await db.category.create({ data: { campusId: foreign.id, name: '不可借用分类' } });
    const admin = new NightAdminService(db, {} as PaymentsService, f.orders);
    const beforeWarehouse = await db.product.findUniqueOrThrow({ where: { id: f.warehouse.id } });
    const beforeOrder = await db.nightOrder.findUniqueOrThrow({ where: { id: f.order.id } });
    await expect(admin.updateCatalogProduct('isolated-admin', f.catalog.id, { categoryId: foreignCategory.id })).rejects.toThrow('不属于该校区');
    await expect(admin.updateCatalogProduct('isolated-admin', f.catalog.id, { retailUnit: '  ' })).rejects.toThrow('零售单位');
    const updated = await admin.updateCatalogProduct('isolated-admin', f.catalog.id, { categoryId: category.id, retailUnit: '听', price: 700, originalPrice: 0, subtitle: '独立夜宵规格' });
    expect(updated).toMatchObject({ categoryId: category.id, retailUnit: '听', price: 700, originalPrice: 0 });
    expect((await service.catalogCategories(f.campus.id)).some(row => row.id === category.id)).toBe(true);
    expect(await db.product.findUniqueOrThrow({ where: { id: f.warehouse.id } })).toEqual(beforeWarehouse);
    expect((await f.resources()).product).toMatchObject({ stock: 2, inventoryValue: 1000 });
    const afterOrder = await db.nightOrder.findUniqueOrThrow({ where: { id: f.order.id } });
    expect(afterOrder.items).toEqual(beforeOrder.items);
    expect(afterOrder.productAmount).toBe(beforeOrder.productAmount);
  });

  it('领券并发不突破每人限领和模板总量；允许多张时可领取到限额', async () => {
    const f = await refundFixture();
    const coupon = await db.coupon.create({ data: { campusId: f.campus.id, name: '限量券', businessType: 'night', status: 'active', amount: 100, threshold: 0, total: 2, perUserLimit: 2 } });
    await Promise.all(Array.from({ length: 5 }, () => f.orders.claimNightCoupon(f.user.id, coupon.id, f.campus.id)));
    expect(await db.userCoupon.count({ where: { userId: f.user.id, couponId: coupon.id } })).toBe(2);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).claimed).toBe(2);
    const other = await db.user.create({ data: { campusId: f.campus.id, nickname: '第二名用户', phone: randomUUID() } });
    await expect(f.orders.claimNightCoupon(other.id, coupon.id, f.campus.id)).rejects.toThrow('领完');
    expect((await f.orders.nightCoupons(f.user.id, f.campus.id)).claimable.some(c => c.id === coupon.id)).toBe(false);
  });

  it('零元订单直接内部确认而不调用支付渠道，取消恢复库存和券且无需资金退款', async () => {
    const f = await refundFixture();
    await db.campus.update({ where: { id: f.campus.id }, data: { nightDeliveryFee: 0 } });
    const coupon = await db.coupon.create({ data: { campusId: f.campus.id, name: '零元验收券', businessType: 'night', status: 'active', amount: 500, threshold: 0 } });
    const held = await f.orders.claimNightCoupon(f.user.id, coupon.id, f.campus.id);
    const order = await f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, couponId: held.id, items: [{ productId: f.product.id, quantity: 1 }] });
    expect(order).toMatchObject({ payableAmount: 0, status: 'pending-accept' });
    expect(order.paidAt).toBeTruthy();
    const result = await f.orders.cancelByUser(f.user.id, order.id, '零元取消');
    expect(result).toMatchObject({ status: 'cancelled', refund: { status: 'succeeded', amount: 0 } });
    expect(f.apply).not.toHaveBeenCalled();
    expect((await db.userCoupon.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('released');
    expect((await f.resources()).product.stock).toBe(2);
  });

  it('商品全被券抵扣时，单退配送费与整单商品回库是不同的业务操作', async () => {
    const f = await refundFixture();
    const make = async () => {
      const coupon = await db.coupon.create({ data: { campusId: f.campus.id, name: '商品全抵券', businessType: 'night', status: 'active', amount: 500, threshold: 0 } });
      const held = await f.orders.claimNightCoupon(f.user.id, coupon.id, f.campus.id);
      const order = await f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, couponId: held.id, items: [{ productId: f.product.id, quantity: 1 }] });
      await f.orders.applyNightOrderPaid(order.orderNo);
      return { order, held };
    };
    const a = await make();
    await f.orders.adminRefund('isolated-admin', a.order.id, { productRefund: 0, refundDeliveryFee: true, restock: false, reason: '仅配送费补偿' });
    expect((await f.orders.myOrder(f.user.id, a.order.id)).status).toBe('pending-accept');
    expect((await db.userCoupon.findUniqueOrThrow({ where: { id: a.held.id } })).status).toBe('used');
    expect((await f.resources()).product.stock).toBe(1);
    const b = await make();
    const result = await f.orders.adminRefund('isolated-admin', b.order.id, { restock: true, refundDeliveryFee: false, reason: '商品退回保留配送费，无资金退款' });
    expect(result).toMatchObject({ refundStatus: 'succeeded', refundAmount: 0 });
    expect((await f.orders.myOrder(f.user.id, b.order.id)).status).toBe('refunded');
    expect((await db.userCoupon.findUniqueOrThrow({ where: { id: b.held.id } })).status).toBe('released');
    expect((await f.resources()).product.stock).toBe(1);
    expect(f.apply).toHaveBeenCalledTimes(1);
  }, 40000); // 两条完整下单/退款链路，远程测试库耗时独立于单次API时延。

  it('退款PROCESSING不回库不退券不冲佣金；查单成功后只结算一次', async () => {
    const f = await refundFixture();
    f.apply.mockResolvedValue({ refundId: 'isolated-refund', status: 'PROCESSING' });
    f.query.mockResolvedValue({ refundId: 'isolated-refund', status: 'PROCESSING' });
    const result = await f.orders.cancelByUser(f.user.id, f.order.id, '用户取消');
    expect(result).toMatchObject({ status: 'cancelling', refund: { status: 'processing', amount: 600 } });
    let r = await f.resources();
    expect(r.product).toMatchObject({ stock: 2, inventoryValue: 1000 });
    expect(r.coupon.status).toBe('used');
    expect(r.commission._sum.amount).toBe(280);
    expect(r.quota.usedQuota).toBe(1500);
    await expect(f.orders.acceptOrder(f.staff.id, f.store.id, f.order.id)).rejects.toThrow('退款');
    const retry = await f.orders.cancelByUser(f.user.id, f.order.id, '网络恢复后重复取消');
    expect(retry.status).toBe('cancelling');
    expect(f.apply).toHaveBeenCalledTimes(1);
    f.query.mockResolvedValue({ refundId: 'isolated-refund', status: 'SUCCESS' });
    expect((await f.orders.cancelByUser(f.user.id, f.order.id, '再次查单')).status).toBe('cancelled');
    expect((await f.orders.cancelByUser(f.user.id, f.order.id, '已取消重复点击')).status).toBe('cancelled');
    await f.orders.reconcilePendingRefunds();
    r = await f.resources();
    expect(r.product).toMatchObject({ stock: 3, inventoryValue: 1500 });
    expect(r.coupon.status).toBe('released');
    expect(r.commission._sum.amount).toBe(0);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect((await f.orders.myOrder(f.user.id, f.order.id)).refund?.status).toBe('succeeded');
    expect(await db.nightStockTxn.count({ where: { refId: f.order.id, type: 'refundBack' } })).toBe(1);
  });

  it('用户店铺三态与可购时段一致：窗外、总开关关闭、白天营业都显示休息且不能下单', async () => {
    const f = await refundFixture();
    const users = new NightUserService(db, f.orders);
    expect((await users.storeDetail(f.campus.id, f.store.id)).state).toBe('open');
    const before = (await f.resources()).product.stock;
    const now = beijingMinutes();
    const clock = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    await db.campus.update({ where: { id: f.campus.id }, data: { nightStartAt: clock((now + 60) % 1440), nightEndAt: clock((now + 120) % 1440) } });
    expect((await users.storeDetail(f.campus.id, f.store.id))).toMatchObject({ state: 'resting', storeStatus: 'open', session: { inNightSession: false } });
    await expect(f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, items: [{ productId: f.product.id, quantity: 1 }] })).rejects.toThrow();
    expect((await f.resources()).product.stock).toBe(before);
    await db.campus.update({ where: { id: f.campus.id }, data: { nightStartAt: clock((now + 1080) % 1440), nightEndAt: clock((now + 360) % 1440), nightEnabled: false } });
    expect((await users.storeDetail(f.campus.id, f.store.id)).state).toBe('resting');
    await db.campus.update({ where: { id: f.campus.id }, data: { nightEnabled: true, manualClosed: false, closeStart: '00:00', closeEnd: '00:00' } });
    expect((await users.storeDetail(f.campus.id, f.store.id)).state).toBe('resting');
    await db.nightStore.update({ where: { id: f.store.id }, data: { managerStaffId: null } });
    expect((await users.storeDetail(f.campus.id, f.store.id)).state).toBe('no-manager');
  }, 40000);

  it('支付先于未支付取消落账时返回真实已支付状态，重新确认退款才释放资源', async () => {
    const f = await refundFixture();
    const pending = await f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, items: [{ productId: f.product.id, quantity: 1 }] });
    const originalClose = f.orders.closePendingPayment.bind(f.orders);
    jest.spyOn(f.orders, 'closePendingPayment').mockImplementationOnce(async (id, reason) => {
      await f.orders.applyNightOrderPaid(pending.orderNo, 'WX_CANCEL_RACE_LOCAL');
      return originalClose(id, reason);
    });
    const controller = new NightUserController(new NightUserService(db, f.orders));
    const req = { user: { id: f.user.id } } as Parameters<NightUserController['cancel']>[0];
    const result = await controller.cancel(req, pending.id, { reason: '未支付时点击取消' });
    expect(result).toMatchObject({ message: '订单状态已更新，请核对', data: { status: 'pending-accept' } });
    expect(f.apply).not.toHaveBeenCalled();
    expect((await f.resources()).product.stock).toBe(1);
    expect(await db.nightRefund.count({ where: { orderId: pending.id } })).toBe(0);
    expect(await db.nightCommissionTxn.count({ where: { orderId: pending.id } })).toBe(2);
    const cancelled = await controller.cancel(req, pending.id, { reason: '确认已支付订单原路退款' });
    expect(cancelled).toMatchObject({ message: '订单已取消', data: { status: 'cancelled', refund: { status: 'succeeded' } } });
    await controller.cancel(req, pending.id, { reason: '重复点击' });
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect((await f.resources()).product.stock).toBe(2);
    expect(await db.nightStockTxn.count({ where: { refId: pending.id, type: 'refundBack' } })).toBe(1);
  }, 40000);

  it('已支付取消退款后重复支付回调不误转异常；超时关闭后真正晚到账可整单退款', async () => {
    const f = await refundFixture();
    await f.orders.cancelByUser(f.user.id, f.order.id, '取消');
    await f.orders.applyNightOrderPaid(f.order.orderNo, 'WX_DUPLICATE');
    expect((await f.orders.myOrder(f.user.id, f.order.id)).status).toBe('cancelled');
    expect((await f.resources()).product.stock).toBe(3);
    const pending = await f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, items: [{ productId: f.product.id, quantity: 1 }] });
    await f.orders.closePendingPayment(pending.id, '支付超时');
    await f.orders.applyNightOrderPaid(pending.orderNo, 'WX_LATE');
    expect((await f.orders.myOrder(f.user.id, pending.id)).status).toBe('exception');
    await f.orders.adminRefund('isolated-admin', pending.id, { restock: false, refundDeliveryFee: true, reason: '关闭后晚到账原路退回' });
    expect((await f.orders.myOrder(f.user.id, pending.id)).refund?.status).toBe('succeeded');
    expect((await f.resources()).product.stock).toBe(3);
    expect(await db.nightCommissionTxn.count({ where: { orderId: pending.id } })).toBe(0);
  });

  it('售后完整说明与凭证留痕，进行中暂缓结算，驳回后恢复资格且防重复审核', async () => {
    const f = await refundFixture();
    await f.orders.acceptOrder(f.staff.id, f.store.id, f.order.id);
    await f.orders.deliverOrder(f.staff.id, f.store.id, f.order.id, { images: ['http://localhost:3150/api/v1/uploads/local-proof.jpg'] });
    const body = { type: 'missing', description: '用户反馈少了一件，请核查送达照片和完整商品数量。', images: ['http://localhost:3150/api/v1/uploads/after-sale.jpg'] };
    await f.orders.applyAfterSale(f.user.id, f.order.id, body);
    const timeline = (await f.orders.myOrder(f.user.id, f.order.id)).timeline;
    expect(Array.isArray(timeline)).toBe(true);
    expect((Array.isArray(timeline) ? timeline : []).find(t => typeof t === 'object' && t !== null && !Array.isArray(t) && t.key === 'after-sale')).toMatchObject({ description: 'missing：' + body.description, images: body.images });
    expect((await f.orders.settleBatch(f.campus.id)).txnCount).toBe(0);
    await f.orders.rejectAfterSale('isolated-admin', f.order.id, '已核对照片和数量，确认全部送达');
    expect((await f.orders.settleBatch(f.campus.id)).txnCount).toBe(2);
    await expect(f.orders.rejectAfterSale('isolated-admin', f.order.id, '重复审核')).rejects.toThrow('状态已变化');
  });

  it('后台夜宵商品详情和推荐设置传到用户端，保存白天推荐不会清除夜宵推荐', async () => {
    const f = await refundFixture();
    const admin = new NightAdminService(db, {} as PaymentsService, f.orders);
    await admin.updateCatalogProduct('isolated-admin', f.catalog.id, {
      images: ['http://localhost:3150/api/v1/uploads/front.jpg', 'http://localhost:3150/api/v1/uploads/back.jpg'],
      description: '独立夜宵介绍\n保留多行内容', featured: true, featuredSort: 3,
    });
    const customer = new NightUserService(db, f.orders);
    expect((await customer.storeProducts(f.campus.id, f.store.id))[0]).toMatchObject({ description: '独立夜宵介绍\n保留多行内容', images: expect.arrayContaining(['http://localhost:3150/api/v1/uploads/back.jpg']), featured: true });
    await new AdminService(db, new BusinessService(db)).saveFeatured([], f.campus.id);
    expect((await customer.storeProducts(f.campus.id, f.store.id))[0].featured).toBe(true);
    expect((await db.product.findUniqueOrThrow({ where: { id: f.warehouse.id } })).description).not.toBe('独立夜宵介绍\n保留多行内容');
  });

  it('夜宵限时特惠按服务端活动价展示和锁单，不能叠券，过期恢复原价并拒绝旧金额', async () => {
    const f = await refundFixture();
    const promotion = await db.promotion.create({ data: { productId: f.catalog.id, type: 'clearance', price: 300, startsAt: new Date(Date.now() - 60000), endsAt: new Date(Date.now() + 60000) } });
    const admin = new AdminService(db, new BusinessService(db));
    expect(await admin.promotions(f.campus.id, undefined, undefined, 'day')).toEqual([]);
    expect(await admin.promotions(f.campus.id, undefined, undefined, 'night')).toHaveLength(1);
    const customer = new NightUserService(db, f.orders);
    expect((await customer.storeProducts(f.campus.id, f.store.id))[0]).toMatchObject({ price: 300, originalPrice: 500 });
    await expect(f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, couponId: f.held.id, items: [{ productId: f.product.id, quantity: 1 }] })).rejects.toThrow('不可叠加');
    const order = await f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, expectedProductAmount: 300, items: [{ productId: f.product.id, quantity: 1 }] });
    expect(order).toMatchObject({ productAmount: 300, payableAmount: 500, items: [expect.objectContaining({ price: 300, promotionId: promotion.id })] });
    await f.orders.applyNightOrderPaid(order.orderNo);
    expect((await new NightReportingService(db).income(f.staff.id, { nightStartAt: '00:00', nightEndAt: '23:59' })).summary).toMatchObject({ commission: { estimated: 140 }, deliveryFee: { estimated: 400 } });
    await db.promotion.update({ where: { id: promotion.id }, data: { endsAt: new Date(Date.now() - 1) } });
    expect((await customer.storeProducts(f.campus.id, f.store.id))[0].price).toBe(500);
    await expect(f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, expectedProductAmount: 300, items: [{ productId: f.product.id, quantity: 1 }] })).rejects.toThrow('价格或配送费已变化');
  });

  it('夜宵秒杀独立于原价渠道，每单1件，过期不能伪装成原价继续结算', async () => {
    const f = await refundFixture();
    const promotion = await db.promotion.create({ data: { productId: f.catalog.id, type: 'seckill', price: 200, startsAt: new Date(Date.now() - 60000), endsAt: new Date(Date.now() + 60000) } });
    const product = (await new NightUserService(db, f.orders).storeProducts(f.campus.id, f.store.id))[0];
    expect(product).toMatchObject({ price: 500, seckill: { id: promotion.id, price: 200 } });
    await expect(f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, items: [{ productId: f.product.id, quantity: 2, asSeckill: true, promotionId: promotion.id }] })).rejects.toThrow('每单限购1件');
    const requestId = randomUUID();
    const order = await f.orders.submitOrder(f.user.id, { requestId, storeId: f.store.id, addressId: f.address.id, expectedProductAmount: 200, items: [{ productId: f.product.id, quantity: 1, asSeckill: true, promotionId: promotion.id }] });
    expect(order).toMatchObject({ productAmount: 200, items: [expect.objectContaining({ asSeckill: true, promotionId: promotion.id })] });
    await f.orders.applyNightOrderPaid(order.orderNo);
    expect(await f.orders.cancelByUser(f.user.id, order.id)).toMatchObject({ refund: { status: 'succeeded', amount: 400 } });
    expect((await f.resources()).product).toMatchObject({ stock: 2, inventoryValue: 1000 });
    const normal = await f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, expectedProductAmount: 1000, items: [{ productId: f.product.id, quantity: 2, asSeckill: false }] });
    expect(normal.productAmount).toBe(1000);
    await f.orders.cancelByUser(f.user.id, normal.id);
    await db.promotion.update({ where: { id: promotion.id }, data: { endsAt: new Date(Date.now() - 1) } });
    await expect(f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, items: [{ productId: f.product.id, quantity: 1, asSeckill: true, promotionId: promotion.id }] })).rejects.toThrow('秒杀活动未开始或已结束');
    const next = await db.promotion.create({ data: { productId: f.catalog.id, type: 'seckill', price: 200, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 60000) } });
    await expect(f.orders.submitOrder(f.user.id, { requestId, storeId: f.store.id, addressId: f.address.id, expectedProductAmount: 200, items: [{ productId: f.product.id, quantity: 1, asSeckill: true, promotionId: next.id }] })).rejects.toThrow('已用于其他内容');
    await expect(f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, items: [{ productId: f.product.id, quantity: 1, asSeckill: true, promotionId: promotion.id }] })).rejects.toThrow('秒杀活动已变化');
  });

  it('白天购物车的单品与整袋入口拒绝其他校区和夜宵主档，旧脏行不会出现在当前车里', async () => {
    const f = await fixture(), foreign = await fixture();
    await db.campus.updateMany({ where: { id: { in: [f.campus.id, foreign.campus.id] } }, data: { manualClosed: false, closeStart: '00:00', closeEnd: '00:00' } });
    const user = await db.user.create({ data: { campusId: f.campus.id, nickname: '购物车渠道边界验收', phone: randomUUID() } });
    const business = new BusinessService(db);
    await business.setCartItem(user.id, f.warehouse.id, 1);
    await expect(business.updateCart(user.id, { items: [{ productId: foreign.warehouse.id, quantity: 1 }] })).rejects.toThrow('当前校区');
    await expect(business.setCartItem(user.id, foreign.warehouse.id, 1)).rejects.toThrow('当前校区');
    await db.product.update({ where: { id: f.catalog.id }, data: { stock: 100 } });
    await expect(business.updateCart(user.id, { items: [{ productId: f.catalog.id, quantity: 1 }] })).rejects.toThrow('渠道');
    await db.cartItem.create({ data: { userId: user.id, productId: foreign.warehouse.id, quantity: 1 } });
    expect((await business.cart(user.id)).items.map(line => line.product.id)).toEqual([f.warehouse.id]);
  });

  it('日夜注册券由同一幂等发券内核发放，礼包列表仅展示本渠道且保留触发类型', async () => {
    const f = await fixture();
    const user = await db.user.create({ data: { campusId: f.campus.id, nickname: '新人礼包渠道验收', phone: '13800009912' } });
    const coupons = [];
    for (const businessType of ['day', 'night']) coupons.push(await db.coupon.create({ data: { campusId: f.campus.id, businessType, name: `${businessType}新人券`, amount: 100, threshold: 0, trigger: 'signup', status: 'active', total: 10 } }));
    const business = new BusinessService(db);
    expect((await business.grantSignupCoupons(user.id, f.campus.id)).granted).toBe(2);
    expect((await business.grantSignupCoupons(user.id, f.campus.id)).granted).toBe(0);
    const day = await business.coupons(user.id, f.campus.id);
    const night = await new NightOrderService(db, { registerNightPaymentHandler() {} } as unknown as PaymentsService).nightCoupons(user.id, f.campus.id);
    expect(day.mine.map(row => row.couponId)).toEqual([coupons[0].id]);
    expect(night.mine.map(row => row.couponId)).toEqual([coupons[1].id]);
    expect(night.mine[0].coupon.trigger).toBe('signup');
  });

  it('用户切换校区后，日夜历史订单客服与福利群仍取原订单校区', async () => {
    const f = await refundFixture(), other = await fixture();
    await db.campus.update({ where: { id: f.campus.id }, data: { servicePhone: '13800009910', serviceQrcode: '/original-support.png', afterSalesGroupQrcode: '/original-group.png', groupQrcodeTip: '原校区福利群' } });
    await db.campus.update({ where: { id: other.campus.id }, data: { servicePhone: '13800009911', afterSalesGroupQrcode: '/wrong-group.png' } });
    // Historical read fixture: this test checks ownership/context, not payment settlement.
    const day = await db.order.create({ data: { campusId: f.campus.id, userId: f.user.id, orderNo: `SUPPORT-${randomUUID()}`, status: 'paid', statusText: '待接单', items: [], address: {}, deliveryMode: 'instant', productAmount: 500, totalQuantity: 1, deliveryThreshold: 0, deliveryFee: 0, discount: 0, payableAmount: 500, estimatedArrival: '', timeline: [] } });
    await db.user.update({ where: { id: f.user.id }, data: { campusId: other.campus.id } });
    const business = new BusinessService(db);
    const dayView = await business.order(f.user.id, day.id);
    const nightView = await f.orders.myOrder(f.user.id, f.order.id);
    for (const view of [dayView, nightView]) expect(view.support).toMatchObject({ phone: '13800009910', qrcode: '/original-support.png', groupQrcode: '/original-group.png', groupTip: '原校区福利群' });
    await expect(business.order('foreign-user', day.id)).rejects.toThrow();
    await expect(f.orders.myOrder('foreign-user', f.order.id)).rejects.toThrow();
  });

  it('夜宵周期限购按商品主档跨价格身份计件，并发待付占额、取消释放且不串白天订单', async () => {
    const f = await refundFixture();
    await db.product.update({ where: { id: f.catalog.id }, data: { purchaseLimit: 'weekly', purchaseLimitQty: 2 } });
    const submit = () => f.orders.submitOrder(f.user.id, { storeId: f.store.id, addressId: f.address.id, items: [{ productId: f.product.id, quantity: 1 }] });
    const results = await Promise.allSettled([submit(), submit()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find(result => result.status === 'fulfilled');
    if (!winner || winner.status !== 'fulfilled') throw new Error('缺少成功订单');
    await f.orders.cancelByUser(f.user.id, winner.value.id);
    const retried = await submit();
    expect(retried.status).toBe('pending-payment');
    // Deadline alone is not release: the closing transaction must first restore resources.
    await db.nightOrder.update({ where: { id: retried.id }, data: { timeoutAt: new Date(Date.now() - 1000), createdAt: new Date('2020-01-01T00:00:00Z') } });
    await expect(submit()).rejects.toThrow('限购数量');
    await f.orders.applyNightOrderPaid(retried.orderNo);
    await expect(submit()).rejects.toThrow('限购数量');
    expect((await db.nightProduct.findUniqueOrThrow({ where: { id: f.product.id } })).stock).toBe(1);
  });

  it('日夜运营内容在后台创建后按渠道展示，旧内容默认白天且拒绝非法渠道', async () => {
    const f = await fixture();
    const admin = new AdminService(db, new BusinessService(db));
    const business = new BusinessService(db);
    const dayBanner = await admin.createBanner({ title: '白天公告图', color: 'green' }, f.staff.id, f.campus.id);
    const nightBanner = await admin.createBanner({ title: '夜宵公告图', color: 'dark', businessType: 'night' }, f.staff.id, f.campus.id);
    const window = { campusId: f.campus.id, startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString() };
    await admin.createNotice({ ...window, content: '白天店公告' }, f.staff.id, f.campus.id);
    await admin.createNotice({ ...window, businessType: 'night', content: '夜宵店公告' }, f.staff.id, f.campus.id);
    const nightCategory = await db.category.create({ data: { campusId: f.campus.id, name: `夜首页分类-${Date.now()}` } });
    // IKTZ7J 道哥 2026-11-09：首页日夜同构——夜渠道返回真实推荐（夜主档），
    // 日夜互不混入（替代旧「夜渠道恒空」断言）
    const nightMaster = await db.product.create({ data: { campusId: f.campus.id, categoryId: nightCategory.id, name: '夜主档推荐验收', subtitle: '', price: 800, originalPrice: 800, stock: 9, tag: '', image: '', weight: 0, nightCatalog: true } });
    const dayProduct = await db.product.create({ data: { campusId: f.campus.id, categoryId: f.catalog.categoryId, name: '白天首页商品验收', subtitle: '', price: 700, originalPrice: 700, stock: 20, tag: '', image: '', weight: 0 } });
    const [day, night] = await Promise.all([business.home(f.campus.id), business.home(f.campus.id, 'night')]);
    expect(day.notice).toBe('白天店公告'); expect(night.notice).toBe('夜宵店公告');
    expect(night.hotProducts.map(row => row.id)).toContain(nightMaster.id);
    expect(night.hotProducts.map(row => row.id)).not.toContain(dayProduct.id);
    expect(day.hotProducts.map(row => row.id)).toContain(dayProduct.id);
    expect(day.hotProducts.map(row => row.id)).not.toContain(nightMaster.id);
    expect(day.banners.map(row => row.id)).toEqual([dayBanner.id]);
    expect(night.banners.map(row => row.id)).toEqual([nightBanner.id]);
    // IKTZ7J：夜渠道未配 banner 时回落白天 banner（视觉与白天一致）
    await db.banner.update({ where: { id: nightBanner.id }, data: { status: 'inactive' } });
    expect((await business.home(f.campus.id, 'night')).banners.map(row => row.id)).toEqual([dayBanner.id]);
    expect((await admin.banners(f.campus.id, undefined, undefined, 'night')).map(row => row.id)).toEqual([nightBanner.id]);
    await expect(business.home(f.campus.id, 'invalid')).rejects.toThrow('业务类型不正确');
    await expect(admin.updateBanner(nightBanner.id, { title: '越校区' }, f.staff.id, 'foreign-campus')).rejects.toThrow('Banner 不存在');
  });

  it('白天支付只消费本订单商品数量，保留后加商品，旧购物车写入不能复活已购数量', async () => {
    const f = await fixture();
    await db.campus.update({ where: { id: f.campus.id }, data: { manualClosed: false, closeStart: '00:00', closeEnd: '00:00', deliveryThreshold: 0, deliveryFeeInstant: 0 } });
    const user = await db.user.create({ data: { campusId: f.campus.id, nickname: '支付清车边界验收', phone: '13800009901' } });
    const address = await db.address.create({ data: { userId: user.id, campusId: f.campus.id, campusName: f.campus.name, buildingId: f.building.id, buildingName: f.building.name, floor: 1, room: '101', contactName: '测试', phone: user.phone } });
    const laterProduct = await db.product.create({ data: { campusId: f.campus.id, categoryId: f.catalog.categoryId, name: '后加商品', subtitle: '', price: 700, originalPrice: 700, stock: 20, tag: '', image: '', weight: 0 } });
    const business = new BusinessService(db);
    await db.product.update({ where: { id: f.warehouse.id }, data: { purchaseLimit: 'once', purchaseLimitQty: 2 } });
    await expect(business.setCartItem(user.id, f.warehouse.id, 3)).rejects.toThrow('限购');
    await business.setCartItem(user.id, f.warehouse.id, 1);
    const order = await business.createOrder(user.id, f.campus.id, { addressId: address.id, deliveryMode: 'instant' });
    const beforePayment = await business.updateCart(user.id, { items: [{ productId: f.warehouse.id, quantity: 2 }, { productId: laterProduct.id, quantity: 1 }] });
    await business.pay(user.id, order.id);
    expect(await db.notification.findFirst({ where: { userId: user.id, orderId: order.id, businessType: 'day' } })).toMatchObject({ content: '订单已进入校园仓，仓储人员即将开始拣货。' });
    const afterPayment = await business.cart(user.id);
    expect(afterPayment.totalQuantity).toBe(2);
    expect(afterPayment.items.find(line => line.product.id === f.warehouse.id)?.quantity).toBe(1);
    expect(afterPayment.items.find(line => line.product.id === laterProduct.id)?.quantity).toBe(1);
    await expect(business.updateCart(user.id, { expectedVersion: beforePayment.version, items: [{ productId: f.warehouse.id, quantity: 2 }, { productId: laterProduct.id, quantity: 1 }] })).rejects.toThrow('购物车已变化');
    await business.pay(user.id, order.id);
    expect((await business.cart(user.id)).totalQuantity).toBe(2);
    expect((await db.product.findUniqueOrThrow({ where: { id: f.warehouse.id } })).stock).toBe(99);
  });

  it('售后列表按用户隔离、全额申请排除券和配送费，撤销与审核只有一方成功', async () => {
    const f = await refundFixture();
    await f.orders.acceptOrder(f.staff.id, f.store.id, f.order.id);
    await f.orders.deliverOrder(f.staff.id, f.store.id, f.order.id, { images: ['http://localhost:3150/api/v1/uploads/proof.jpg'] });
    const request = { type: 'missing', description: '收货时发现商品缺失，请核查处理。', images: ['http://localhost:3150/api/v1/uploads/after-sale.jpg'] };
    await expect(f.orders.applyAfterSale(f.user.id, f.order.id, { ...request, productIds: ['foreign-product'] })).rejects.toThrow('不属于本订单');
    await f.orders.applyAfterSale(f.user.id, f.order.id, request);
    const records = await f.orders.myAfterSales(f.user.id, '1', '20');
    expect(records.total).toBe(1);
    expect(records.refundedAmount).toBe(0);
    expect(records.items[0].timeline).toEqual(expect.arrayContaining([expect.objectContaining({ requestedAmount: 400 })]));
    expect((await f.orders.myAfterSales('foreign-user')).total).toBe(0);
    const outcomes = await Promise.allSettled([
      f.orders.withdrawAfterSale(f.user.id, f.order.id),
      f.orders.rejectAfterSale('isolated-admin', f.order.id, '审核已核对'),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const final = await f.orders.myOrder(f.user.id, f.order.id);
    expect(['withdrawn', 'rejected']).toContain(final.afterSaleStatus);
    expect(final.refund).toBeNull();
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('明确拒绝退款保留原订单和资源，同一退款号重试成功', async () => {
    const f = await refundFixture();
    f.apply.mockRejectedValueOnce(new HttpException('微信支付未配置', 501));
    const first = await f.orders.cancelByUser(f.user.id, f.order.id, '取消验收');
    expect(first).toMatchObject({ status: 'pending-accept', refund: { status: 'failed' } });
    expect((await f.resources()).coupon.status).toBe('used');
    expect((await f.resources()).product.stock).toBe(2);
    await f.orders.cancelByUser(f.user.id, f.order.id, '再次提交');
    expect(f.apply.mock.calls[0][3]).toBe(f.apply.mock.calls[1][3]);
    expect((await f.orders.myOrder(f.user.id, f.order.id)).status).toBe('cancelled');
    expect((await f.resources()).product.stock).toBe(3);
  });

  it('网络结果未知不伪成功，重复并发申请只调用一次网关并保持原退款号', async () => {
    const f = await refundFixture();
    f.apply.mockRejectedValue(new WechatRefundOutcomeUnknownError());
    f.query.mockResolvedValue({ status: 'PROCESSING', refundId: 'isolated-refund' });
    const results = await Promise.all([f.orders.cancelByUser(f.user.id, f.order.id, '取消'), f.orders.cancelByUser(f.user.id, f.order.id, '取消')]);
    expect(results.every(r => r.status === 'cancelling')).toBe(true);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect((await f.resources()).product.stock).toBe(2);
    f.query.mockResolvedValue({ status: 'SUCCESS', refundId: 'isolated-refund' });
    await f.orders.reconcilePendingRefunds();
    expect((await f.resources()).product.stock).toBe(3);
    expect(await db.nightRefund.count({ where: { orderId: f.order.id } })).toBe(1);
  });

  it('退款查单404不当成拒绝；超过保护期后用原单号恢复未发送/断线请求，仍只回库一次', async () => {
    const f = await refundFixture();
    f.apply.mockRejectedValueOnce(new WechatRefundOutcomeUnknownError());
    f.query.mockResolvedValue({ status: 'NOTFOUND' });
    await f.orders.cancelByUser(f.user.id, f.order.id, '取消');
    await f.orders.reconcilePendingRefunds();
    expect((await f.orders.myOrder(f.user.id, f.order.id)).refund?.status).toBe('unknown');
    expect((await f.resources()).product.stock).toBe(2);
    expect(f.apply).toHaveBeenCalledTimes(1);
    await db.nightRefund.update({ where: { orderId: f.order.id }, data: { createdAt: new Date(Date.now() - 120000), leaseUntil: null } });
    await f.orders.reconcilePendingRefunds();
    expect(f.apply).toHaveBeenCalledTimes(2);
    expect(f.apply.mock.calls[0][3]).toBe(f.apply.mock.calls[1][3]);
    expect((await f.resources()).product.stock).toBe(3);
    expect((await f.orders.myOrder(f.user.id, f.order.id)).refund?.status).toBe('succeeded');
  });

  it('未知退款原单号重发遇到本地配置故障仍保持占用，不冒充已明确拒绝', async () => {
    const f = await refundFixture();
    f.apply.mockRejectedValueOnce(new WechatRefundOutcomeUnknownError());
    f.query.mockResolvedValue({ status: 'NOTFOUND' });
    await f.orders.cancelByUser(f.user.id, f.order.id, '取消');
    await db.nightRefund.update({ where: { orderId: f.order.id }, data: { createdAt: new Date(Date.now() - 120000) } });
    f.apply.mockRejectedValue(new HttpException('微信支付未配置', 501));
    await f.orders.reconcilePendingRefunds();
    expect((await f.orders.myOrder(f.user.id, f.order.id)).status).toBe('cancelling');
    expect((await f.resources()).product.stock).toBe(2);
    expect((await f.resources()).coupon.status).toBe('used');
    f.query.mockResolvedValue({ status: 'SUCCESS', refundId: 'isolated-refund' });
    await f.orders.reconcilePendingRefunds();
  });

  it('送达后退款回库先预留历史货值，退款失败释放预留但不改变已售库存', async () => {
    const f = await refundFixture(1500);
    await f.orders.acceptOrder(f.staff.id, f.store.id, f.order.id);
    await f.orders.deliverOrder(f.staff.id, f.store.id, f.order.id, { images: ['http://localhost:3150/uploads/isolated-proof.jpg'] });
    expect((await f.resources()).quota.usableQuota).toBe(500);
    f.apply.mockResolvedValue({ status: 'PROCESSING', refundId: 'isolated-refund' });
    await f.orders.adminRefund('isolated-admin', f.order.id, { restock: true, reason: '送达退货' });
    expect((await f.resources()).quota).toMatchObject({ usableQuota: 0, refundReservedValue: 500 });
    await expect(f.request(1)).rejects.toThrow('额度');
    f.query.mockResolvedValue({ status: 'CLOSED' });
    await f.orders.reconcilePendingRefunds();
    const r = await f.resources();
    expect(r.quota).toMatchObject({ usableQuota: 500, refundReservedValue: 0 });
    expect(r.product.stock).toBe(2);
    expect((await f.orders.myOrder(f.user.id, f.order.id)).status).toBe('completed');
  });

  it('跨期退款冲佣金进入下期待结算，不改已出账批次；商品全退可保留配送费', async () => {
    const f = await refundFixture();
    await f.orders.acceptOrder(f.staff.id, f.store.id, f.order.id);
    await f.orders.deliverOrder(f.staff.id, f.store.id, f.order.id, { images: ['http://localhost:3150/uploads/isolated-proof.jpg'] });
    const batch = await f.orders.settleBatch(f.campus.id);
    expect(batch.commissionTotal).toBe(80);
    expect(batch.deliveryFeeTotal).toBe(200);
    const result = await f.orders.adminRefund('isolated-admin', f.order.id, { restock: true, reason: '商品退回保留配送费', refundDeliveryFee: false });
    expect(result).toMatchObject({ refundStatus: 'succeeded', refundAmount: 400, fullRefund: false });
    const rows = await db.nightCommissionTxn.findMany({ where: { orderId: f.order.id } });
    expect(rows.filter(r => r.settleBatch === batch.batch).reduce((n, r) => n + r.amount, 0)).toBe(280);
    expect(rows.find(r => r.amount < 0)).toMatchObject({ amount: -80, status: 'pending', settleBatch: null });
    expect((await f.resources()).coupon.status).toBe('released');
    expect((await f.resources()).product.stock).toBe(3);
    const next = await f.orders.settleBatch(f.campus.id);
    expect(next.commissionTotal).toBe(-80);
    expect(next.deliveryFeeTotal).toBe(0);
    expect((await f.orders.myOrder(f.user.id, f.order.id)).statusText).toBe('商品已退款，配送费保留');
  });

  it('部分商品退款不回库且金额不越界，恢复进行中订单并按净基数冲佣金', async () => {
    const f = await refundFixture();
    await expect(f.orders.adminRefund('isolated-admin', f.order.id, { productRefund: 401, restock: false, reason: '越界' })).rejects.toThrow('金额');
    await expect(f.orders.adminRefund('isolated-admin', f.order.id, { productRefund: 100, restock: true, reason: '部分回库' })).rejects.toThrow('不能自动回库');
    expect((await f.orders.adminRefund('isolated-admin', f.order.id, { productRefund: 100, restock: false, reason: '部分赔付' })).refundStatus).toBe('succeeded');
    expect((await f.orders.myOrder(f.user.id, f.order.id)).status).toBe('pending-accept');
    expect((await f.resources()).commission._sum.amount).toBe(260);
    expect((await f.resources()).product.stock).toBe(2);
    await f.orders.acceptOrder(f.staff.id, f.store.id, f.order.id);
  });

  it('退押渠道调用不占数据库锁，保留额度立即阻止备货和判责扣除，确认后仅记一次账', async () => {
    const f = await fixture(50000);
    await db.nightDepositTxn.create({
      data: {
        storeId: f.store.id,
        type: 'deposit',
        amount: 50000,
        payOrderNo: randomUUID(),
      },
    });
    let entered!: () => void, release!: () => void;
    const enteredPayment = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paymentGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const payments = {
      applyWechatRefund: jest.fn().mockImplementation(async () => {
        entered();
        await paymentGate;
        return { refundId: 'test-deposit-refund', status: 'SUCCESS' };
      }),
    } as unknown as PaymentsService;
    const admin = new NightAdminService(db, payments, {} as NightOrderService);
    const refund = admin.refundDeposit('test-admin', f.store.id, {
      requestId: 'deposit-refund-concurrent',
      amount: 50000,
      reason: '退出验收',
    });
    await enteredPayment;
    try {
      expect(await service.summary(f.store.id)).toMatchObject({ deposit: 50000, usedQuota: 50000, depositRefundReservedValue: 50000 });
      await expect(f.request(1)).rejects.toThrow('押金额度不足');
      await expect(admin.deductDeposit('test-admin', f.store.id, { amount: 1, reason: '并发扣除' })).rejects.toThrow('超过押金余额');
    } finally {
      release();
    }
    await refund;
    await admin.refundDeposit('test-admin', f.store.id, { requestId: 'deposit-refund-concurrent', amount: 50000 });
    expect(payments.applyWechatRefund).toHaveBeenCalledTimes(1);
    expect(await service.summary(f.store.id)).toMatchObject({
      deposit: 0,
      usedQuota: 0,
    });
  });

  it('退押PROCESSING保留余额和额度，重复查单成功只落一次退款流水', async () => {
    const f = await fixture(50000);
    await db.nightDepositTxn.create({ data: { storeId: f.store.id, type: 'deposit', amount: 50000, payOrderNo: randomUUID() } });
    const payments = { applyWechatRefund: jest.fn().mockResolvedValue({ status: 'PROCESSING', refundId: 'deposit-processing' }), queryWechatRefund: jest.fn().mockResolvedValue({ status: 'SUCCESS', refundId: 'deposit-processing' }) } as unknown as PaymentsService;
    const admin = new NightAdminService(db, payments, {} as NightOrderService);
    expect(await admin.refundDeposit('test-admin', f.store.id, { requestId: 'deposit-processing', amount: 50000 })).toMatchObject({ refunded: 0, pending: 50000, deposit: 50000 });
    expect(await db.nightDepositTxn.count({ where: { storeId: f.store.id, type: 'refund' } })).toBe(0);
    expect(await service.summary(f.store.id)).toMatchObject({ deposit: 50000, usableQuota: 0 });
    await expect(admin.refundDeposit('test-admin', f.store.id, { requestId: 'deposit-second-request', amount: 1 })).rejects.toThrow('退押处理中');
    await expect(admin.refundDeposit('test-admin', f.store.id, { requestId: 'deposit-processing', amount: 100 })).rejects.toThrow('原申请金额');
    await admin.syncDepositRefund(f.store.id, 'deposit-processing');
    await admin.syncDepositRefund(f.store.id, 'deposit-processing');
    expect(await db.nightDepositTxn.count({ where: { storeId: f.store.id, type: 'refund' } })).toBe(1);
    expect(await service.summary(f.store.id)).toMatchObject({ deposit: 0, usedQuota: 0 });
    expect(await admin.depositRefunds(f.store.id, '1', '1')).toMatchObject({ total: 1, items: [{ refunded: 50000, pending: 0 }] });
  }, 40000);

  it('退押明确失败不记账，同申请重试复用原退款号；缺原缴款和超额请求拒绝', async () => {
    const f = await fixture(50000);
    const payments = { applyWechatRefund: jest.fn().mockRejectedValueOnce(new HttpException('微信支付未配置', 501)).mockResolvedValue({ status: 'SUCCESS', refundId: 'deposit-retry' }) } as unknown as PaymentsService;
    const admin = new NightAdminService(db, payments, {} as NightOrderService);
    await expect(admin.refundDeposit('test-admin', f.store.id, { requestId: 'deposit-invalid', amount: 50001 })).rejects.toThrow('可退押金余额');
    await expect(admin.refundDeposit('test-admin', f.store.id, { requestId: 'deposit-invalid', amount: 50000 })).rejects.toThrow('原缴款');
    await db.nightDepositTxn.create({ data: { storeId: f.store.id, type: 'deposit', amount: 50000, payOrderNo: randomUUID() } });
    expect(await admin.refundDeposit('test-admin', f.store.id, { requestId: 'deposit-failed-retry', amount: 50000 })).toMatchObject({ failed: 50000, deposit: 50000, pending: 0 });
    expect(await service.summary(f.store.id)).toMatchObject({ usableQuota: 50000 });
    expect(await admin.refundDeposit('test-admin', f.store.id, { requestId: 'deposit-failed-retry', amount: 50000 })).toMatchObject({ refunded: 50000, deposit: 0 });
    const mock = payments.applyWechatRefund as jest.Mock;
    expect(mock.mock.calls[0][3]).toBe(mock.mock.calls[1][3]);
    expect(await db.nightDepositTxn.count({ where: { storeId: f.store.id, type: 'refund' } })).toBe(1);
  }, 40000);

  it('退押网络未知及404不释放额度，重放原申请后确认成功；按多笔实缴分配且历史可分页', async () => {
    const f = await fixture(100000);
    for (let i = 0; i < 2; i++) await db.nightDepositTxn.create({ data: { storeId: f.store.id, type: 'deposit', amount: 50000, payOrderNo: randomUUID() } });
    const payments = { applyWechatRefund: jest.fn().mockRejectedValue(new WechatRefundOutcomeUnknownError()), queryWechatRefund: jest.fn().mockResolvedValue({ status: 'NOTFOUND' }) } as unknown as PaymentsService;
    const admin = new NightAdminService(db, payments, {} as NightOrderService);
    expect(await admin.refundDeposit('test-admin', f.store.id, { requestId: 'deposit-unknown-recover', amount: 75000 })).toMatchObject({ pending: 75000, deposit: 100000, allocations: [{ amount: 50000 }, { amount: 25000 }] });
    await admin.syncDepositRefund(f.store.id, 'deposit-unknown-recover');
    expect(await service.summary(f.store.id)).toMatchObject({ depositRefundReservedValue: 75000, usableQuota: 25000 });
    await db.nightDepositRefund.updateMany({ where: { storeId: f.store.id }, data: { createdAt: new Date(Date.now() - 120000), leaseUntil: null } });
    (payments.applyWechatRefund as jest.Mock).mockResolvedValue({ status: 'SUCCESS', refundId: 'deposit-recovered' });
    expect(await admin.syncDepositRefund(f.store.id, 'deposit-unknown-recover')).toMatchObject({ refunded: 75000, pending: 0, deposit: 25000 });
    const mock = payments.applyWechatRefund as jest.Mock;
    // 数据库可按任意顺序返回分配项，每笔原缴款仍须重用自己的渠道退款号。
    for (const original of mock.mock.calls.slice(0, 2)) expect(mock.mock.calls.slice(2).find(call => call[0] === original[0])?.[3]).toBe(original[3]);
    expect(await admin.refundDeposit('test-admin', f.store.id, { requestId: 'deposit-last-quarter', amount: 25000 })).toMatchObject({ refunded: 25000, deposit: 0, allocations: [{ amount: 25000 }] });
    expect(await admin.depositRefunds(f.store.id, '2', '1')).toMatchObject({ total: 2, items: [{ requestId: 'deposit-unknown-recover' }] });
  }, 40000);

  it('店内报损先冻结可售数量且不释放额度，审核通过才确认损耗', async () => {
    const product = (await service.products(staffId))[0];
    const report = await service.createReport(staffId, {
      requestId: 'first-store-loss',
      kind: 'loss',
      reason: '包装破损',
      items: [
        {
          nightProductId: product.id,
          quantity: 3,
          inventoryVersion: product.inventoryVersion,
        },
      ],
    });
    expect((await service.products(staffId))[0]).toMatchObject({
      stock: 15,
      frozenStock: 3,
    });
    expect((await service.summary(storeId)).usedQuota).toBe(9000);
    await service.reviewReport('test-admin', report.id, true, '确认破损');
    expect((await service.products(staffId))[0]).toMatchObject({
      stock: 15,
      frozenStock: 0,
    });
    expect((await service.summary(storeId)).usedQuota).toBe(7500);
  });

  it('官方导入复用白天实物库存；后续总部到货只增加共享实物行，不误加夜宵副本', async () => {
    const store = await db.nightStore.findUniqueOrThrow({
      where: { id: storeId },
    });
    const officialCampus = await db.campus.upsert({
      where: { id: 'campus-official' },
      update: {},
      create: {
        id: 'campus-official',
        name: '官方库',
        shortName: '官方',
        warehouseName: '资料库',
        status: 'official',
      },
    });
    const category = await db.category.create({
      data: { campusId: officialCampus.id, name: `官方验收-${Date.now()}` },
    });
    const official = await db.product.create({
      data: {
        campusId: officialCampus.id,
        catalogScope: 'platform',
        categoryId: category.id,
        name: '官方验收饼干',
        subtitle: '',
        price: 300,
        originalPrice: 500,
        stock: 0,
        tag: '',
        image: '',
        weight: 0,
        barcode: `BC-${Date.now()}`,
      },
    });
    const localCategory = await db.category.findFirstOrThrow({
      where: { campusId: store.campusId },
    });
    const day = await db.product.create({
      data: {
        campusId: store.campusId,
        categoryId: localCategory.id,
        name: '白天饼干',
        subtitle: '',
        price: 450,
        originalPrice: 500,
        stock: 37,
        tag: '',
        image: '',
        weight: 0,
        barcode: official.barcode,
        sourceProductId: official.id,
      },
    });
    const result = await service.importCatalog('test-admin', store.campusId, [
      official.id,
    ]);
    expect(result.importedCount).toBe(1);
    const catalog = await service.catalog(store.campusId);
    expect(
      catalog.find((p) => p.sourceProductId === official.id),
    ).toMatchObject({
      warehouseProductId: day.id,
      warehouseAvailable: 37,
      status: 'off-sale',
    });
    expect(
      (await service.importCatalog('test-admin', store.campusId, [official.id]))
        .importedCount,
    ).toBe(0);
    expect(
      (await service.catalog(store.campusId)).find(
        (p) => p.sourceProductId === official.id,
      )?.warehouseAvailable,
    ).toBe(37);
    const batch = await db.restockBatch.create({
      data: {
        name: '共享仓验收',
        startAt: new Date(),
        endAt: new Date(Date.now() + 3600000),
        createdBy: 'test-admin',
      },
    });
    const restock = await db.restockOrder.create({
      data: {
        batchId: batch.id,
        campusId: store.campusId,
        status: 'shipped',
        items: {
          create: { productId: official.id, cases: 2, unitsPerCase: 6 },
        },
      },
    });
    await db.restockShipment.create({
      data: {
        orderId: restock.id,
        batchId: batch.id,
        campusId: store.campusId,
        shippedBy: 'test-admin',
        items: {
          create: {
            productId: official.id,
            cases: 2,
            unitsPerCase: 6,
            costPerCase: 300,
            wholesalePerCase: 500,
          },
        },
      },
    });
    const admin = new AdminService(db, new BusinessService(db));
    await admin.confirmRestockReceipt(restock.id, 'test-admin', store.campusId);
    expect(
      (await service.catalog(store.campusId)).find(
        (p) => p.sourceProductId === official.id,
      )?.warehouseAvailable,
    ).toBe(49);
    expect(
      (await admin.inventory(store.campusId)).find((p) => p.id === day.id)
        ?.availableStock,
    ).toBe(49);
  });

  it('夜宵导入候选覆盖历史官方行，排除组织行与已导入（IKTVVJ）', async () => {
    const officialCampus = await db.campus.upsert({
      where: { id: 'campus-official' },
      update: {},
      create: {
        id: 'campus-official',
        name: '官方库',
        shortName: '官方',
        warehouseName: '资料库',
        status: 'official',
      },
    });
    const category = await db.category.create({
      data: { campusId: officialCampus.id, name: `官方候选-${Date.now()}` },
    });
    const base = {
      campusId: officialCampus.id,
      categoryId: category.id,
      subtitle: '',
      price: 300,
      originalPrice: 500,
      stock: 0,
      tag: '',
      image: '',
      weight: 0,
    };
    // 历史行：catalogScope 缺省（IKKRMW 字段落地前的存量口径=默认 'campus'）
    const legacy = await db.product.create({
      data: {
        ...base,
        name: `历史候选饼干-${Date.now()}`,
        barcode: `LG-${Date.now()}`,
      },
    });
    // 组织目录行：落同一伪校区，候选必须排除
    await db.product.create({
      data: {
        ...base,
        catalogScope: 'org',
        organizationId: 'org-candidate-check',
        name: `组织行-${Date.now()}`,
        barcode: `ORG-${Date.now()}`,
      },
    });
    const listed = await service.catalogCandidates();
    expect(listed.map((p) => p.name)).toContain(legacy.name);
    expect(listed.some((p) => p.name.startsWith('组织行-'))).toBe(false);
    // IKTWMM：类别服务端真实过滤 + 行带类别名（选择器聚合下拉数据源）
    expect(listed.find((p) => p.id === legacy.id)?.category?.name).toBe(
      category.name,
    );
    // IKTWMM 道哥 2026-11-09：候选行带售价；无 cost.read 剔除成本字段
    expect(
      listed.find((p) => p.id === legacy.id)?.price,
    ).toBe(300);
    const stripped = await service.catalogCandidates(
      undefined,
      undefined,
      undefined,
      false,
    );
    expect(stripped.find((p) => p.id === legacy.id)?.price).toBe(300);
    const strippedRow = stripped.find((p) => p.id === legacy.id);
    expect(strippedRow && 'wholesalePrice' in strippedRow).toBe(false);
    const otherCategory = await db.category.create({
      data: { campusId: officialCampus.id, name: `官方候选乙-${Date.now()}` },
    });
    const other = await db.product.create({
      data: {
        ...base,
        categoryId: otherCategory.id,
        name: `历史候选汽水-${Date.now()}`,
        barcode: `LG2-${Date.now()}`,
      },
    });
    expect(
      (await service.catalogCandidates(undefined, undefined, category.id)).map(
        (p) => p.id,
      ),
    ).toContain(legacy.id);
    expect(
      (
        await service.catalogCandidates(undefined, undefined, category.id)
      ).map((p) => p.id),
    ).not.toContain(other.id);
    // 已导入排除：本校区导入后候选不再出现；不带校区上下文仍可见
    const store = await db.nightStore.findUniqueOrThrow({
      where: { id: storeId },
    });
    await service.importCatalog('test-admin', store.campusId, [legacy.id]);
    expect(
      (await service.catalogCandidates(undefined, store.campusId)).map(
        (p) => p.id,
      ),
    ).not.toContain(legacy.id);
    expect(
      (await service.catalogCandidates()).map((p) => p.id),
    ).toContain(legacy.id);
  });

  it('楼长推荐排序（IKTU033）：楼栋行 featured 优先于主档运营推荐位', async () => {
    const store = await db.nightStore.findUniqueOrThrow({
      where: { id: storeId },
    });
    const cat = await db.category.findFirstOrThrow({
      where: { campusId: store.campusId },
    });
    const mk = (name: string) =>
      db.product.create({
        data: {
          campusId: store.campusId,
          categoryId: cat.id,
          name,
          subtitle: '',
          price: 500,
          originalPrice: 500,
          stock: 0,
          nightCatalog: true,
          tag: '',
          image: '',
          weight: 0,
        },
      });
    const mA = await mk('排序商品甲-主档推荐');
    const mB = await mk('排序商品乙-楼长推荐');
    const rowA = await db.nightProduct.create({
      data: { storeId, catalogProductId: mA.id, onShelf: true },
    });
    const rowB = await db.nightProduct.create({
      data: { storeId, catalogProductId: mB.id, onShelf: true },
    });
    // 主档运营推荐位给甲；楼长只推荐乙 → 乙排前（楼栋行优先于主档位）
    await db.product.update({
      where: { id: mA.id },
      data: { featured: true, featuredSort: 1 },
    });
    const rider = new NightRiderService(db, {} as NightOrderService);
    await rider.setProductFeatured(staffId, rowB.id, true, 1);
    const users = new NightUserService(db, {} as NightOrderService);
    const rows = await users.storeProducts(store.campusId, storeId);
    expect(rows.map((r) => r.id).indexOf(rowB.id)).toBeLessThan(
      rows.map((r) => r.id).indexOf(rowA.id),
    );
    expect(
      rows.find((r) => r.id === rowB.id),
    ).toMatchObject({ featured: true, featuredSort: 1 });
    // 取消推荐 → 回落主档位之后
    await rider.setProductFeatured(staffId, rowB.id, false);
    const rowsAfter = await users.storeProducts(store.campusId, storeId);
    expect(rowsAfter.map((r) => r.id).indexOf(rowA.id)).toBeLessThan(
      rowsAfter.map((r) => r.id).indexOf(rowB.id),
    );
  });
});
