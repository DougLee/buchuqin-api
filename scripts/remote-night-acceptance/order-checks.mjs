import assert from 'node:assert/strict';
import { call, state, save, q, items } from './http.mjs';
import { payOrder, externalConfirm } from './payment-helper.mjs';
const s = q(state.campusId), token = state.users.buyer.token, manager = state.manager.token, admin = state.adminSessions.operator.token;
const route = '/api/v1/night-rider/night/';
const passed = [...(state.orderChecksPassed || [])];
const test = async (name, fn) => { if (passed.includes(name)) return; await fn(); passed.push(name); state.orderChecksPassed = passed; save(); console.log('PASS ' + name); };
const products = () => call(route + 'products', 'GET', undefined, manager);
const product = async () => (await products()).find(row => row.catalogProductId === state.catalog[0].id);
const quota = async () => (await call(route + 'dashboard', 'GET', undefined, manager)).usedQuota;
const create = async (tag, overrides = {}) => call('/api/v1/night/orders', 'POST', { requestId: 'remote-order-' + tag + '-20261107', storeId: state.storeId, addressId: state.buyerAddressId, items: [{ productId: (await product()).id, quantity: 1 }], remark: '验收' + tag, ...overrides }, token);
await test('unpaid duplicate submission is one order; cancel returns stock and quota', async () => {
  const before = await product(), held = await quota(); const order = await create('unpaid'); const duplicate = await create('unpaid'); assert.equal(order.id, duplicate.id);
  assert.equal((await product()).stock, before.stock - 1); assert.equal(await quota(), held);
  await call('/api/v1/night/orders/' + order.id + '/cancel', 'POST', { reason: '验收未付款取消' }, token);
  assert.equal((await product()).stock, before.stock); assert.equal(await quota(), held);
});
await test('foreign building address is rejected', async () => {
  const address = await call('/api/v1/addresses', 'POST', { buildingName: '验收10栋', floor: 2, room: '202', contactName: '跨楼栋验收', phone: state.users.buyer.testPhone }, token);
  await call('/api/v1/night/orders', 'POST', { storeId: state.storeId, addressId: address.id, items: [{ productId: (await product()).id, quantity: 1 }] }, token, 400);
});
await test('paid user cancellation refunds, returns inventory and cancels commission', async () => {
  const before = await product(), held = await quota(); const order = await create('paid-cancel'); await payOrder(order); externalConfirm('user', order.id, state.users.buyer.user.id);
  const cancelled = await call('/api/v1/night/orders/' + order.id + '/cancel', 'POST', { reason: '验收已付款未接单取消' }, token);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.refund.status, 'succeeded');
  assert.equal((await product()).stock, before.stock); assert.equal(await quota(), held);
});
await test('paid undelivered no-restock refund creates held loss, releases only on approval', async () => {
  const before = await product(), held = await quota();
  const old = items(await call('/api/v1/night/orders', 'GET', undefined, token)).find(row => row.remark === '验收no-restock');
  const order = old || await create('no-restock');
  if (old?.status === 'refunded') before.stock += 1;
  else {
    await payOrder(order);
    await call('/api/v1/admin/night/orders/' + order.id + '/refund' + s, 'POST', { restock: false, refundDeliveryFee: true, reason: '验收未履约报损退款' }, admin);
  }
  const result = await call('/api/v1/night/orders/' + order.id, 'GET', undefined, token);
  assert.equal(result.status, 'refunded'); assert.equal(result.refund.status, 'succeeded'); assert.equal((await product()).stock, before.stock - 1); assert.equal(await quota(), held);
  const reports = items(await call('/api/v1/admin/night/inventory-reports' + s));
  const report = reports.find(row => row.requestId === 'refund-' + order.id);
  assert.ok(report); assert.equal(report.status, 'pending');
  await call('/api/v1/admin/night/inventory-reports/' + report.id + '/review' + s, 'POST', { approved: true, reason: '核实损耗' }, admin);
  assert.equal(await quota(), held - 800);
});
await test('completed order after-sale partial refund adjusts income without creating new loss', async () => {
  const before = await product(); const order = await create('completed-partial'); await payOrder(order);
  const paid = await call('/api/v1/night/orders/' + order.id, 'GET', undefined, token);
  if (process.env.EXPECT_FIXED_ACCEPT_DEADLINE === 'true') assert.equal(new Date(paid.timeoutAt).getTime() - new Date(paid.paidAt).getTime(), 60 * 60_000);
  await call(route + 'orders/' + order.id + '/accept', 'POST', undefined, manager);
  await call('/api/v1/night/orders/' + order.id + '/cancel', 'POST', { reason: '接单后取消应拒绝' }, token, 400);
  await call(route + 'orders/' + order.id + '/deliver', 'POST', { images: [] }, manager, 400);
  await call(route + 'orders/' + order.id + '/deliver', 'POST', { images: [state.uploadUrl], remark: '验收API送达' }, manager);
  const held = await quota(), reportsBefore = items(await call('/api/v1/admin/night/inventory-reports' + s)).length;
  await call('/api/v1/night/orders/' + order.id + '/after-sale', 'POST', { type: 'quality', description: '验收部分商品退款流程' }, token);
  await call('/api/v1/admin/night/orders/' + order.id + '/refund' + s, 'POST', { productRefund: 200, restock: false, refundDeliveryFee: false, reason: '验收部分退款' }, admin);
  const result = await call('/api/v1/night/orders/' + order.id, 'GET', undefined, token);
  assert.equal(result.refund.amount, 200); assert.equal(result.refund.status, 'succeeded'); assert.equal(await quota(), held);
  assert.equal(items(await call('/api/v1/admin/night/inventory-reports' + s)).length, reportsBefore);
  assert.equal((await product()).stock, before.stock - 1); state.partialRefundOrderId = order.id; save();
});
state.orderChecksPassed = passed; save(); console.log(JSON.stringify({ passed: passed.length, cases: passed }, null, 2));
