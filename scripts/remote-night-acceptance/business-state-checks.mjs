import assert from 'node:assert/strict';
import { call, state, save, q, items } from './http.mjs';
import { payOrder } from './payment-helper.mjs';
const s = q(state.campusId), manager = state.manager.token, user = state.users.buyer.token;
const r = '/api/v1/night-rider/night/';
const passed = [...(state.businessStateChecksPassed || [])];
const test = async (name, fn) => { if (passed.includes(name)) return; await fn(); passed.push(name); state.businessStateChecksPassed = passed; save(); console.log('PASS ' + name); };
const goods = () => call(r + 'products', 'GET', undefined, manager);
const product = async () => (await goods()).find(row => row.catalogProductId === state.catalog[0].id);
const userGoods = () => call('/api/v1/night/stores/' + state.storeId + '/products', 'GET', undefined, user);
const invalidBuy = async () => call('/api/v1/night/orders', 'POST', { storeId: state.storeId, addressId: state.buyerAddressId, items: [{ productId: (await product()).id, quantity: 1 }] }, user, 400);
const nightConfig = (from, to) => call('/api/v1/admin/night/config' + s, 'PUT', { nightEnabled: true, nightStartAt: from, nightEndAt: to, nightPayTimeout: 15, nightAcceptTimeout: 60, nightDeliveryFee: 200, confirm: true });
const dayConfig = manualClosed => call('/api/v1/admin/delivery-config' + s, 'PATCH', { deliveryFeeInstant: 200, deliveryFeeScheduled: 100, deliveryThreshold: 0, manualClosed, closeStart: '00:00', closeEnd: '00:00' });
await test('admin sale ban and manager shelf state independently control user visibility', async () => {
  const row = await product(), update = '/api/v1/admin/night/stores/' + state.storeId + '/products/' + row.id + s;
  await call(update, 'PATCH', { saleAllowed: false }, state.adminSessions.operator.token);
  assert.ok(!(await userGoods()).some(item => item.id === row.id));
  await call(r + 'products/' + row.id + '/shelf', 'PATCH', { onShelf: true }, manager, 400);
  await call(update, 'PATCH', { saleAllowed: true }, state.adminSessions.operator.token);
  await call(r + 'products/' + row.id + '/shelf', 'PATCH', { onShelf: false }, manager); assert.ok(!(await userGoods()).some(item => item.id === row.id));
  await call(r + 'products/' + row.id + '/shelf', 'PATCH', { onShelf: true }, manager); assert.ok((await userGoods()).some(item => item.id === row.id));
});
await test('pause, platform suspension and out-of-window block new purchases and cannot be bypassed', async () => {
  await call(r + 'store/pause', 'POST', undefined, manager); await invalidBuy(); await call(r + 'store/resume', 'POST', undefined, manager);
  await call('/api/v1/admin/night/stores/' + state.storeId + s, 'PATCH', { status: 'suspended' }); await call(r + 'store/open', 'POST', undefined, manager, 400); await invalidBuy();
  await call('/api/v1/admin/night/stores/' + state.storeId + s, 'PATCH', { status: 'closed' }); await call(r + 'store/open', 'POST', undefined, manager);
  try { await nightConfig('11:00', '11:01'); await invalidBuy(); await call(r + 'store/open', 'POST', undefined, manager, 400); }
  finally { await nightConfig('03:00', '09:00'); }
});
await test('night reservation blocks day checkout; day unpaid cancellation preserves warehouse', async () => {
  const row = state.catalog[0], inventory = () => call('/api/v1/admin/inventory' + s).then(items).then(rows => rows.find(item => item.id === row.warehouseProductId));
  const before = await inventory();
  try {
    await dayConfig(false); await invalidBuy();
    await call('/api/v1/cart', 'PUT', { items: [{ productId: row.warehouseProductId, quantity: 1 }] }, user);
    const order = await call('/api/v1/orders', 'POST', { addressId: state.buyerAddressId, deliveryMode: 'instant', remark: '日夜共仓锁库存验收20261107' }, user);
    state.dayOrderId = order.id; save(); assert.equal((await inventory()).stock, before.stock);
    const stock = await call(r + 'stock/orders', 'POST', { requestId: 'day-night-shared-reservation-20261107', items: [{ catalogProductId: row.id, quantity: before.stock }] }, manager);
    await call('/api/v1/admin/night/stock-orders/' + stock.id + '/review' + s, 'POST', { approved: true, reason: '验收共享仓库预留' }, state.adminSessions.operator.token);
    assert.equal((await inventory()).nightReservedStock, before.stock);
    await call('/api/v1/orders', 'POST', { addressId: state.buyerAddressId, deliveryMode: 'instant', remark: '夜宵预留后白天应拦截' }, user, 400);
    await call('/api/v1/admin/night/stock-orders/' + stock.id + '/cancel' + s, 'POST', { reason: '共仓验收结束' }, state.adminSessions.operator.token);
    await call('/api/v1/orders/' + order.id + '/cancel', 'POST', { reason: '验收白天订单取消' }, user);
    const after = await inventory(); assert.equal(after.stock, before.stock); assert.equal(after.lockedStock, before.lockedStock);
  } finally { await dayConfig(true); }
});
await test('staff role downgrade is enforced immediately despite old manager JWT', async () => {
  try {
    await call('/api/v1/admin/staff/' + state.mainStaffId + s, 'PATCH', { role: 'fulltime-rider' });
    const context = await call('/api/v1/fulfillment/business-context', 'GET', undefined, manager); assert.equal(context.canSwitchWorkspace, false);
    await call(r + 'dashboard', 'GET', undefined, manager, 404);
  } finally { await call('/api/v1/admin/staff/' + state.mainStaffId + s, 'PATCH', { role: 'building-manager', buildingId: state.buildingId }); }
});
await test('deployed API uses 60 minute acceptance deadline after confirmed payment', async () => {
  const order = await call('/api/v1/night/orders', 'POST', { requestId: 'deadline-fixed-server-20261107', storeId: state.storeId, addressId: state.buyerAddressId, items: [{ productId: (await product()).id, quantity: 1 }], remark: '接单期限修复部署验收' }, user);
  await payOrder(order); const paid = await call('/api/v1/night/orders/' + order.id, 'GET', undefined, user);
  assert.equal(new Date(paid.timeoutAt).getTime() - new Date(paid.paidAt).getTime(), 60 * 60_000);
  state.fixedDeadlineOrderId = order.id; save();
  await call('/api/v1/night/orders/' + order.id + '/cancel', 'POST', { reason: '时限验收结束' }, user);
});
console.log(JSON.stringify({ passed: passed.length, cases: passed }, null, 2));
