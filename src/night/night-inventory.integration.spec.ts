import { PrismaService } from '../database/prisma.service';
import { NightInventoryService } from './night-inventory.service';
import { NightOrderService } from './night-order.service';
import { PaymentsService } from '../payments/payments.service';
import { NightAdminService } from './night-admin.service';
import { AdminService } from '../admin/admin.service';
import { BusinessService } from '../business/business.service';
import { randomUUID } from 'node:crypto';

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
    const campus = await db.campus.create({
      data: {
        name: '库存边界验收',
        shortName: '验收',
        warehouseName: '验收仓',
        manualClosed: true,
        nightEnabled: true,
        nightStartAt: '00:00',
        nightEndAt: '23:59',
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
    await expect(
      orders.adminRefund('test-admin', b.id, { restock: true, reason: '重试' }),
    ).rejects.toThrow('不可退款');
    expect((await service.products(f.staff.id))[0]).toMatchObject({
      stock: 2,
      inventoryValue: 1000,
    });
    expect((await service.summary(f.store.id)).usedQuota).toBe(1000);
  });

  it('退押调用期间同店备货等待锁，退款落账后不允许占用已退额度', async () => {
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
      amount: 50000,
      reason: '退出验收',
    });
    await enteredPayment;
    let completed = false;
    const stock = f.request(1).then(
      (value) => {
        completed = true;
        return value;
      },
      (error) => {
        completed = true;
        throw error;
      },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(completed).toBe(false);
    } finally {
      release();
    }
    await refund;
    await expect(stock).rejects.toThrow('押金额度不足');
    expect(await service.summary(f.store.id)).toMatchObject({
      deposit: 0,
      usedQuota: 0,
    });
  });

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
    const batch = await db.restockBatch.create({ data: { name: '共享仓验收', startAt: new Date(), endAt: new Date(Date.now() + 3600000), createdBy: 'test-admin' } });
    const restock = await db.restockOrder.create({ data: { batchId: batch.id, campusId: store.campusId, status: 'shipped', items: { create: { productId: official.id, cases: 2, unitsPerCase: 6 } } } });
    await db.restockShipment.create({ data: { orderId: restock.id, batchId: batch.id, campusId: store.campusId, shippedBy: 'test-admin', items: { create: { productId: official.id, cases: 2, unitsPerCase: 6, costPerCase: 300, wholesalePerCase: 500 } } } });
    const admin = new AdminService(db, new BusinessService(db));
    await admin.confirmRestockReceipt(restock.id, 'test-admin', store.campusId);
    expect((await service.catalog(store.campusId)).find(p => p.sourceProductId === official.id)?.warehouseAvailable).toBe(49);
    expect((await admin.inventory(store.campusId)).find(p => p.id === day.id)?.availableStock).toBe(49);
  });
});
