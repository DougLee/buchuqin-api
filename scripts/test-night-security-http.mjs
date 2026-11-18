import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const line = fs.readFileSync('.env', 'utf8').split(/\r?\n/).find(x => x.startsWith('DATABASE_URL='));
const database = new URL(line?.slice(13).replace(/^['"]|['"]$/g, '') || '');
if (!database.pathname.endsWith('_spec')) throw new Error('HTTP验收只允许独立测试库');
database.searchParams.set('schema', 'night_stock_preview_20261106');
process.env.DATABASE_URL = database.toString(); process.env.NODE_ENV = 'test';
await import('./night-preview-network-guard.mjs');
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client'), { JwtService } = require('@nestjs/jwt');
const { NightInventoryService } = require('../dist/src/night/night-inventory.service.js');
const { NightOrderService } = require('../dist/src/night/night-order.service.js');
const { RbacService } = require('../dist/src/admin/rbac/rbac.service.js');
const db = new PrismaClient({ transactionOptions: { timeout: 20000 } });
const jwt = new JwtService({ secret: fs.readFileSync('/tmp/night-stock-preview-secret', 'utf8') });
const preview = JSON.parse(fs.readFileSync('/tmp/night-stock-preview.json', 'utf8'));
assert.equal(preview.campusId, 'night-preview-campus');
const token = (id, campusId, role = 'user', appKind = 'user', sv = 0) => jwt.sign({ id, campusId, role, appKind, sv }, { expiresIn: '1d' });
const inventory = new NightInventoryService(db);
// Only the external gateway is faked. Fixture stock/order/commission actions use real services.
const orders = new NightOrderService(db, { registerNightPaymentHandler() {}, applyWechatRefund: async () => ({ status: 'SUCCESS', refundId: 'LOCAL_SECURITY_FIXTURE' }) });
const checks = [];
async function check(name, path, auth, expected, method = 'GET', body) {
  const response = await fetch('http://localhost:3150/api/v1' + path, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
  const result = await response.json();
  assert.equal(response.status, expected, `${name}: ${result.message}`);
  checks.push({ name, status: response.status });
  return result.data;
}
async function adminSession(id, codes) {
  const account = await db.adminAccount.upsert({ where: { id }, update: { campusId: preview.campusId, orgLevel: 'campus', rbacMigrated: true }, create: { id, username: id, nickname: '夜宵HTTP权限验收', passwordHash: randomBytes(32).toString('hex'), role: 'campus', campusId: preview.campusId, orgLevel: 'campus', rbacMigrated: true } });
  const role = await db.adminRole.upsert({ where: { code: id }, update: {}, create: { code: id, name: id, menusMigrated: true } });
  for (const code of codes) {
    const menu = await db.adminMenu.findUniqueOrThrow({ where: { code } });
    if (!await db.adminRoleMenu.count({ where: { roleId: role.id, menuId: menu.id } })) await db.adminRoleMenu.create({ data: { roleId: role.id, menuId: menu.id } });
  }
  if (!await db.adminAccountRole.count({ where: { accountId: id, roleId: role.id, scope: 'campus', campusId: preview.campusId } })) await db.adminAccountRole.create({ data: { accountId: id, roleId: role.id, scope: 'campus', campusId: preview.campusId, grantedBy: 'isolated-http-test' } });
  return token(id, preview.campusId, 'campus', 'admin', account.sessionVersion);
}
try {
  const campusId = 'night-security-campus', buildingId = 'night-security-building', staffId = 'night-security-staff', storeId = 'night-security-store', userId = 'night-security-user';
  await db.campus.upsert({ where: { id: campusId }, update: {}, create: { id: campusId, name: '独立跨校区权限夹具', shortName: '权限夹具', warehouseName: '权限验收仓', nightEnabled: true, manualClosed: true, nightStartAt: '00:00', nightEndAt: '23:59', nightDeliveryFee: 0 } });
  await db.building.upsert({ where: { id: buildingId }, update: {}, create: { id: buildingId, campusId, name: '权限验收1栋' } });
  await db.staff.upsert({ where: { id: staffId }, update: { role: 'building-manager' }, create: { id: staffId, campusId, buildingId, building: '权限验收1栋', name: '权限验收楼长', staffNo: 'NIGHT-SECURITY-01', role: 'building-manager', roleText: '楼长', onTimeRate: 100, income: 0 } });
  await db.nightStore.upsert({ where: { id: storeId }, update: {}, create: { id: storeId, campusId, buildingId, managerStaffId: staffId, deposit: 50000, commissionRate: 2000 } });
  const category = await db.category.upsert({ where: { campusId_name: { campusId, name: '权限验收商品' } }, update: {}, create: { campusId, name: '权限验收商品' } });
  const warehouse = await db.product.upsert({ where: { id: 'night-security-warehouse' }, update: {}, create: { id: 'night-security-warehouse', campusId, categoryId: category.id, name: '验收茶饮', subtitle: '权限验收夹具', price: 500, originalPrice: 500, stock: 100, image: '', tag: '', weight: 0 } });
  const catalog = await db.product.upsert({ where: { id: 'night-security-catalog' }, update: {}, create: { id: 'night-security-catalog', campusId, categoryId: category.id, name: warehouse.name, subtitle: '', price: 500, originalPrice: 500, stock: 0, nightCatalog: true, warehouseProductId: warehouse.id, image: '', tag: '', weight: 0 } });
  if (!await db.nightProduct.count({ where: { storeId } })) {
    const request = await inventory.createStockOrder(staffId, { requestId: 'http-security-stock-v1', items: [{ catalogProductId: catalog.id, quantity: 5 }] });
    await inventory.reviewStockOrder('isolated-http-test', request.id, true, '初始化权限夹具');
    await inventory.shipStockOrder('isolated-http-test', request.id);
    await inventory.receiveStockOrder(staffId, request.id, [{ catalogProductId: catalog.id, quantity: 5 }]);
  }
  await db.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, campusId, nickname: '权限验收用户', phone: '13800009001' } });
  const address = await db.address.upsert({ where: { id: 'night-security-address' }, update: {}, create: { id: 'night-security-address', userId, campusId, campusName: '独立跨校区权限夹具', buildingId, buildingName: '权限验收1栋', floor: 1, room: '101', contactName: '验收用户', phone: '13800009001' } });
  await db.nightStore.update({ where: { id: storeId }, data: { status: 'open' } });
  const product = (await inventory.products(staffId))[0];
  const foreignOrder = await orders.submitOrder(userId, { requestId: 'http-security-order-v1', storeId, addressId: address.id, items: [{ productId: product.id, quantity: 1 }] });
  if (foreignOrder.status === 'pending-payment') await orders.applyNightOrderPaid(foreignOrder.orderNo, 'LOCAL_SECURITY_FIXTURE');
  const fresh = await db.nightOrder.findUniqueOrThrow({ where: { id: foreignOrder.id } });
  if (fresh.status === 'pending-accept') await orders.acceptOrder(staffId, storeId, fresh.id);
  if (['pending-accept', 'delivering'].includes(fresh.status)) await orders.deliverOrder(staffId, storeId, fresh.id, { images: ['http://localhost:3150/api/v1/uploads/isolated-http-proof.png'] });
  const settled = await orders.settleBatch(campusId);
  const batch = settled.txnCount ? settled.batch : (await orders.settlements(campusId))[0].batch;
  await db.rbacState.update({ where: { id: 'global' }, data: { version: { increment: 1 } } });
  const admin = await adminSession('night-security-campus-admin', ['night-stores', 'night-stores.write', 'night-deposit', 'night-orders', 'night-orders.refund', 'night-settlements', 'night-settlements.write']);
  const readOnly = await adminSession('night-security-read-admin', ['night-orders']);
  await db.rbacState.update({ where: { id: 'global' }, data: { version: { increment: 1 } } });
  const user = token('night-demo-customer-0', preview.campusId);
  const mainOrder = await db.nightOrder.findFirstOrThrow({ where: { storeId: preview.storeId, userId: 'night-demo-customer-0' }, orderBy: { createdAt: 'desc' } });
  const mainProduct = await db.nightProduct.findFirstOrThrow({ where: { storeId: preview.storeId, stock: { gt: 0 }, onShelf: true, saleAllowed: true, catalogProduct: { status: 'on-sale' } } });
  const mainAddress = await db.address.findFirstOrThrow({ where: { userId: 'night-demo-customer-0', buildingId: 'night-preview-building' } });
  const invalidOrder = { storeId: preview.storeId, addressId: mainAddress.id, items: [{ productId: mainProduct.id, quantity: 1 }] };
  await check('匿名请求被拒绝', '/night-rider/night/dashboard', null, 401);
  await check('用户不能进入楼长经营API', '/night-rider/night/dashboard', user, 403);
  await check('员工不能进入用户API', '/night/stores', preview.staffToken, 403);
  await check('员工不能进入后台API', '/admin/night/stores', preview.staffToken, 403);
  await check('跨用户订单详情拒绝', '/night/orders/' + foreignOrder.id, user, 404);
  await check('跨用户取消拒绝', '/night/orders/' + foreignOrder.id + '/cancel', user, 404, 'POST', { reason: '越权测试' });
  await check('跨校区用户货架拒绝', '/night/stores/' + storeId + '/products', user, 404);
  await check('跨校区下单拒绝', '/night/orders', user, 400, 'POST', { storeId, addressId: address.id, items: [{ productId: product.id, quantity: 1 }] });
  for (const quantity of [0, -1, 1.5, 1000]) await check(`非法购买数量${quantity}被拒绝`, '/night/orders', user, 400, 'POST', { ...invalidOrder, items: [{ productId: mainProduct.id, quantity }] });
  await check('篡改客户端确认价格拒绝', '/night/orders', user, 400, 'POST', { ...invalidOrder, expectedProductAmount: 1 });
  await check('跨用户地址下单拒绝', '/night/orders', user, 400, 'POST', { ...invalidOrder, addressId: address.id });
  const buyer = await db.user.findUniqueOrThrow({ where: { id: 'night-demo-customer-0' } });
  try {
    await db.user.update({ where: { id: buyer.id }, data: { phone: '' } });
    await check('手机号门控由服务端验证', '/night/orders', user, 400, 'POST', invalidOrder);
    await db.user.update({ where: { id: buyer.id }, data: { phone: buyer.phone, role: 'admin' } });
    await check('令牌身份不能覆盖已撤销用户资格', '/night/orders', user, 403, 'POST', invalidOrder);
  } finally { await db.user.update({ where: { id: buyer.id }, data: { phone: buyer.phone, role: buyer.role } }); }
  assert.equal((await db.nightProduct.findUniqueOrThrow({ where: { id: mainProduct.id } })).stock, mainProduct.stock, '拒绝下单不得扣库存');
  await check('楼长跨店查看拒绝', '/night-rider/night/orders/' + foreignOrder.id, preview.staffToken, 404);
  await check('楼长跨店接单拒绝', '/night-rider/night/orders/' + foreignOrder.id + '/accept', preview.staffToken, 403, 'POST', {});
  await check('校区管理员可查看本校区订单', '/admin/night/orders/' + mainOrder.id, admin, 200);
  await check('校区管理员跨校区店铺拒绝', '/admin/night/stores/' + storeId, admin, 403);
  await check('校区管理员跨校区订单拒绝', '/admin/night/orders/' + foreignOrder.id, admin, 403);
  await check('校区管理员跨校区退款拒绝', '/admin/night/orders/' + foreignOrder.id + '/refund', admin, 403, 'POST', { reason: '越权测试', restock: false, refundDeliveryFee: true });
  await check('校区管理员跨校区查退款拒绝', '/admin/night/orders/' + foreignOrder.id + '/refund/sync', admin, 403, 'POST', {});
  await check('校区管理员跨校区售后审核拒绝', '/admin/night/orders/' + foreignOrder.id + '/after-sale/reject', admin, 403, 'POST', { reason: '越权测试' });
  await check('校区管理员跨校区出账拒绝', '/admin/night/settlements/settle', admin, 403, 'POST', { storeIds: [storeId] });
  await check('校区管理员跨校区标记打款拒绝', '/admin/night/settlements/' + batch + '/pay', admin, 403, 'POST', { remark: '越权测试' });
  await check('只读运营不能退款', '/admin/night/orders/' + mainOrder.id + '/refund', readOnly, 403, 'POST', { reason: '越权测试' });
  await check('校区管理员跨校区退押历史拒绝', '/admin/night/stores/' + storeId + '/deposit-refunds', admin, 403);
  await check('校区管理员跨校区押金账本拒绝', '/admin/night/stores/' + storeId + '/deposit-txns', admin, 403);
  await check('校区管理员跨校区退押核对拒绝', '/admin/night/stores/' + storeId + '/deposit/refunds/foreign-request/sync', admin, 403, 'POST', {});
  await check('只读运营不能发起退押', '/admin/night/stores/' + preview.storeId + '/deposit/refund', readOnly, 403, 'POST', { requestId: 'readonly-request', amount: 1 });
  const forgedRole = token(staffId, campusId, 'building-manager', 'delivery');
  await db.staff.update({ where: { id: staffId }, data: { role: 'fulltime-rider' } });
  try { await check('令牌楼长角色不能覆盖数据库已撤销资格', '/night-rider/night/dashboard', forgedRole, 404); }
  finally { await db.staff.update({ where: { id: staffId }, data: { role: 'building-manager' } }); }
  const bad = new FormData(); bad.append('file', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'proof.svg');
  await check('脚本型SVG凭证拒绝', '/files/images', preview.staffToken, 400, 'POST', bad);
  const png = await require('sharp')({ create: { width: 32, height: 32, channels: 3, background: '#1b4530' } }).png().toBuffer();
  const proof = new FormData(); proof.append('file', new Blob([png], { type: 'image/png' }), 'local-proof.png');
  const uploaded = await check('有效凭证经过鉴权、压缩和本机存储', '/files/images', preview.staffToken, 201, 'POST', proof);
  assert.ok(uploaded.url.startsWith('http://localhost:3150/api/v1/uploads/night-preview/'));
  const privateFile = new FormData(); privateFile.append('file', new Blob([png], { type: 'image/png' }), 'local-proof.png');
  await check('员工不得写后台私有证件目录', '/files/images?folder=app/idcard', preview.staffToken, 403, 'POST', privateFile);
  fs.writeFileSync('/tmp/night-security-sessions.json', JSON.stringify({ admin, readOnly, user }), { mode: 0o600 });
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally { await db.$disconnect(); }
