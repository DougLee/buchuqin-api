// One-time TEST acceptance. Run only inside the named test API container.
// Seeds dedicated metadata; stock, liability and operating actions use real HTTP APIs.
// Payments are explicitly simulated through the existing domain callback, never WeChat.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire('/app/package.json');
const url = new URL(process.env.DATABASE_URL || '');
assert.equal(process.env.NIGHT_ISSUES_ACCEPTANCE, '20261117');
assert.equal(url.hostname, '1Panel-postgresql-rbaV');
assert.equal(url.pathname, '/buchuqinshishe');
assert.equal(url.searchParams.get('schema'), 'public');
const { PrismaService } = require('/app/dist/src/database/prisma.service.js');
const { NightOrderService } = require('/app/dist/src/night/night-order.service.js');
const { BusinessService } = require('/app/dist/src/business/business.service.js');
const { RbacService } = require('/app/dist/src/admin/rbac/rbac.service.js');
const { hash } = require('bcryptjs');
const db = new PrismaService(), prefix = 'issues134-20261117';
const sessionFile = '/tmp/issues134-test-session.json', evidenceFile = '/tmp/issues134-test-evidence.json';
const evidence = { environment: 'admin-test.buchuqin.com', payments: 'domain-simulated-no-WeChat', checks: [], assertions: [] };
let session;
function token(id, campusId, role, extra = {}) {
  const enc = x => Buffer.from(JSON.stringify(x)).toString('base64url'), now = Math.floor(Date.now() / 1000);
  const text = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ id, campusId, role, iat: now, exp: now + 86400, ...extra })}`;
  return `${text}.${createHmac('sha256', process.env.JWT_SECRET).update(text).digest('base64url')}`;
}
const save = () => fs.writeFileSync(sessionFile, JSON.stringify(session), { mode: 0o600 });
async function call(route, method = 'GET', body, auth = session.adminToken, status = method === 'POST' ? 201 : 200) {
  assert.ok(route.startsWith('/'));
  const target = new URL('/api/v1' + route, 'http://127.0.0.1:3000');
  assert.equal(target.origin, 'http://127.0.0.1:3000');
  const response = await fetch(target, { method, redirect: 'manual', headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  evidence.checks.push({ route, method, status: response.status, expected: status, message: result.message || '' });
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  assert.equal(response.status, status, `${method} ${route}: ${result.message}`);
  return result.data;
}
function proved(name) { evidence.assertions.push(name); }
try {
  assert.equal(await db.organization.count({ where: { id: prefix } }), 0, 'Refuse to recreate an existing acceptance organization');
  const org = await db.organization.create({ data: { id: prefix, name: '夜宵134–143验收20261117', capabilities: [] } });
  const campus = await db.campus.create({ data: { id: prefix + '-campus', organizationId: org.id, name: '夜宵134–143验收校区', shortName: '夜宵验收', warehouseName: '验收仓', nightEnabled: true, nightStartAt: '00:00', nightEndAt: '23:59', nightDeliveryFee: 200, deliveryFeeInstant: 200, manualClosed: false, afterSalesGroupQrcode: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="%23c9dfbe"/><text x="30" y="160">售后群验收示意</text></svg>' } });
  const otherCampus = await db.campus.create({ data: { id: prefix + '-other', organizationId: org.id, name: '夜宵权限对照校区', shortName: '权限对照', warehouseName: '验收仓' } });
  const building = await db.building.create({ data: { campusId: campus.id, name: '验收9栋' } });
  const otherBuilding = await db.building.create({ data: { campusId: campus.id, name: '对照10栋' } });
  await db.room.create({ data: { buildingId: building.id, floor: 1, roomNo: '101', qrToken: prefix + '-room' } });
  const staff = await db.staff.create({ data: { campusId: campus.id, name: '夜宵验收楼长', staffNo: prefix, role: 'building-manager', roleText: '楼长', buildingId: building.id, building: building.name, onTimeRate: 100, income: 0 } });
  const store = await db.nightStore.create({ data: { campusId: campus.id, buildingId: building.id, managerStaffId: staff.id, commissionRate: 2000 } });
  const user = await db.user.create({ data: { campusId: campus.id, nickname: '夜宵验收用户', phone: '13800001992' } });
  const address = await db.address.create({ data: { userId: user.id, campusId: campus.id, campusName: campus.name, buildingId: building.id, buildingName: building.name, floor: 1, room: '101', phone: user.phone, contactName: '验收用户', isDefault: true } });
  const category = await db.category.create({ data: { campusId: campus.id, name: '验收饮料' } });
  const art = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" rx="32" fill="#d4e6c5"/><text x="55" y="160" font-size="32">夜宵验收饮料</text></svg>');
  const warehouse = await db.product.create({ data: { campusId: campus.id, categoryId: category.id, name: '夜宵验收饮料', subtitle: '独立验收商品', image: art, price: 600, originalPrice: 800, stock: 100, tag: '', weight: 0, procurementMode: 'HQ', wholesalePrice: 250 } });
  const catalog = await db.product.create({ data: { campusId: campus.id, categoryId: category.id, name: warehouse.name, subtitle: warehouse.subtitle, image: art, price: 600, originalPrice: 800, stock: 0, tag: '', weight: 0, nightCatalog: true, warehouseProductId: warehouse.id } });
  await new RbacService(db).syncRegistry();
  const superRole = await db.adminRole.findUniqueOrThrow({ where: { code: 'super-admin' } });
  const readRole = await db.adminRole.create({ data: { code: prefix, name: '夜宵验收仅查订单', seeded: true, menusMigrated: true } });
  const menu = await db.adminMenu.findUniqueOrThrow({ where: { code: 'night-orders' } });
  await db.adminRoleMenu.create({ data: { roleId: readRole.id, menuId: menu.id } });
  const accounts = [];
  for (const [suffix, c, role, orgLevel] of [['admin', campus.id, superRole.id, 'platform'], ['reader', campus.id, readRole.id, 'campus'], ['foreign', otherCampus.id, readRole.id, 'campus']]) {
    const account = await db.adminAccount.create({ data: { username: `${prefix}-${suffix}`, nickname: '夜宵功能验收', passwordHash: await hash(randomBytes(24).toString('hex'), 10), role: orgLevel === 'platform' ? 'hq' : 'admin', orgLevel, campusId: c, rbacMigrated: true } });
    await db.adminAccountRole.create({ data: { accountId: account.id, roleId: role, scope: orgLevel === 'platform' ? 'platform' : 'campus', ...(orgLevel === 'platform' ? {} : { campusId: c }), grantedBy: prefix } });
    accounts.push(account);
  }
  session = { origin: 'https://admin-test.buchuqin.com', organizationId: org.id, campusId: campus.id, otherCampusId: otherCampus.id, buildingId: building.id, storeId: store.id, staffId: staff.id, userId: user.id, addressId: address.id, catalogId: catalog.id, warehouseId: warehouse.id, adminToken: token(accounts[0].id, campus.id, 'hq', { sv: accounts[0].sessionVersion, appKind: 'admin' }), adminUser: { id: accounts[0].id, campusId: campus.id, role: 'hq', nickname: accounts[0].nickname }, readerToken: token(accounts[1].id, campus.id, 'admin', { sv: accounts[1].sessionVersion, appKind: 'admin' }), foreignToken: token(accounts[2].id, otherCampus.id, 'admin', { sv: accounts[2].sessionVersion, appKind: 'admin' }), staffToken: token(staff.id, campus.id, staff.role, { appKind: 'delivery' }), userToken: token(user.id, campus.id, 'user', { appKind: 'user' }) };
  save();
  const orders = new NightOrderService(db, { registerNightPaymentHandler() {} }), business = new BusinessService(db);
  const payment = await db.nightDepositOrder.create({ data: { storeId: store.id, outTradeNo: 'ND-' + prefix, amount: 50000, targetTier: 50000 } });
  await orders.applyNightDepositPaid(payment.outTradeNo, 'SIMULATED-TEST-ONLY');
  async function stock(quantity, receive = true) {
    const row = await call('/night-rider/night/stock/orders', 'POST', { requestId: randomUUID(), items: [{ catalogProductId: catalog.id, quantity }] }, session.staffToken);
    await call(`/admin/night/stock-orders/${row.id}/review`, 'POST', { approved: true, reason: '独立验收审核' });
    await call(`/admin/night/stock-orders/${row.id}/ship`, 'POST');
    if (receive) await call(`/night-rider/night/stock/orders/${row.id}/receive`, 'POST', { items: [{ catalogProductId: catalog.id, quantity }] }, session.staffToken);
    return row;
  }
  await stock(10);
  const picking = await stock(2, false); session.pickingId = picking.id; save();
  await call('/cart', 'PUT', { items: [{ productId: warehouse.id, quantity: 2 }] }, session.userToken);
  const day = await call('/orders', 'POST', { addressId: address.id, deliveryMode: 'instant' }, session.userToken);
  await business.pay(user.id, day.id); session.dayOrderId = day.id; save();
  await call('/night-rider/night/store/open', 'POST', {}, session.staffToken);
  const product = (await call('/night-rider/night/products', 'GET', undefined, session.staffToken))[0];
  const night = await call('/night/orders', 'POST', { storeId: store.id, addressId: address.id, items: [{ productId: product.id, quantity: 2 }] }, session.userToken);
  await orders.applyNightOrderPaid(night.orderNo, 'SIMULATED-TEST-ONLY'); session.nightOrderId = night.id; save();
  const detail = await call(`/admin/night/orders/${night.id}`);
  assert.equal(detail.profit.cost, 500); assert.equal(detail.profit.campusGrossProfit, 460);
  const plain = await call(`/admin/night/orders/${night.id}`, 'GET', undefined, session.readerToken);
  assert.equal('profit' in plain, false); assert.equal('unitGrossCost' in plain.items[0], false);
  await call(`/admin/night/orders/${night.id}`, 'GET', undefined, session.foreignToken, 403);
  proved('138 cost snapshot, margin, cost permission and campus isolation');
  const own = await call(`/night/orders/${night.id}`, 'GET', undefined, session.userToken);
  assert.equal(own.support.groupQrcode, campus.afterSalesGroupQrcode); assert.equal(own.items[0].image, art); assert.equal(own.items[0].quantity, 2);
  proved('135 image/quantity snapshots; 136 order-campus support group');
  const combined = await call('/orders?unified=true', 'GET', undefined, session.userToken);
  assert.deepEqual(new Set(combined.items.map(row => row.businessType)), new Set(['day', 'night']));
  const onlyNight = await call('/orders?unified=true&businessType=night', 'GET', undefined, session.userToken);
  assert.equal(onlyNight.items.length, 1); assert.equal(onlyNight.items[0].id, night.id);
  proved('141 combined user orders and channel filter');
  const currentProduct = (await call('/night-rider/night/products', 'GET', undefined, session.staffToken)).find(row => row.id === product.id);
  const report = await call('/night-rider/night/inventory/reports', 'POST', { requestId: randomUUID(), kind: 'loss', reason: '独立验收责任扣款', photos: [], items: [{ nightProductId: product.id, quantity: 1, inventoryVersion: currentProduct.inventoryVersion }] }, session.staffToken);
  const decision = { approved: true, reason: '楼长承担一元', responsibility: 'manager', compensationAmount: 100 };
  await call(`/admin/night/inventory-reports/${report.id}/review`, 'POST', decision);
  await call(`/admin/night/inventory-reports/${report.id}/review`, 'POST', decision);
  assert.equal((await db.nightStore.findUniqueOrThrow({ where: { id: store.id } })).deposit, 49900);
  assert.equal(await db.nightDepositTxn.count({ where: { storeId: store.id, type: 'deduct' } }), 1);
  proved('137 partial liability review and duplicate request deduct exactly once');
  await call('/night-rider/night/store/close', 'POST', {}, session.staffToken);
  await call('/admin/night/config', 'PUT', { campusId: campus.id, nightEnabled: true, nightStartAt: '02:00', nightEndAt: '02:01', nightDeliveryFee: 200, confirm: true });
  await call('/night-rider/night/store/open', 'POST', {}, session.staffToken, 400);
  const grant = await call('/night-rider/night/opening-requests', 'POST', { requestId: randomUUID(), startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 15000).toISOString(), reason: '本楼活动临时营业验收' }, session.staffToken);
  await call(`/admin/night/opening-requests/${grant.id}/review`, 'POST', { approved: true, reason: '同意本楼临时营业' });
  await call('/night-rider/night/store/open', 'POST', {}, session.staffToken);
  assert.equal((await call(`/night/entry?buildingId=${building.id}`, 'GET', undefined, session.userToken)).inNightSession, true);
  assert.equal((await call(`/night/entry?buildingId=${otherBuilding.id}`, 'GET', undefined, session.userToken)).inNightSession, false);
  await call('/cart', 'PUT', { items: [{ productId: warehouse.id, quantity: 2 }] }, session.userToken);
  await call('/orders', 'POST', { addressId: address.id, deliveryMode: 'instant' }, session.userToken, 400);
  assert.match(evidence.checks.at(-1).message, /本楼夜宵店营业中/);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, new Date(grant.endAt).getTime() - Date.now() + 500)));
  assert.equal((await call(`/night/entry?buildingId=${building.id}`, 'GET', undefined, session.userToken)).inNightSession, false);
  await call('/night/orders', 'POST', { storeId: store.id, addressId: address.id, items: [{ productId: product.id, quantity: 1 }] }, session.userToken, 400);
  proved('139 approval while day store open, building isolation, real-time expiry');
  await call('/admin/night/config', 'PUT', { campusId: campus.id, nightEnabled: false, nightStartAt: '02:00', nightEndAt: '02:01', nightDeliveryFee: 200 });
  const ctx = await call('/fulfillment/business-context', 'GET', undefined, session.staffToken);
  assert.equal(ctx.canSwitchWorkspace, false); assert.equal(ctx.hasNightHistory, true);
  for (const route of ['/night-rider/night/dashboard', '/night-rider/night/stock/pool', '/night-rider/night/products', '/night-rider/night/deposit/tiers']) await call(route, 'GET', undefined, session.staffToken, 403);
  await call('/night-rider/night/stock/orders', 'POST', { requestId: randomUUID(), items: [{ catalogProductId: catalog.id, quantity: 1 }] }, session.staffToken, 403);
  await call('/night-rider/night/deposit', 'GET', undefined, session.staffToken);
  await call('/night-rider/night/orders', 'GET', undefined, session.staffToken);
  await call(`/night-rider/night/stock/orders/${picking.id}/receive`, 'POST', { items: [{ catalogProductId: catalog.id, quantity: 2 }] }, session.staffToken);
  await call(`/night-rider/night/orders/${night.id}/accept`, 'POST', {}, session.staffToken);
  await call(`/night-rider/night/orders/${night.id}/deliver`, 'POST', { images: ['https://admin-test.buchuqin.com/acceptance-proof-placeholder.jpg'], remark: '验收旧订单流程，非真实配送' }, session.staffToken);
  proved('143 disabled operating gates, old receipt/delivery/deposit access');
  await call('/admin/night/config', 'PUT', { campusId: campus.id, nightEnabled: true, nightStartAt: '00:00', nightEndAt: '23:59', nightDeliveryFee: 200, confirm: true });
  await call('/night-rider/night/store/open', 'POST', {}, session.staffToken);
  proved('acceptance campus restored to usable preview state');
  evidence.result = 'passed';
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ result: 'passed', httpChecks: evidence.checks.length, assertions: evidence.assertions, campusId: campus.id }));
} catch (error) {
  evidence.result = 'failed'; evidence.error = error.message;
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.error(error.message); process.exitCode = 1;
} finally { await db.$disconnect(); }
