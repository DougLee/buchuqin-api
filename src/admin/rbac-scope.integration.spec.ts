import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../app.module';
import { PrismaService } from '../database/prisma.service';
import { PrinterService } from '../printer/printer.service';
import { RbacService } from './rbac/rbac.service';
import { OFFICIAL_CAMPUS_ID } from '../common/campus';
import { MENU_NODES } from './rbac/registry';

/** Real foreign targets, full campus capabilities: failures must come from data scope, not absent permissions/IDs. */
describe('RBAC valid A/B target isolation (HTTP + PostgreSQL)', () => {
  jest.setTimeout(120_000);
  let app: any, db: PrismaService, rbac: RbacService;
  let auth = '', accountId = '', roleId = '', categoryId = '';
  const prefix = `scope-${Date.now().toString(36)}`;
  const campusA = `${prefix}-a`, campusB = `${prefix}-b`;
  const campuses = [campusA, campusB];
  const fixture: Record<string, Record<string, any>> = {};
  const printer = { accountConfigured: true, printOrderReceipt: jest.fn(), printTest: jest.fn(), addPrinter: jest.fn() };
  const actor = { id: prefix, username: prefix };
  const call = (method: 'get'|'post'|'patch'|'put'|'delete', path: string, body?: object) => {
    const req = request(app.getHttpServer())[method](`/api/v1/admin/${path}`).set('Authorization', auth);
    return body ? req.send(body) : req;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrinterService).useValue(printer).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api/v1');
    await app.init();
    db = app.get(PrismaService); rbac = app.get(RbacService);
    categoryId = (await db.category.create({ data: { name: prefix } })).id;
    for (const campusId of campuses) {
      await db.campus.create({ data: { id: campusId, name: campusId, shortName: campusId, warehouseName: campusId } });
      const user = await db.user.create({ data: { campusId, nickname: campusId, phone: campusId === campusA ? '13900000001' : '13900000002', role: 'user' } });
      const building = await db.building.create({ data: { campusId, name: campusId } });
      const room = await db.room.create({ data: { buildingId: building.id, floor: 1, roomNo: '101', qrToken: campusId } });
      const product = await db.product.create({ data: { campusId, categoryId, name: campusId, barcode: campusId,
        subtitle: '', price: 500, originalPrice: 600, stock: 10, status: 'on-sale', sales: 0, tag: '', image: '', weight: 0.5 } });
      const order = await db.order.create({ data: { campusId, userId: user.id, orderNo: campusId, status: 'paid', statusText: '待接单',
        address: { buildingName: building.name, room: '101' }, deliveryMode: 'instant', items: [], productAmount: 500,
        totalQuantity: 1, deliveryThreshold: 0, deliveryFee: 0, discount: 0, payableAmount: 500, estimatedArrival: '', timeline: [] } });
      await db.afterSale.create({ data: { userId: user.id, orderId: order.id, type: 'refund', description: campusId, images: [], status: 'pending' } });
      await db.inventoryTxn.create({ data: { productId: product.id, type: 'inbound', delta: 1, reason: campusId, operator: prefix } });
      await db.order.update({ where: { id: order.id }, data: { paidAt: new Date() } });
      const device = await db.printer.create({ data: { campusId, name: campusId, sn: campusId, key: 'synthetic-key' } });
      const banner = await db.banner.create({ data: { campusId, title: campusId, subtitle: '', badge: '', color: '' } });
      const coupon = await db.coupon.create({ data: { campusId, name: campusId, amount: 100, threshold: 100, total: 10, status: 'active' } });
      const promotion = await db.promotion.create({ data: { productId: product.id, type: 'seckill', price: 300,
        startsAt: new Date(), endsAt: new Date(Date.now() + 86_400_000) } });
      const recruit = await db.recruitingApplication.create({ data: { campusId, userId: user.id, buildingId: building.id,
        buildingName: building.name, name: campusId, phone: user.phone, idCardNo: '110101199001011234' } });
      const staff = await db.staff.create({ data: { campusId, name: campusId, staffNo: campusId, role: 'fulltime-rider',
        roleText: '骑手', building: campusId, onTimeRate: 100, income: 0 } });
      const bill = await db.bmBill.create({ data: { campusId, staffId: staff.id, period: '2026-09', baseSalary: 100,
        commissionTotal: 0, adjustment: 0, payable: 100, status: 'pending-review' } });
      const location = await db.storageLocation.create({ data: { campusId, name: campusId } });
      const rule = await db.commissionRule.create({ data: { campusId, buildingId: building.id, price: 100, version: 1 } });
      const invitation = await db.dispatchInvitation.create({ data: { staffId: staff.id, buildingId: building.id,
        building: building.name, startAt: new Date(), endAt: new Date(Date.now() + 86_400_000), reward: 0,
        status: 'invited', statusText: '待响应' } });
      fixture[campusId] = { user, building, room, product, order, device, banner, coupon, promotion, recruit, staff, bill, location, rule, invitation };
    }
    const role = await rbac.createRole(actor, { code: prefix, name: '校园能力全集', menuCodes: MENU_NODES.map(n => n.code) });
    roleId = role.id;
    const account = await rbac.createAccount(actor, { username: prefix, password: 'scope-pass-123', grants: [
      { roleCode: role.code, scope: 'campus', campusId: campusA },
      { roleCode: 'campus-finance', scope: 'campus', campusId: campusB },
    ] });
    accountId = account.id;
    await db.adminAccount.update({ where: { id: account.id }, data: { campusId: campusA } });
    const current = await db.adminAccount.findUniqueOrThrow({ where: { id: account.id } });
    auth = `Bearer ${app.get(JwtService).sign({ id: account.id, campusId: campusA, role: 'rbac', sv: current.sessionVersion })}`;
  });

  it('serializes operation-scoped platform grants as an array for browser sessions', async () => {
    const response = await call('get', 'rbac/permmenu').expect(200);
    expect(response.body.data.platformPerms).toEqual([]);
    expect(response.body.data.menus.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    try {
      if (db) {
        const productIds = Object.values(fixture).map(f => f.product.id);
        await db.userCoupon.deleteMany({ where: { coupon: { campusId: { in: campuses } } } });
        await db.coupon.deleteMany({ where: { campusId: { in: campuses } } });
        await db.promotion.deleteMany({ where: { productId: { in: productIds } } });
        await db.inventoryTxn.deleteMany({ where: { productId: { in: productIds } } });
        await db.product.deleteMany({ where: { campusId: { in: campuses } } });
        await db.afterSale.deleteMany({ where: { order: { campusId: { in: campuses } } } });
        await db.lotteryWheel.deleteMany({ where: { campusId: { in: campuses } } });
        await db.order.deleteMany({ where: { campusId: { in: campuses } } });
        await db.printer.deleteMany({ where: { campusId: { in: campuses } } });
        await db.banner.deleteMany({ where: { campusId: { in: campuses } } });
        await db.recruitingApplication.deleteMany({ where: { campusId: { in: campuses } } });
        await db.bmBill.deleteMany({ where: { campusId: { in: campuses } } });
        await db.dispatchInvitation.deleteMany({ where: { staff: { campusId: { in: campuses } } } });
        await db.commissionRule.deleteMany({ where: { campusId: { in: campuses } } });
        await db.storageLocation.deleteMany({ where: { campusId: { in: campuses } } });
        await db.staff.deleteMany({ where: { campusId: { in: campuses } } });
        await db.room.deleteMany({ where: { building: { campusId: { in: campuses } } } });
        await db.building.deleteMany({ where: { campusId: { in: campuses } } });
        await db.user.deleteMany({ where: { campusId: { in: campuses } } });
        await db.adminAccount.deleteMany({ where: { id: accountId } });
        await db.adminRoleMenu.deleteMany({ where: { roleId } });
        await db.adminRole.deleteMany({ where: { id: roleId } });
        await db.auditLog.deleteMany({ where: { OR: [{ campusId: { in: campuses } }, { operator: prefix }] } });
        await db.campus.deleteMany({ where: { id: { in: campuses } } });
        await db.category.deleteMany({ where: { id: categoryId } });
      }
    } finally { await app?.close(); }
  });

  it('list endpoints and new-order watermark ignore foreign campus query and exclude real B records', async () => {
    const a = fixture[campusA], b = fixture[campusB];
    for (const [path, ownId, foreignId] of [
      ['banners', a.banner.id, b.banner.id], ['coupons', a.coupon.id, b.coupon.id],
      ['locations', a.location.id, b.location.id], ['commission-rules', a.rule.id, b.rule.id],
      ['printers', a.device.id, b.device.id], ['promotions', a.promotion.id, b.promotion.id],
    ]) {
      const res = await call('get', `${path}?campus=${campusB}&campusId=${campusB}`).expect(200);
      const serialized = JSON.stringify(res.body.data);
      expect(serialized).toContain(ownId); expect(serialized).not.toContain(foreignId);
    }
    const after = await call('get', `after-sales?campus=${campusB}`).expect(200);
    expect(JSON.stringify(after.body.data)).toContain(a.order.id);
    expect(JSON.stringify(after.body.data)).not.toContain(b.order.id);
    const txns = await call('get', `inventory/txns?campus=${campusB}`).expect(200);
    expect(JSON.stringify(txns.body.data)).toContain(a.product.id);
    expect(JSON.stringify(txns.body.data)).not.toContain(b.product.id);
    const watch = await call('get', `orders/new-order-watch?campus=${campusB}`).expect(200);
    expect(watch.body.data).toMatchObject({ todayPaid: 1, latest: { id: a.order.id } });
  });

  it('delivery configuration and building mutations remain in A despite body/query campus overrides', async () => {
    const b = fixture[campusB];
    const originalB = await db.campus.findUniqueOrThrow({ where: { id: campusB } });
    await call('patch', `delivery-config?campus=${campusB}`, { campusId: campusB,
      deliveryFeeInstant: 321, deliveryFeeScheduled: 123, deliveryThreshold: 999 }).expect(200);
    const config = await call('get', `delivery-config?campus=${campusB}`).expect(200);
    expect(config.body.data.deliveryFeeInstant).toBe(321);
    expect((await db.campus.findUniqueOrThrow({ where: { id: campusB } })).deliveryFeeInstant).toBe(originalB.deliveryFeeInstant);
    await call('patch', `buildings/${b.building.id}`, { name: 'foreign' }).expect(404);
    await call('delete', `buildings/${b.building.id}`).expect(404);
    const created = await call('post', `buildings?campus=${campusB}`, { campusId: campusB,
      name: 'scope owned', floors: 2, hasElevator: false, gender: 'mixed' }).expect(201);
    expect(created.body.data.campusId).toBe(campusA);
    expect((await db.building.findUniqueOrThrow({ where: { id: b.building.id } })).name).toBe(campusB);
  });

  it('wheel rejects a foreign coupon before saving and own config cannot overwrite B', async () => {
    const a = fixture[campusA], b = fixture[campusB];
    const prizes = Array.from({ length: 8 }, () => ({ type: 'none', label: '谢谢参与', weight: 1 }));
    await db.lotteryWheel.create({ data: { campusId: campusB, active: false, prizes: JSON.stringify(prizes) } });
    const invalid = [...prizes];
    invalid[0] = { type: 'coupon', label: 'foreign', weight: 1, couponId: b.coupon.id } as any;
    await call('put', 'wheel', { active: true, prizes: invalid }).expect(400);
    expect(await db.lotteryWheel.findUnique({ where: { campusId: campusA } })).toBeNull();
    const valid = [...prizes];
    valid[0] = { type: 'coupon', label: 'own', weight: 1, couponId: a.coupon.id } as any;
    await call('put', `wheel?campus=${campusB}`, { campusId: campusB, active: true, prizes: valid }).expect(200);
    const result = await call('get', `wheel?campus=${campusB}`).expect(200);
    expect(result.body.data.prizes[0].couponId).toBe(a.coupon.id);
    expect((await db.lotteryWheel.findUniqueOrThrow({ where: { campusId: campusB } })).active).toBe(false);
  });

  it('counts, audit, creation and recruitment transitions preserve campus scope', async () => {
    const a = fixture[campusA], b = fixture[campusB];
    for (const campusId of campuses) await db.auditLog.create({ data: {
      operator: prefix, action: 'scope.probe', entityType: 'probe', entityId: campusId, campusId } });
    const audit = await call('get', `audit-logs?campus=${campusB}`).expect(200);
    expect(JSON.stringify(audit.body.data)).toContain(campusA);
    expect(JSON.stringify(audit.body.data)).not.toContain(campusB);
    expect(audit.body.data.items.every((row: { action: string }) => !row.action.startsWith('rbac.'))).toBe(true);
    const counts = await call('get', `products/status-counts?campus=${campusB}&view=official`).expect(200);
    expect(counts.body.data).toEqual({ 'on-sale': 1 });
    const recruitCounts = await call('get', `recruit-applications/status-counts?campus=${campusB}`).expect(200);
    expect(recruitCounts.body.data).toEqual({ pending: 1 });
    await call('post', `recruit-applications/${b.recruit.id}/transition`).expect(404);
    await call('post', `recruit-applications/${a.recruit.id}/transition`).expect(201);
    expect((await db.recruitingApplication.findUniqueOrThrow({ where: { id: b.recruit.id } })).status).toBe('pending');
    const coupon = await call('post', `coupons?campus=${campusB}`, { name: 'scope owned', amount: 100,
      threshold: 100, campusId: campusB }).expect(201);
    expect(coupon.body.data.campusId).toBe(campusA);
    const location = await call('post', `locations?campus=${campusB}`, { name: 'scope owned', campusId: campusB }).expect(201);
    expect(location.body.data.campusId).toBe(campusA);
    const bound = await call('post', `printers?campus=${campusB}`, { name: 'scope own', sn: prefix, campusId: campusB }).expect(201);
    expect(bound.body.data.campusId).toBe(campusA);
    expect((await db.printer.findUniqueOrThrow({ where: { id: b.device.id } })).sn).toBe(campusB);
  });

  it('merged campus config, notice and delivery-slot routes enforce A/B scope and preserve new fields', async () => {
    const bSlot = await db.deliverySlot.create({ data: { campusId: campusB, label: 'B window', capacity: 10 } });
    const bNotice = await db.notice.create({ data: { campusId: campusB, content: 'B private notice',
      startsAt: new Date(), endsAt: new Date(Date.now() + 86400000) } });
    try {
      const read = await call('get', `campus-config?campus=${campusB}`).expect(200);
      expect(read.body.data.campus.id).toBe(campusA);
      expect(JSON.stringify(read.body.data)).not.toContain(bNotice.content);
      const created = await call('post', 'delivery-slots', { campusId: campusB, label: 'A window', capacity: 12 }).expect(201);
      expect(created.body.data.campusId).toBe(campusA);
      await call('patch', `delivery-slots/${bSlot.id}`, { capacity: 99 }).expect(404);
      await call('delete', `delivery-slots/${bSlot.id}`).expect(404);
      await call('patch', `delivery-slots/${created.body.data.id}`, { available: false }).expect(200);
      await call('delete', `delivery-slots/${created.body.data.id}`).expect(200);
      const notice = await call('post', 'notices', { campusId: campusB, content: 'A notice',
        startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString() }).expect(201);
      expect(notice.body.data.campusId).toBe(campusA);
      await call('patch', `notices/${bNotice.id}`, { content: 'foreign overwrite' }).expect(404);
      await call('delete', `notices/${bNotice.id}`).expect(404);
      await call('patch', `notices/${notice.body.data.id}`, { status: 'disabled' }).expect(200);
      await call('delete', `notices/${notice.body.data.id}`).expect(200);
      await call('patch', 'delivery-config', { deliveryFeeInstant: 321, deliveryFeeScheduled: 123,
        deliveryThreshold: 999, noManagerTip: 'A building pickup' }).expect(200);
      const config = await call('get', 'campus-config').expect(200);
      expect(config.body.data.campus.noManagerTip).toBe('A building pickup');
      expect(config.body.data.campus.servicePhone).toBe('4008002026');
      expect((await db.campus.findUniqueOrThrow({ where: { id: campusB } })).noManagerTip).toBe('');
      expect((await db.deliverySlot.findUniqueOrThrow({ where: { id: bSlot.id } })).capacity).toBe(10);
      expect((await db.notice.findUniqueOrThrow({ where: { id: bNotice.id } })).content).toBe('B private notice');
    } finally {
      await db.notice.deleteMany({ where: { campusId: { in: campuses } } });
      await db.deliverySlot.deleteMany({ where: { campusId: { in: campuses } } });
    }
  });

  it('order IDs and printers: own detail succeeds, foreign detail/status/actions/print reject before external call', async () => {
    const a = fixture[campusA], b = fixture[campusB];
    await call('get', `orders/${a.order.id}`).expect(200);
    await call('get', `orders/${b.order.id}`).expect(404);
    await call('post', `orders/${b.order.id}/status`, { status: 'exception', reason: 'scope-check' }).expect(404);
    await call('post', `orders/${b.order.id}/actions/outbound`).expect(404);
    await call('post', `orders/${b.order.id}/print-receipt`).expect(404);
    await call('post', `printers/${b.device.id}/test-print`).expect(404);
    await call('delete', `printers/${b.device.id}`).expect(404);
    expect(printer.printOrderReceipt).not.toHaveBeenCalled();
    expect(printer.printTest).not.toHaveBeenCalled();
    expect((await db.order.findUniqueOrThrow({ where: { id: b.order.id } })).status).toBe('paid');
    expect(await db.printer.findUnique({ where: { id: b.device.id } })).not.toBeNull();
  });

  it('batch products and featured lists strip B targets; foreign stock and detail writes reject', async () => {
    const a = fixture[campusA], b = fixture[campusB];
    await call('patch', `products/${b.product.id}`, { subtitle: 'foreign' }).expect(404);
    await call('post', 'inventory/stocktake', { productId: b.product.id, countedQty: 99 }).expect(404);
    await call('post', `inventory/adjust?campus=${campusB}`, { productId: b.product.id, delta: 2, reason: 'scope' }).expect(404);
    const batch = await call('post', 'products/batch-status', { ids: [a.product.id, b.product.id], status: 'off-sale' }).expect(201);
    expect(batch.body.data.count).toBe(1);
    await call('put', 'featured', { productIds: [a.product.id, b.product.id] }).expect(200);
    const bAfter = await db.product.findUniqueOrThrow({ where: { id: b.product.id } });
    expect(bAfter).toMatchObject({ status: 'on-sale', stock: 10, subtitle: '', featuredSort: b.product.featuredSort });
    await call('post', 'products/batch-status', { ids: [a.product.id], status: 'on-sale' }).expect(201);
  });

  it('nested rooms and building targets cannot cross campus or mismatch their parent', async () => {
    const a = fixture[campusA], b = fixture[campusB];
    await call('get', `buildings/${a.building.id}/rooms`).expect(200);
    await call('get', `buildings/${b.building.id}/rooms`).expect(404);
    await call('post', `buildings/${b.building.id}/rooms`, { floor: 1, roomNo: '102' }).expect(404);
    await call('delete', `buildings/${a.building.id}/rooms/${b.room.id}`).expect(404);
    await call('get', `battle-map/buildings/${b.building.id}`).expect(404);
    await call('get', `battle-map/rooms/${b.room.id}`).expect(404);
    await call('post', 'wechat-groups', { buildingId: b.building.id, image: 'https://example.test/group.png' }).expect(400);
    expect(await db.room.findUnique({ where: { id: b.room.id } })).not.toBeNull();
  });

  it('coupon issuance checks both coupon ownership and every explicit recipient before issuing any coupon', async () => {
    const a = fixture[campusA], b = fixture[campusB];
    await call('post', `coupons/${b.coupon.id}/issue`, { userIds: [a.user.id] }).expect(404);
    await call('post', `coupons/${a.coupon.id}/issue`, { userIds: [a.user.id, b.user.id] }).expect(400);
    expect(await db.userCoupon.count({ where: { couponId: a.coupon.id } })).toBe(0);
    await call('post', `coupons/${a.coupon.id}/issue`, { userIds: [a.user.id] }).expect(201);
    expect(await db.userCoupon.count({ where: { couponId: a.coupon.id, userId: a.user.id } })).toBe(1);
    expect(await db.userCoupon.count({ where: { userId: b.user.id } })).toBe(0);
    await call('patch', `coupons/${b.coupon.id}`, { name: 'foreign' }).expect(404);
    await call('delete', `coupons/${b.coupon.id}`).expect(404);
  });

  it('banner and promotion ID ownership and nested product ownership', async () => {
    const a = fixture[campusA], b = fixture[campusB];
    await call('patch', `banners/${a.banner.id}`, { title: 'allowed' }).expect(200);
    await call('patch', `banners/${b.banner.id}`, { title: 'foreign', campusId: campusA }).expect(404);
    await call('delete', `banners/${b.banner.id}`).expect(404);
    await call('patch', `promotions/${b.promotion.id}`, { status: 'disabled' }).expect(404);
    await call('post', 'promotions', { productId: b.product.id, type: 'seckill', price: 200,
      startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(400);
    expect((await db.banner.findUniqueOrThrow({ where: { id: b.banner.id } })).title).toBe(campusB);
    expect((await db.promotion.findUniqueOrThrow({ where: { id: b.promotion.id } })).status).toBe('active');
  });

  it('sensitive recruitment/user reads and finance writes reject real B records', async () => {
    const a = fixture[campusA], b = fixture[campusB];
    await call('get', `users/${a.user.id}/phone`).expect(200);
    await call('get', `users/${b.user.id}/phone`).expect(404);
    await call('get', `recruit-applications/${b.recruit.id}/idcard`).expect(404);
    await call('patch', `recruit-applications/${b.recruit.id}`, { staffRemark: 'foreign' }).expect(404);
    await call('post', `recruit-applications/${b.recruit.id}/idcard`, { idCardNo: '110101199001011235' }).expect(404);
    await call('post', `settlements/${b.bill.id}/confirm`).expect(404);
    await call('post', `settlements/${b.bill.id}/pay`).expect(404);
    expect((await db.bmBill.findUniqueOrThrow({ where: { id: b.bill.id } })).status).toBe('pending-review');
    expect((await db.recruitingApplication.findUniqueOrThrow({ where: { id: b.recruit.id } })).staffRemark).toBe('');
  });
  it('locations, commissions and dispatch validate both record ownership and nested staff/building IDs', async () => {
    const a = fixture[campusA], b = fixture[campusB];
    await call('patch', `locations/${b.location.id}`, { name: 'foreign' }).expect(404);
    await call('delete', `locations/${b.location.id}`).expect(404);
    await call('post', 'commission-rules', { buildingId: b.building.id, price: 100 }).expect(400);
    await call('patch', `commission-rules/${b.rule.id}`, { price: 999 }).expect(404);
    await call('post', `dispatch-invitations/${b.invitation.id}/cancel`).expect(404);
    const invitation = { targetStaffId: b.staff.id, buildingId: a.building.id,
      startAt: new Date().toISOString(), endAt: new Date(Date.now() + 86_400_000).toISOString() };
    await call('post', 'dispatch-invitations', invitation).expect(404);
    await db.staff.update({ where: { id: a.staff.id }, data: { role: 'building-manager' } });
    await call('post', 'dispatch-invitations', { ...invitation, targetStaffId: a.staff.id, buildingId: b.building.id }).expect(400);
    await call('post', 'dispatch-invitations', { ...invitation, targetStaffId: a.staff.id }).expect(201);
    expect((await db.storageLocation.findUniqueOrThrow({ where: { id: b.location.id } })).name).toBe(campusB);
    expect((await db.commissionRule.findUniqueOrThrow({ where: { id: b.rule.id } })).price).toBe(100);
    expect((await db.dispatchInvitation.findUniqueOrThrow({ where: { id: b.invitation.id } })).status).toBe('invited');
    await call('get', `buildings/${b.building.id}/rooms/template`).expect(404);
    await call('get', `buildings/${a.building.id}/rooms/template`).expect(200);
  });

  it('shared category names remain global but product counts stay in the current campus', async () => {
    const response = await call('get', 'categories').expect(200);
    expect(response.body.data.find((c: { id: string }) => c.id === categoryId).productCount).toBe(1);
  });

  it('restock details/receipt reject foreign records and batch aggregates do not leak global purchasing', async () => {
    const official = await db.product.create({ data: { campusId: OFFICIAL_CAMPUS_ID, categoryId,
      name: prefix, barcode: `${prefix}-official`, subtitle: '', price: 500, originalPrice: 600,
      stock: 100, status: 'on-sale', sales: 0, tag: '', image: '', weight: 0.5, unitsPerCase: 2 } });
    const batch = await db.restockBatch.create({ data: { name: prefix, createdBy: accountId,
      startAt: new Date(Date.now() - 60_000), endAt: new Date(Date.now() + 86_400_000) } });
    try {
      const po = await db.purchaseOrder.create({ data: { batchId: batch.id, supplierName: prefix, createdBy: accountId,
        items: { create: { productId: official.id, requiredCases: 10, receivedCases: 10, unitCost: 123, unitsPerCase: 2 } } } });
      const orders = [];
      for (const campusId of [campusA, campusB]) {
        orders.push(await db.restockOrder.create({ data: { batchId: batch.id, campusId, status: 'shipped',
          items: { create: { productId: official.id, cases: 1, unitsPerCase: 2 } },
          shipment: { create: { batchId: batch.id, campusId, shippedBy: accountId,
            items: { create: { productId: official.id, cases: 1, unitsPerCase: 2, costPerCase: 246, wholesalePerCase: 1000 } } } } } }));
      }
      const [a, b] = orders;
      const detail = await call('get', `restock/batches/${batch.id}?campus=${campusB}`).expect(200);
      expect(detail.body.data.orders.map((o: { id: string }) => o.id)).toEqual([a.id]);
      expect(detail.body.data).not.toHaveProperty('purchaseReceivedTotal');
      expect(detail.body.data).not.toHaveProperty('grossEstimate');
      const list = await call('get', `restock/orders?batchId=${batch.id}`).expect(200);
      expect(list.body.data.map((o: { id: string }) => o.id)).toEqual([a.id]);
      await call('get', `restock/orders/${a.id}`).expect(200);
      await call('get', `restock/orders/${a.id}/shipment`).expect(200);
      await call('get', `restock/orders/${b.id}`).expect(403);
      await call('get', `restock/orders/${b.id}/shipment`).expect(403);
      await call('post', `restock/orders/${b.id}/receipt?campus=${campusB}`, { campusId: campusB }).expect(403);
      await call('post', `restock/orders/${b.id}/audit`, { action: 'confirm' }).expect(403);
      await call('post', `restock/orders/${b.id}/ship`, {}).expect(403);
      await call('get', `purchase/orders/${po.id}`).expect(403);
      // A real B product is not a valid official ordering target, even in an otherwise valid draft.
      await db.restockOrder.update({ where: { id: a.id }, data: { status: 'draft' } });
      await call('put', `restock/batches/${batch.id}/order`, {
        campusId: campusB, items: [{ productId: fixture[campusB].product.id, cases: 3 }],
      }).expect(400);
      expect((await db.restockOrderItem.findMany({ where: { orderId: a.id } })).map(i => i.productId)).toEqual([official.id]);
      await db.restockOrder.update({ where: { id: a.id }, data: { status: 'shipped' } });
      await call('post', `restock/orders/${a.id}/receipt`).expect(201);
      expect((await db.product.findFirstOrThrow({ where: { campusId: campusA, sourceProductId: official.id } })).stock).toBe(2);
      expect(await db.product.count({ where: { campusId: campusB, sourceProductId: official.id } })).toBe(0);
      expect((await db.restockOrder.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('shipped');
      expect((await db.restockShipment.findUniqueOrThrow({ where: { orderId: b.id } })).receivedAt).toBeNull();
    } finally {
      await db.restockOrder.deleteMany({ where: { batchId: batch.id } });
      await db.purchaseOrder.deleteMany({ where: { batchId: batch.id } });
      await db.restockBatch.delete({ where: { id: batch.id } });
      await db.inventoryTxn.deleteMany({ where: { product: { sourceProductId: official.id } } });
      await db.product.deleteMany({ where: { sourceProductId: official.id } });
      await db.product.delete({ where: { id: official.id } });
    }
  });

  it('two independent RBAC caches observe role removal/disable; state read failure or missing state never uses stale allow', async () => {
    const second = new RbacService(db);
    const account = await db.adminAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(second.allow(await second.getEffective(account), 'GET', '/admin/products')).toBe(true);
    const original = MENU_NODES.map(n => n.code);
    try {
      await rbac.updateRole(actor, roleId, { menuCodes: [] });
      expect(second.allow(await second.getEffective(account), 'GET', '/admin/products')).toBe(false);
      await call('get', 'products').expect(403);
      await rbac.updateRole(actor, roleId, { menuCodes: original });
      expect(second.allow(await second.getEffective(account), 'GET', '/admin/products')).toBe(true);
      await rbac.updateRole(actor, roleId, { status: 'disabled' });
      expect(second.allow(await second.getEffective(account), 'GET', '/admin/products')).toBe(false);
    } finally {
      await rbac.updateRole(actor, roleId, { menuCodes: original, status: 'active' });
    }
    // Warm both caches before injecting failures, so successful fallback would expose the bug.
    await second.getEffective(account);
    await call('get', 'products').expect(200);
    const readFailure = jest.spyOn(db.rbacState, 'findUnique').mockRejectedValueOnce(new Error('state unavailable'));
    try { await expect(second.getEffective(account)).rejects.toThrow('state unavailable'); }
    finally { readFailure.mockRestore(); }
    const missing = jest.spyOn(db.rbacState, 'findUnique').mockResolvedValueOnce(null);
    try { await call('get', 'products').expect(503); }
    finally { missing.mockRestore(); }
    await call('get', 'products').expect(200);
  });

  it('new campus stays outside explicit A/B grants; an explicit platform grant includes it without reassigning', async () => {
    // Warm the platform target-campus catalogue before insertion to catch stale membership caches.
    await rbac.knownCampusIds();
    const campusC = `${prefix}-c`;
    await db.campus.create({ data: { id: campusC, name: campusC, shortName: campusC, warehouseName: campusC } });
    campuses.push(campusC);
    const list = await request(app.getHttpServer()).get('/api/v1/auth/admin/campuses').set('Authorization', auth).expect(200);
    expect(list.body.data.map((c: { id: string }) => c.id).sort()).toEqual([campusA, campusB].sort());
    const filter = await request(app.getHttpServer()).get('/api/v1/auth/admin/campuses?purpose=filter').set('Authorization', auth).expect(200);
    expect(filter.body.data.map((c: { id: string }) => c.id).sort()).toEqual([campusA, campusB].sort());
    await request(app.getHttpServer()).post('/api/v1/auth/admin/campuses/select').set('Authorization', auth)
      .send({ campusId: campusC }).expect(403);
    const scoped = await call('get', `campuses?campus=${campusC}`).expect(200);
    expect(scoped.body.data.map((c: { id: string }) => c.id)).toEqual([campusA]);
    await rbac.setAccountRoles(actor, accountId, [{ roleCode: prefix, scope: 'platform' }]);
    const current = await db.adminAccount.findUniqueOrThrow({ where: { id: accountId } });
    auth = `Bearer ${app.get(JwtService).sign({ id: accountId, campusId: campusA, role: 'rbac', sv: current.sessionVersion })}`;
    const all = await call('get', 'campuses').expect(200);
    expect(all.body.data.map((c: { id: string }) => c.id)).toContain(campusC);
    await call('get', `users?campus=${campusC}`).expect(200);
    await call('get', 'reports/hq-daily').expect(200);
    const platformFilter = await request(app.getHttpServer()).get('/api/v1/auth/admin/campuses?purpose=filter').set('Authorization', auth).expect(200);
    expect(platformFilter.body.data.map((c: { id: string }) => c.id)).toContain(campusC);
    expect(Object.keys(platformFilter.body.data[0]).sort()).toEqual(['current', 'id', 'name', 'shortName']);
  });

});
